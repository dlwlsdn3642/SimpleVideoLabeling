// Minimal MP4Box + WebCodecs worker based on Test/worker.js
// Protocol:
// - Main posts {type:'init', fileSize:number, initBytes?:number}
// - Worker posts {type:'need', start:number, end:number}
// - Main posts {type:'bytes', start:number, end:number, buf:ArrayBuffer}
// - When ready: {type:'ready', width, height, frames, durationMs}
// - Main posts {type:'seekFrame', index:number}
// - Worker posts {type:'frame', frameIdx:number, bitmap:ImageBitmap}

self.addEventListener('error', (e) => {
  try { (self as any).postMessage({ type: 'fatal', error: String(e.message || e) }); } catch {}
});
self.addEventListener('unhandledrejection', (e: any) => {
  try { (self as any).postMessage({ type: 'fatal', error: String(e?.reason?.message || e?.reason || e) }); } catch {}
});

// Load mp4box UMD into worker scope via fetch + eval to ensure MP4Box on self
let mp4boxCreateFile: any = null;
let DataStreamCtor: any = null;
async function ensureMP4Box() {
  const g: any = (self as any);
  if (g.MP4Box) {
    mp4boxCreateFile = g.MP4Box.createFile;
    DataStreamCtor = g.MP4Box.DataStream || (g as any).DataStream;
    return;
  }
  const url = 'https://cdn.jsdelivr.net/npm/mp4box@0.5.4/dist/mp4box.all.min.js';
  const r = await fetch(url, { cache: 'force-cache' });
  const js = await r.text();
  // eslint-disable-next-line no-eval
  (0, eval)(js);
  mp4boxCreateFile = g.MP4Box?.createFile;
  DataStreamCtor = g.MP4Box?.DataStream || (g as any).DataStream;
}
(async () => {
  try {
    await ensureMP4Box();
    (self as any).postMessage({ type: 'log', msg: 'MP4Box loaded: ' + !!(self as any).MP4Box });
    (self as any).postMessage({ type: 'hello' });
  } catch (e) {
    try { (self as any).postMessage({ type: 'fatal', error: 'MP4Box load failed: ' + String((e as any)?.message || e) }); } catch {}
  }
})();

function postNeed(start: number, end: number) {
  (self as any).postMessage({ type: 'need', start, end });
}

let mp4: any = null;
let videoTrack: any = null;
let timescale = 0;
let samples: { off: number; size: number; dts: number; pts: number; key: boolean }[] = [];
let presentOrderIdxs: number[] = [];
let decoder: VideoDecoder | null = null;
let codec = '';
let description: Uint8Array | undefined;
let spsList: Uint8Array[] = [];
let ppsList: Uint8Array[] = [];
let naluLenBytes = 4;
const USE_ANNEXB = true; // Remux to Annex-B for robust decoding
let isReady = false;
let fileSize = 0;
let chunkSize = 1024 * 1024;

function tsUsFrom(val: number) {
  return Math.round((1e6 * val) / (timescale || 1));
}

function setupMP4() {
  mp4 = mp4boxCreateFile();
  mp4.onError = (e: any) => tryPostLog('mp4box error ' + String(e?.message || e));
  mp4.onReady = async (info: any) => {
    const v = info.videoTracks?.[0];
    if (!v) { tryPostFatal('no video track'); return; }
    tryPostLog(`onReady: codec=${v.codec}, timescale=${v.timescale}, duration=${v.duration}`);
    videoTrack = v;
    timescale = v.timescale || v.movie_timescale || 1;
    // Build sample table
    let idx: any[] = [];
    try { idx = mp4.getTrackSamplesInfo(v.id) || []; } catch (e) { tryPostFatal('getTrackSamplesInfo failed: ' + String((e as any)?.message || e)); return; }
    if (!idx.length) { tryPostFatal('empty sample index'); return; }
    tryPostLog('samples indexed: ' + idx.length);
    samples = idx.map((s) => ({
      off: s.offset,
      size: s.size,
      dts: s.dts,
      pts: s.dts + (s.cts || 0),
      key: !!s.is_sync,
    }));
    presentOrderIdxs = samples.map((_, i) => i).sort((a, b) => {
      const pa = samples[a].pts, pb = samples[b].pts;
      if (pa === pb) return a - b;
      return pa - pb;
    });
    // Decoder config
    codec = v.codec;
    description = undefined;
    try {
      const trak = mp4.getTrackById(v.id);
      const stsd = trak?.mdia?.minf?.stbl?.stsd;
      const entry = stsd?.entries?.[0];
      const peelBoxHeader = (buf: Uint8Array) => {
        if (!buf || buf.length < 8) return buf;
        const len = (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
        const t4 = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
        if (len === buf.length && (t4 === 'avcC' || t4 === 'hvcC')) return buf.subarray(8);
        return buf;
      };
      if (entry?.avcC && DataStreamCtor) {
        const ds = new DataStreamCtor();
        entry.avcC.write(ds);
        description = peelBoxHeader(new Uint8Array(ds.buffer));
        // capture SPS/PPS arrays from mp4box parsed structure if available
        try {
          const avc = entry.avcC;
          const spsRaw = (avc.SPS || avc.sps || []).map((x: any) => new Uint8Array(x.data || x));
          const ppsRaw = (avc.PPS || avc.pps || []).map((x: any) => new Uint8Array(x.data || x));
          spsList = spsRaw;
          ppsList = ppsRaw;
          const lmo = (avc.lengthSizeMinusOne ?? avc.lengthSize ?? 3) & 0x3;
          naluLenBytes = (lmo + 1) || 4;
        } catch {}
      } else if (entry?.hvcC && DataStreamCtor) {
        const ds = new DataStreamCtor();
        entry.hvcC.write(ds);
        description = peelBoxHeader(new Uint8Array(ds.buffer));
      } else if ((v as any).codecDescription) {
        description = new Uint8Array((v as any).codecDescription);
      }
      // Validate avcC signature (configurationVersion should be 1)
      if (codec?.startsWith('avc1') && (!description || description[0] !== 1)) {
        // Construct AVCDecoderConfigurationRecord manually from mp4box parsed fields
        const avc = entry?.avcC;
        if (avc) {
          const profile = avc.AVCProfileIndication ?? avc.avcProfileIndication ?? 66;
          const compat = avc.profile_compatibility ?? 0;
          const level = avc.AVCLevelIndication ?? avc.avcLevelIndication ?? 30;
          const nlsm1 = (avc.lengthSizeMinusOne ?? avc.lengthSize ?? 3) & 3; // 0..3 means 1..4 bytes
          naluLenBytes = (nlsm1 + 1) || 4;
          spsList = (avc.SPS || avc.sps || []).map((x: any) => new Uint8Array(x.data || x));
          ppsList = (avc.PPS || avc.pps || []).map((x: any) => new Uint8Array(x.data || x));
          let size = 6; // 1+1+1+1+1+1 (version, profile, compat, level, lenSize, numSPS)
          for (const s of spsList) size += 2 + s.length;
          size += 1; // numPPS
          for (const p of ppsList) size += 2 + p.length;
          const out = new Uint8Array(size);
          let o = 0;
          out[o++] = 1; // configurationVersion
          out[o++] = profile & 0xff;
          out[o++] = compat & 0xff;
          out[o++] = level & 0xff;
          out[o++] = 0xfc | (nlsm1 & 0x3); // 111111 + lengthSizeMinusOne
          out[o++] = 0xe0 | (spsList.length & 0x1f); // 111xxxxx + numOfSPS
          for (const s of spsList) {
            out[o++] = (s.length >> 8) & 0xff; out[o++] = s.length & 0xff;
            out.set(s, o); o += s.length;
          }
          out[o++] = ppsList.length & 0xff;
          for (const p of ppsList) {
            out[o++] = (p.length >> 8) & 0xff; out[o++] = p.length & 0xff;
            out.set(p, o); o += p.length;
          }
          description = out;
          tryPostLog('built avcC manually, len=' + out.length);
        } else {
          tryPostLog('no avcC entry to build description');
        }
      }
    } catch (e) {
      tryPostLog('description extraction failed: ' + String((e as any)?.message || e));
    }
    tryPostLog(`decoder config: codec=${codec}, desc_len=${description ? description.byteLength : 0}`);
    decoder = new VideoDecoder({ output: () => {}, error: (e) => tryPostFatal(String(e?.message || e)) });
    const cfg: any = { codec, hardwareAcceleration: 'prefer-hardware' };
    if (!USE_ANNEXB && description) cfg.description = description;
    try {
      const sup = await (VideoDecoder as any).isConfigSupported(cfg).catch(() => ({ supported: true, config: cfg }));
      decoder.configure(sup.config || cfg);
    } catch (e) { tryPostFatal('decoder configure failed: ' + String((e as any)?.message || e)); return; }
    isReady = true;
    const fps = samples.length && v.duration ? (samples.length / (v.duration / v.timescale)) : (v.avgFrameRate || 30);
    try {
      (self as any).postMessage({ type: 'ready', width: v.track_width, height: v.track_height, durationMs: Math.round(1000 * v.duration / v.timescale), frames: samples.length, fps: Math.round(fps) });
    } catch (e) {
      tryPostFatal('post ready failed: ' + String((e as any)?.message || e));
    }
  };
}

function tryPostLog(msg: string) { try { (self as any).postMessage({ type: 'log', msg }); } catch {} }
function tryPostFatal(error: string) { try { (self as any).postMessage({ type: 'fatal', error }); } catch {} }

function requestSpan(startByte: number, endByteIncl: number): Promise<ArrayBuffer> {
  return new Promise((resolve) => {
    const onBytes = (ev: MessageEvent) => {
      const m: any = ev.data;
      if (m && m.type === 'bytes' && m.start === startByte && m.end === endByteIncl && m.buf) {
        (self as any).removeEventListener('message', onBytes);
        resolve(m.buf as ArrayBuffer);
      }
    };
    (self as any).addEventListener('message', onBytes);
    postNeed(startByte, endByteIncl);
  });
}

(self as any).onmessage = async (ev: MessageEvent) => {
  const m: any = ev.data;
  if (!m) return;
  if (m.type === 'init') {
    fileSize = m.fileSize | 0;
    chunkSize = Math.max(256 * 1024, m.initBytes | 0) || 1024 * 1024;
    setupMP4();
    // Pull initial chunk(s)
    let offset = 0;
    let iter = 0;
    while (!isReady && offset < fileSize) {
      const end = Math.min(fileSize, offset + chunkSize) - 1;
      tryPostLog(`init fetch ${offset}-${end}`);
      const ab = await requestSpan(offset, end);
      (ab as any).fileStart = offset;
      mp4.appendBuffer(ab);
      offset = end + 1;
      await new Promise(r => setTimeout(r));
      if (++iter > 64 && !isReady) { tryPostLog('moov not ready after 64 chunks'); }
    }
  } else if (m.type === 'bytes') {
    // handled in requestSpan listener
  } else if (m.type === 'seekFrame') {
    if (!decoder || !samples.length) return;
    const total = samples.length;
    let pIdx = m.index | 0;
    if (pIdx < 0) pIdx = 0; if (pIdx >= total) pIdx = total - 1;
    const dIdx = presentOrderIdxs[pIdx] ?? pIdx;
    let startIdx = dIdx; for (let i = dIdx; i >= 0; --i) { if (samples[i].key) { startIdx = i; break; } }
    const startByte = samples[startIdx].off;
    const endByte = samples[dIdx].off + samples[dIdx].size - 1;
    tryPostLog(`seekFrame idx=${pIdx} dIdx=${dIdx} bytes=${startByte}-${endByte}`);
    const ab = await requestSpan(startByte, endByte);
    const base = startByte; const u8 = new Uint8Array(ab);
    const outFrames: VideoFrame[] = [];
    // Use a fresh decoder for capture to avoid state races
    const localDec = new VideoDecoder({ output: (f) => outFrames.push(f), error: (e) => tryPostLog('local decoder error: ' + String((e as any)?.message || e)) });
    const cfg: any = { codec, hardwareAcceleration: 'prefer-hardware' };
    if (!USE_ANNEXB && description) cfg.description = description;
    try { localDec.configure(cfg); } catch (e) { tryPostFatal('local decoder configure failed: ' + String((e as any)?.message || e)); return; }
    for (let i = startIdx; i <= dIdx; i++) {
      const s = samples[i]; const off = s.off - base; const view = u8.subarray(off, off + s.size);
      let dataToSend = view;
      if (USE_ANNEXB && codec.startsWith('avc1')) {
        // Remux to Annex-B; prepend SPS/PPS for keyframes
        const startCode = new Uint8Array([0,0,0,1]);
        const aud = new Uint8Array([0,0,0,1, 0x09, 0xf0]); // AUD
        // Convert length-prefixed to Annex-B
        const chunks: Uint8Array[] = [];
        // Insert AUD before each access unit
        chunks.push(aud);
        if (s.key) {
          for (const sps of spsList) { chunks.push(startCode, sps); }
          for (const pps of ppsList) { chunks.push(startCode, pps); }
        }
        let p = 0;
        while (p + naluLenBytes <= view.length) {
          let nlen = 0;
          for (let b = 0; b < naluLenBytes; b++) nlen = (nlen << 8) | view[p + b];
          p += naluLenBytes;
          if (nlen <= 0 || p + nlen > view.length) break;
          const nal = view.subarray(p, p + nlen);
          chunks.push(startCode, nal);
          p += nlen;
        }
        // concat
        let total = 0; for (const c of chunks) total += c.length;
        const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
        dataToSend = out;
      }
      try {
        // Use DTS-based timestamps to ensure monotonic decode order
        const ts = tsUsFrom(s.dts);
        const chunk = new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: ts, data: dataToSend });
        localDec.decode(chunk);
      } catch {}
    }
    try { await localDec.flush(); } catch (e) { tryPostLog('local decoder flush failed: ' + String((e as any)?.message || e)); }
    tryPostLog('decoded frames in window: ' + outFrames.length);
    // Close all but the last frame
    const vf = outFrames.pop();
    for (const f of outFrames) { try { (f as VideoFrame).close(); } catch {} }
    if (vf) {
      let sent = false;
      try {
        const bmp = await createImageBitmap(vf);
        (self as any).postMessage({ type: 'frame', frameIdx: pIdx, bitmap: bmp }, [bmp as any]);
        sent = true;
        try { vf.close(); } catch {}
      } catch (e) {
        tryPostLog('createImageBitmap in worker failed; fallback to VideoFrame transfer');
      }
      if (!sent) {
        try {
          (self as any).postMessage({ type: 'vframe', frameIdx: pIdx, frame: vf }, [vf as any]);
          sent = true;
        } catch (e2) {
          tryPostFatal('post VideoFrame failed: ' + String((e2 as any)?.message || e2));
          try { vf.close(); } catch {}
        }
      }
      // If neither path succeeded, close the frame
      if (!sent) { try { vf.close(); } catch {} }
    }
    try { localDec.close(); } catch {}
  }
};
