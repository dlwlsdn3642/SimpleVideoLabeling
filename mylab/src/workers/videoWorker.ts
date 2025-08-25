
import { createFile as mp4boxCreateFile, DataStream } from 'mp4box';

self.addEventListener("error", (e) => {
  try { (self as any).postMessage({ type: "fatal", error: String(e.message || e) }); } catch {}
});
self.addEventListener("unhandledrejection", (e: any) => {
  try { (self as any).postMessage({ type: "fatal", error: String(e?.reason?.message || e?.reason || e) }); } catch {}
});

(async () => {
  (self as any).postMessage({ type: 'hello' });
})();

let mp4: any = null;
let samples: { off: number; size: number; dts: number; pts: number; key: boolean }[] = [];
let timescale = 0;
let presentOrderIdxs: number[] = [];
// Inverse mapping: decodeIdx -> presentIdx (for O(1) lookup)
let presentFromDecodeIdx: number[] = [];
let decoder: VideoDecoder | null = null;
let lastDecoderConfig: VideoDecoderConfig | null = null;
let isReady = false;
let fileSize = 0;
let chunkSize = 1024 * 1024;

// Cache the last requested byte range to optimize scrubbing
let lastRange = { start: -1, end: -1, buf: null as ArrayBuffer | null };

// Concurrency control from the working example
let jobId = 0;
let currentJob = 0;

// High-speed scrubbing state
const SCRUB_WINDOW_MS = 250;
let lastSeekWall = 0;
// Preview scale hint: downscale during fast scrubs for smoother UI, upgrade when stable
let previewScale = 1;
// Limit concurrent createImageBitmap calls
let inFlightBitmaps = 0;
const MAX_INFLIGHT_BITMAPS = 2;
let lastPostedPresentIdx = -1;
let lastPostedIsPreview = false;
let playing = false;
let playJobId = 0;
let playStartWall = 0;
let playStartPresentIdx = 0;
function isKeyRequiredError(e: any): boolean {
  const msg = String(e?.message || e || "").toLowerCase();
  return msg.includes('key frame is required');
}

function tsUs(val: number) {
  return Math.round((1e6 * val) / (timescale || 1));
}

function findPrevKey(idx: number) {
  for (let i = idx; i >= 0; --i) if (samples[i].key) return i;
  return 0;
}

function cancelAndBumpJob() {
  jobId++;
}

function idxFromTsUs(tsUs: number) {
    if (!samples.length || !timescale) return 0;
    const target = Math.round((tsUs * timescale) / 1e6);
    let lo = 0, hi = samples.length - 1, ans = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].pts <= target) { ans = mid; lo = mid + 1; }
        else { hi = mid - 1; }
    }
    const a = ans;
    const b = Math.min(ans + 1, samples.length - 1);
    const da = Math.abs(samples[a].pts - target);
    const db = Math.abs(samples[b].pts - target);
    const decodeIdx = db < da ? b : a;
    return presentFromDecodeIdx[decodeIdx] ?? 0;
}

function onFrame(frame: VideoFrame) {
  // During fast scrubs, accept preview frames even if a precise job was started meanwhile
  const recent = Date.now() - lastSeekWall < SCRUB_WINDOW_MS;
  const cj = currentJob;
  if (cj !== jobId && !recent) {
    frame.close();
    return;
  }
  const pIdx = idxFromTsUs(frame.timestamp);
  // Drop-policy during play: if decoder output is far behind the expected timeline frame, drop it
  if (playing && playStartWall > 0) {
    // Estimate expected timeline index from play start
    // Note: period is recomputed in play() and we pace feeding, but decoder may still burst outputs.
    // We derive expected using lastPostedPresentIdx as a proxy timeline head when available.
    const expectedHead = Math.max(playStartPresentIdx, lastPostedPresentIdx);
    const expectedIdx = expectedHead; // conservative: already paced feed uses period, so use head
    if (pIdx < expectedIdx - 1) {
      frame.close();
      return;
    }
  }
  // Drop duplicates only if same index and same preview/full-res state
  if (pIdx === lastPostedPresentIdx) {
    const isPrev = previewScale < 1;
    if (isPrev === lastPostedIsPreview) {
      frame.close();
      return;
    }
  }
  if (inFlightBitmaps >= MAX_INFLIGHT_BITMAPS) {
    frame.close();
    return;
  }
  inFlightBitmaps++;
  const rw = Math.max(1, Math.floor((frame.displayWidth || frame.codedWidth) * previewScale));
  const rh = Math.max(1, Math.floor((frame.displayHeight || frame.codedHeight) * previewScale));
  const opts: any = previewScale < 1 ? { resizeWidth: rw, resizeHeight: rh, resizeQuality: 'low' } : undefined;
  createImageBitmap(frame as any, opts as any)
    .then((bmp) => {
      lastPostedPresentIdx = pIdx;
      lastPostedIsPreview = previewScale < 1;
      (self as any).postMessage({ type: "frame", bitmap: bmp, frameIdx: pIdx }, [bmp]);
    })
    .catch(() => {})
    .finally(() => {
      inFlightBitmaps = Math.max(0, inFlightBitmaps - 1);
      frame.close();
    });
}

function setupMP4() {
  mp4 = mp4boxCreateFile();
  mp4.onError = (e: any) => (self as any).postMessage({ type: 'log', msg: 'mp4box error ' + String(e?.message || e) });
  mp4.onReady = async (info: any) => {
    const v = info.videoTracks?.[0];
    if (!v) {
      (self as any).postMessage({ type: "fatal", error: "no video track" });
      return;
    }

    const idx = mp4.getTrackSamplesInfo(v.id);
    if (!idx || !idx.length) {
      (self as any).postMessage({ type: "fatal", error: "empty sample index" });
      return;
    }

    let description: Uint8Array | undefined = undefined;
    try {
      const trak = mp4.getTrackById(v.id);
      const stsd = trak?.mdia?.minf?.stbl?.stsd;
      const entry = stsd?.entries?.[0];
      if (entry?.avcC) {
        const ds = new DataStream();
        entry.avcC.write(ds);
        description = new Uint8Array(ds.buffer).subarray(8);
      } else if (entry?.hvcC) {
        const ds = new DataStream();
        entry.hvcC.write(ds);
        description = new Uint8Array(ds.buffer).subarray(8);
      } else if (v.codecDescription) {
        description = new Uint8Array(v.codecDescription);
      }
    } catch (e: any) {
        (self as any).postMessage({ type: "log", msg: `description extract failed: ${e?.message || e}` });
    }
    
    const codec = v.codec;
    const isAvcOrHevc = codec.startsWith('avc') || codec.startsWith('hev');
    if (isAvcOrHevc && !description) {
        (self as any).postMessage({ type: "fatal", error: `AVC/HEVC codec detected, but no description found.` });
        return;
    }

    timescale = v.timescale;
    samples = idx.map((s: any) => ({
      off: s.offset,
      size: s.size,
      dts: s.dts,
      pts: s.dts + (s.cts || 0),
      key: !!s.is_sync,
    }));
    presentOrderIdxs = samples.map((_, i: number) => i).sort((a: number, b: number) => {
      const pa = samples[a].pts, pb = samples[b].pts;
      if (pa === pb) return a - b;
      return pa - pb;
    });
    // Build inverse mapping for O(1) decode->present lookup
    presentFromDecodeIdx = new Array(samples.length);
    for (let p = 0; p < presentOrderIdxs.length; p++) {
      presentFromDecodeIdx[presentOrderIdxs[p]] = p;
    }

    decoder = new VideoDecoder({
      output: onFrame,
      error: (e) => (self as any).postMessage({ type: "fatal", error: String(e.message || e) }),
    });

    const cfg: VideoDecoderConfig = { codec: v.codec, hardwareAcceleration: "prefer-hardware" };
    if (description) cfg.description = description;
    
    try {
      const support = await VideoDecoder.isConfigSupported(cfg);
      if (!support || !support.supported) {
        (self as any).postMessage({ type: "fatal", error: `codec not supported: ${v.codec}` });
        return;
      }
      const used = support.config || cfg;
      decoder.configure(used);
      lastDecoderConfig = used;
    } catch (e: any) {
      (self as any).postMessage({ type: "fatal", error: `configure failed: ${e?.message || e}` });
      return;
    }

    isReady = true;
    mp4.flush();

    (self as any).postMessage({
      type: "ready",
      width: v.track_width,
      height: v.track_height,
      durationMs: Math.round((1000 * v.duration) / timescale),
      frames: samples.length,
      fps: Math.round(samples.length / (v.duration / timescale)),
    });
  };
}

function requestSpan(startByte: number, endByteIncl: number): Promise<ArrayBuffer> {
  // Avoid caching huge ranges to keep memory stable
  const spanSize = (endByteIncl - startByte + 1) >>> 0;
  const allowCache = spanSize <= 4 * 1024 * 1024;
  if (allowCache && lastRange.start === startByte && lastRange.end === endByteIncl && lastRange.buf) {
    return Promise.resolve(lastRange.buf);
  }
  return new Promise((resolve) => {
    const onBytes = (ev: MessageEvent) => {
      const m: any = ev.data;
      if (m && m.type === 'bytes' && m.start === startByte && m.end === endByteIncl && m.buf) {
        self.removeEventListener('message', onBytes);
        if (allowCache) {
          lastRange = { start: m.start, end: m.end, buf: m.buf };
        }
        resolve(m.buf as ArrayBuffer);
      }
    };
    self.addEventListener('message', onBytes);
    (self as any).postMessage({ type: 'need', start: startByte, end: endByteIncl });
  });
}

self.onmessage = async (ev: MessageEvent) => {
  const m: any = ev.data;
  if (!m) return;

  if (m.type === "init") {
    fileSize = m.fileSize | 0;
    chunkSize = Math.max(256 * 1024, m.initBytes | 0) || 1024 * 1024;
    setupMP4();
    // Request initial chunk for moov parsing
    (self as any).postMessage({ type: 'need', start: 0, end: chunkSize - 1 });
    return;
  }

  if (m.type === "bytes") {
    if (!isReady && mp4) {
      const { buf, start } = m;
      (buf as any).fileStart = start;
      const next = mp4.appendBuffer(buf);
      if (!isReady) {
        // Keep requesting chunks until onReady is fired
        const nextOffset = typeof next === 'number' ? next : start + buf.byteLength;
        if (nextOffset < fileSize) {
          (self as any).postMessage({ type: 'need', start: nextOffset, end: nextOffset + chunkSize - 1 });
        }
      }
    }
    // Other bytes are handled by requestSpan's logic
    return;
  }

  if (m.type === "seekFrame") {
    playing = false; // any seek cancels play mode
    if (!decoder || samples.length === 0 || (decoder.state !== 'configured' && decoder.state !== 'closed')) return;

    const now = Date.now();
    const forcePrecise = !!m.exact;
    const recent = forcePrecise ? false : (now - lastSeekWall < SCRUB_WINDOW_MS);
    lastSeekWall = now;
    previewScale = recent ? 0.5 : 1;

    // Start a new job for every seek to cancel previous outputs
    cancelAndBumpJob();
    currentJob = jobId;

    // If decode queue is building up, reset decoder to drop stale frames
    try {
      if (decoder.decodeQueueSize > 3 || decoder.state === 'closed') {
        decoder.reset();
        if (lastDecoderConfig) decoder.configure(lastDecoderConfig);
      }
    } catch {}

    const total = samples.length;
    let pIdx = m.index | 0;
    if (pIdx < 0) pIdx = 0;
    if (pIdx >= total) pIdx = total - 1;

    const targetDecodeIdx = presentOrderIdxs[pIdx];
    const startIdx = findPrevKey(targetDecodeIdx);

    if (recent) {
      // Scrubbing preview: decode only the keyframe
      const k = startIdx;
      const startByte = samples[k].off;
      const endByte = samples[k].off + samples[k].size - 1;
      const ab = await requestSpan(startByte, endByte);
      const s = samples[k];
      const chunk = new EncodedVideoChunk({
        type: "key",
        timestamp: tsUs(s.pts),
        data: new Uint8Array(ab),
      });
      try { decoder.decode(chunk); } catch (e) {}
      return;
    }

    // Precise seek: decode all frames up to the target
    const job = jobId;

    const startByte = samples[startIdx].off;
    const endByte = samples[targetDecodeIdx].off + samples[targetDecodeIdx].size - 1;

    const ab = await requestSpan(startByte, endByte);
    if (job !== jobId) return; // Aborted while fetching

    const base = startByte;
    const u8 = new Uint8Array(ab);

    for (let i = startIdx; i <= targetDecodeIdx; i++) {
      if (job !== jobId) return;
      const s = samples[i];
      const off = s.off - base;
      const view = u8.subarray(off, off + s.size);
      const chunk = new EncodedVideoChunk({
        type: s.key ? "key" : "delta",
        timestamp: tsUs(s.pts),
        data: view,
      });
      try {
        if (job !== jobId) return;
        // Avoid overfilling decode queue
        if (decoder.decodeQueueSize > 6) {
          await new Promise(r => setTimeout(r, 0));
          if (job !== jobId) return;
        }
        decoder.decode(chunk);
      } catch (e: any) {
        // Recover from races where decoder was reset between chunks
        if (isKeyRequiredError(e)) {
          try {
            decoder.reset();
            if (lastDecoderConfig) decoder.configure(lastDecoderConfig);
            // decode only the keyframe to re-sync
            const k = startIdx;
            const ks = samples[k];
            const koff = ks.off - base;
            const kview = u8.subarray(koff, koff + ks.size);
            const kchunk = new EncodedVideoChunk({ type: 'key', timestamp: tsUs(ks.pts), data: kview });
            decoder.decode(kchunk);
          } catch {}
          return;
        } else {
          (self as any).postMessage({ type: "fatal", error: `decode failed: ${e?.message || e}` });
          return;
        }
      }
    }
    if (job === jobId) {
        await decoder.flush().catch(() => {});
    }
  }

  if (m.type === "play") {
    if (!decoder || samples.length === 0 || (decoder.state !== 'configured' && decoder.state !== 'closed')) return;
    playing = true;
    cancelAndBumpJob();
    currentJob = jobId;
    playJobId++;
    const myPlay = playJobId;
    const startF = Math.max(0, Math.min(samples.length - 1, m.index | 0));
    const fps = Math.max(1, Math.min(240, m.fps | 0 || 30));
    const period = 1000 / fps;
    let nextDeadline = performance.now();
    // If scale is provided (canvas-scale), downscale frames accordingly to reduce CPU
    const s = Number.isFinite(m.scale) ? Math.max(0.1, Math.min(1, m.scale)) : 1;
    previewScale = s;
    const targetDecodeIdx = presentOrderIdxs[startF];
    const startIdx = findPrevKey(targetDecodeIdx);
    try {
      // Reset and configure decoder fresh for a clean GOP
      if (decoder.state !== 'configured') {
        if (lastDecoderConfig) decoder.configure(lastDecoderConfig);
      } else {
        decoder.reset();
        if (lastDecoderConfig) decoder.configure(lastDecoderConfig);
      }
    } catch {}

    // Prime from keyframe up to the start frame
    try {
      const startByte = samples[startIdx].off;
      const endByte = samples[targetDecodeIdx].off + samples[targetDecodeIdx].size - 1;
      const ab = await requestSpan(startByte, endByte);
      if (!playing || myPlay !== playJobId) return;
      const base = startByte;
      const u8 = new Uint8Array(ab);
      for (let i = startIdx; i <= targetDecodeIdx; i++) {
        if (!playing || myPlay !== playJobId) return;
        const s = samples[i];
        const off = s.off - base;
        const view = u8.subarray(off, off + s.size);
        const chunk = new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: tsUs(s.pts), data: view });
        try { decoder.decode(chunk); } catch (e: any) {
          if (isKeyRequiredError(e)) {
            try {
              decoder.reset();
              if (lastDecoderConfig) decoder.configure(lastDecoderConfig);
              const k = startIdx;
              const ks = samples[k];
              const koff = ks.off - base;
              const kview = u8.subarray(koff, koff + ks.size);
              const kchunk = new EncodedVideoChunk({ type: 'key', timestamp: tsUs(ks.pts), data: kview });
              decoder.decode(kchunk);
            } catch {}
            return;
          }
        }
      }
      await decoder.flush().catch(() => {});
    } catch {}

    // Mark play start for drop policy timeline
    playStartWall = performance.now();
    playStartPresentIdx = startF;

    // Stream forward frame-by-frame
    (async () => {
      let i = targetDecodeIdx + 1;
      while (playing && myPlay === playJobId && i < samples.length) {
        try {
          const s = samples[i];
          const ab = await requestSpan(s.off, s.off + s.size - 1);
          if (!playing || myPlay !== playJobId) return;
          const view = new Uint8Array(ab);
          const chunk = new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: tsUs(s.pts), data: view });
          // Backpressure: if queue is large, yield to decoder
          if (decoder.decodeQueueSize > 3) await new Promise(r => setTimeout(r, 0));
          if (!playing || myPlay !== playJobId) return;
          decoder.decode(chunk);
        } catch (e: any) {
          if (isKeyRequiredError(e)) {
            // Find previous key, reset, and continue from there
            const k = findPrevKey(i);
            try {
              decoder.reset();
              if (lastDecoderConfig) decoder.configure(lastDecoderConfig);
              const ab2 = await requestSpan(samples[k].off, samples[k].off + samples[k].size - 1);
              if (!playing || myPlay !== playJobId) return;
              const keyChunk = new EncodedVideoChunk({ type: 'key', timestamp: tsUs(samples[k].pts), data: new Uint8Array(ab2) });
              decoder.decode(keyChunk);
              i = k + 1; // resume after key
              continue;
            } catch {}
          }
        }
        // Pace feeding chunks to roughly match target FPS
        const now = performance.now();
        if (now < nextDeadline) {
          await new Promise(r => setTimeout(r, Math.max(0, nextDeadline - now)));
        }
        nextDeadline += period;
        i++;
      }
    })();
    return;
  }

  if (m.type === "pause") {
    playing = false;
    cancelAndBumpJob();
    return;
  }
};
