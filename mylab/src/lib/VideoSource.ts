/*
  VideoSource: Optional WebCodecs + MP4Box-powered video frame provider.
  - If MP4Box (window.MP4Box) + VideoDecoder are available, uses them for accurate frame count.
  - Otherwise, falls back to HTMLVideoElement seeking with approximate fps.
  Note: This class focuses on a clean interface so the UI can keep its
  existing caching, prefetch, and draw loop unchanged.
*/

export type VideoMeta = {
  width: number;
  height: number;
  fps: number;
  count: number;
};

type DemuxSample = {
  off: number; // file offset
  size: number; // bytes
  dts: number;
  pts: number;
  key: boolean;
};

declare global {
  interface Window {
    MP4Box?: any;
  }
}

export default class VideoSource {
  private file: File;
  private url: string | null = null;
  private meta: VideoMeta | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private offscreen: OffscreenCanvas | null = null;
  private ctx2d: OffscreenCanvasRenderingContext2D | null = null;

  // WebCodecs + MP4Box
  private useCodecs = false;
  private trackId: number | null = null;
  private timescale = 1;
  private samples: DemuxSample[] = [];
  private presentOrderIdxs: number[] = [];
  private decoder: VideoDecoder | null = null;
  private config: VideoDecoderConfig | null = null;
  private frameCache = new Map<number, ImageBitmap>();
  private mp4: any | null = null;
  private mp4Ready = false;
  private fileSize = 0;
  private chunkSize = 1024 * 1024; // 1MB chunks

  constructor(file: File) {
    this.file = file;
  }

  async init(): Promise<VideoMeta> {
    // Strict requirement: MP4Box and WebCodecs must be available for video processing
    const hasMP4 = typeof window !== 'undefined' && !!window.MP4Box;
    const hasWC = typeof window !== 'undefined' && 'VideoDecoder' in window;
    if (!hasMP4 || !hasWC) {
      throw new Error('Video processing requires MP4Box and WebCodecs support.');
    }
    this.fileSize = this.file.size;
    const meta = await this.initWithMP4BoxStreaming();
    this.useCodecs = true;
    this.meta = meta;
    return meta;
  }

  getMeta(): VideoMeta | null { return this.meta; }

  async getBitmap(index: number, targetW: number, targetH: number): Promise<ImageBitmap | null> {
    if (!this.meta) return null;
    if (index < 0 || index >= this.meta.count) return null;

    if (!this.useCodecs || !this.mp4Ready) {
      throw new Error('VideoSource not ready or WebCodecs/MP4Box unavailable.');
    }
    const bmp = await this.decodeAtIndexStreaming(index, targetW, targetH);
    return bmp;
  }

  dispose() {
    try { if (this.url) URL.revokeObjectURL(this.url); } catch {}
    this.url = null;
    try { this.decoder?.close(); } catch {}
    this.decoder = null;
    this.frameCache.forEach((bmp) => { try { bmp.close?.(); } catch {} });
    this.frameCache.clear();
  }

  // ====== MP4Box + WebCodecs ======
  private async initWithMP4BoxStreaming(): Promise<VideoMeta> {
    const MP4Box = window.MP4Box;
    this.mp4 = MP4Box.createFile();
    const file = this.mp4;
    let metaResolve!: (v: VideoMeta) => void;
    let metaReject!: (e: any) => void;
    const metaP = new Promise<VideoMeta>((resolve, reject) => { metaResolve = resolve; metaReject = reject; });

    file.onReady = (info: any) => {
      const vtrack = info.videoTracks?.[0];
      if (!vtrack) { metaReject(new Error('No video track')); return; }
      this.trackId = vtrack.id;
      this.timescale = vtrack.movie_timescale || vtrack.timescale || 1;
      const width = vtrack.video?.width || vtrack.track_width || 0;
      const height = vtrack.video?.height || vtrack.track_height || 0;

      // Extract sample index table for precise mapping
      let idx: any[] = [];
      try { idx = (this.mp4 as any).getTrackSamplesInfo(vtrack.id) || []; } catch {}
      if (!idx.length) { metaReject(new Error('Empty sample index')); return; }
      this.samples = idx.map((s) => ({
        off: s.offset,
        size: s.size,
        dts: s.dts,
        pts: s.dts + (s.cts || 0),
        key: !!s.is_sync,
      }));
      // Present-order to decode-order mapping
      this.presentOrderIdxs = this.samples.map((_, i) => i).sort((a, b) => {
        const pa = this.samples[a].pts, pb = this.samples[b].pts;
        if (pa === pb) return a - b;
        return pa - pb;
      });

      // Prepare decoder config with avcC/hvcC description
      try {
        const trak = (this.mp4 as any).getTrackById(vtrack.id);
        const stsd = trak?.mdia?.minf?.stbl?.stsd;
        const entry = stsd?.entries?.[0];
        let description: Uint8Array | undefined;
        const DS = (window as any).DataStream || (window as any).MP4Box?.DataStream;
        if (entry?.avcC && DS) {
          const ds = new DS();
          entry.avcC.write(ds);
          description = new Uint8Array(ds.buffer).subarray(8);
        } else if (entry?.hvcC && DS) {
          const ds = new DS();
          entry.hvcC.write(ds);
          description = new Uint8Array(ds.buffer).subarray(8);
        }
        const codec = vtrack?.codec || vtrack?.sample_descriptions?.[0]?.sd?.type;
        const cfg: any = { codec, hardwareAcceleration: 'prefer-hardware' };
        if (description) cfg.description = description;
        this.config = cfg as VideoDecoderConfig;
      } catch {}

      const fps = this.samples.length && vtrack.duration
        ? (this.samples.length / (vtrack.duration / vtrack.timescale))
        : (vtrack.avgFrameRate || 30);
      const count = this.samples.length;
      this.mp4Ready = true;
      metaResolve({ width, height, fps: Math.max(1, Math.round(fps)), count });
    };
    file.onError = (e: any) => metaReject(e);

    // Stream until moov is parsed (onReady)
    let offset = 0;
    while (!this.mp4Ready && offset < this.fileSize) {
      const end = Math.min(this.fileSize, offset + this.chunkSize);
      const buf = await this.readSlice(offset, end - offset);
      // @ts-ignore
      (buf as any).fileStart = offset;
      file.appendBuffer(buf);
      offset = end;
      // Yield to UI
      await new Promise(r => setTimeout(r));
    }
    if (!this.mp4Ready) throw new Error('mp4 onReady not reached');
    return metaP;
  }

  private async decodeFrameViaWebCodecs(index: number, targetW: number, targetH: number): Promise<ImageBitmap | null> {
    if (!this.meta || this.trackId == null) return null;
    if (!this.decoder) {
      const output: VideoFrame[] = [];
      this.decoder = new VideoDecoder({
        output: (frame: VideoFrame) => { output.push(frame); },
        error: () => {}
      });
      const cfg: VideoDecoderConfig = this.config || { codec: 'avc1.42E01E' } as any;
      try { this.decoder.configure(cfg); } catch { /* ignore */ }
    }
    if (!this.offscreen) this.offscreen = new OffscreenCanvas(Math.max(1, targetW), Math.max(1, targetH));
    if (!this.ctx2d) this.ctx2d = this.offscreen.getContext('2d');
    const sample = this.samples[index];
    if (!sample) return null;

    // Feed the single sample; depends on decoder supporting random access
    try {
      const chunk = new EncodedVideoChunk({
        type: sample.is_sync ? 'key' : 'delta',
        timestamp: sample.cts,
        duration: sample.duration,
        data: sample.data,
      });
      this.decoder!.decode(chunk);
    } catch {
      return null;
    }
    await this.decoder!.flush().catch(() => {});

    // Draw last frame in decoder queue
    const frame = await (async () => {
      // @ts-ignore: access internal decoded frames via flush output queue handled above
      const vf: VideoFrame | undefined = (this.decoder as any)?.[["[[queue]]"]]?.at?.(-1);
      return vf as VideoFrame | undefined;
    })();
    // Fallback: no direct queue access, recreate by decode->output capture
    let bmp: ImageBitmap | null = null;
    try {
      if (frame) {
        bmp = await createImageBitmap(frame);
        frame.close();
      } else if (this.ctx2d) {
        // draw via drawImage path (less optimal)
      }
    } catch {
      bmp = null;
    }
    if (bmp) this.frameCache.set(index, bmp);
    return bmp;
  }

  // ====== HTMLVideoElement fallback ======
  // HTMLVideoElement fallback removed per project requirement (enforce MP4Box+WebCodecs)

  private async readSlice(offset: number, length: number): Promise<ArrayBuffer> {
    const blob = this.file.slice(offset, offset + length);
    return await blob.arrayBuffer();
  }

  private async decodeAtIndexStreaming(index: number, targetW: number, targetH: number): Promise<ImageBitmap | null> {
    if (!this.meta || !this.mp4 || this.trackId == null || this.samples.length === 0) return null;
    const cached = this.frameCache.get(index);
    if (cached) return cached;

    // Use a fresh decoder per request to capture output reliably
    const outFrames: VideoFrame[] = [];
    const decoder = new VideoDecoder({ output: (f: VideoFrame) => outFrames.push(f), error: () => {} });
    const cfg: VideoDecoderConfig = this.config || { codec: 'avc1.42E01E' } as any;
    try { decoder.configure(cfg); } catch { /* ignore */ }

    const total = this.samples.length;
    let pIdx = index | 0;
    if (pIdx < 0) pIdx = 0;
    if (pIdx >= total) pIdx = total - 1;
    const decodeIdx = this.presentOrderIdxs[pIdx] ?? pIdx;
    let startIdx = decodeIdx;
    for (let i = decodeIdx; i >= 0; --i) { if (this.samples[i].key) { startIdx = i; break; } }

    const startByte = this.samples[startIdx].off;
    const endByte = this.samples[decodeIdx].off + this.samples[decodeIdx].size - 1;
    const ab = await this.readSlice(startByte, endByte - startByte + 1);
    const base = startByte;
    const u8 = new Uint8Array(ab);

    for (let i = startIdx; i <= decodeIdx; i++) {
      const s = this.samples[i];
      const off = s.off - base;
      const view = u8.subarray(off, off + s.size);
      try {
        const chunk = new EncodedVideoChunk({
          type: s.key ? 'key' : 'delta',
          timestamp: Math.round((1e6 * s.pts) / this.timescale),
          data: view,
        });
        decoder.decode(chunk);
      } catch { /* ignore */ }
    }
    try { await decoder.flush(); } catch {}
    let bmp: ImageBitmap | null = null;
    const vf = outFrames.pop();
    if (vf) {
      try { bmp = await createImageBitmap(vf, { resizeWidth: targetW, resizeHeight: targetH } as any); } catch {}
      try { vf.close(); } catch {}
    }
    try { decoder.close(); } catch {}
    if (bmp) this.frameCache.set(index, bmp);
    return bmp;
  }

  private async decodeAndCaptureSingle(sample: DemuxSample, targetW: number, targetH: number): Promise<ImageBitmap | null> {
    let bmp: ImageBitmap | null = null;
    const frames: VideoFrame[] = [];
    try {
      const decoder = new VideoDecoder({
        output: (f: VideoFrame) => frames.push(f),
        error: () => {}
      });
      const cfg: VideoDecoderConfig = this.config || { codec: 'avc1.42E01E' } as any;
      try { decoder.configure(cfg); } catch {}
      // Use last decoded frame from the main decoder flush via frames[]
      const vf = frames.pop();
      if (vf) {
        bmp = await createImageBitmap(vf, { resizeWidth: targetW, resizeHeight: targetH } as any);
        vf.close();
      }
      try { decoder.close(); } catch {}
    } catch {
      bmp = null;
    }
    return bmp;
  }
  private async getDurationSecondsSafe(): Promise<number | null> {
    try {
      if (this.videoEl) return this.videoEl.duration || null;
      const tmpUrl = this.url || URL.createObjectURL(this.file);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.src = tmpUrl;
      await new Promise<void>((resolve, reject) => {
        v.onloadedmetadata = () => resolve();
        v.onerror = () => reject(new Error('video metadata error'));
      });
      const d = v.duration || null;
      if (!this.url) { try { URL.revokeObjectURL(tmpUrl); } catch {} }
      return d;
    } catch {
      return null;
    }
  }

  private async captureViaVideoEl(index: number, targetW: number, targetH: number): Promise<ImageBitmap | null> {
    if (!this.videoEl || !this.meta) return null;
    const v = this.videoEl;
    const time = index / this.meta.fps;
    // Ensure canvas size
    if (!this.offscreen) this.offscreen = new OffscreenCanvas(Math.max(1, targetW), Math.max(1, targetH));
    if (!this.ctx2d) this.ctx2d = this.offscreen.getContext('2d');
    const ctx = this.ctx2d!;
    if ((this.offscreen!.width !== Math.max(1, targetW)) || (this.offscreen!.height !== Math.max(1, targetH))) {
      this.offscreen!.width = Math.max(1, targetW);
      this.offscreen!.height = Math.max(1, targetH);
    }
    // Seek and wait for paint
    v.currentTime = Math.max(0, Math.min(v.duration || time, time));
    await new Promise<void>((resolve) => {
      const onUpdate = () => { v.removeEventListener('seeked', onUpdate); resolve(); };
      v.addEventListener('seeked', onUpdate, { once: true });
    });
    ctx.drawImage(v, 0, 0, this.offscreen!.width, this.offscreen!.height);
    try {
      const bmp = await createImageBitmap(this.offscreen!);
      return bmp;
    } catch {
      return null;
    }
  }

  private async fileToArrayBuffer(file: File): Promise<ArrayBuffer & { fileStart?: number }> {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as ArrayBuffer);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(file);
    });
  }
}
