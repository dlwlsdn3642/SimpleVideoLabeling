/// <reference lib="webworker" />
// Dedicated worker for image loading, decoding, and canvas drawing.
// Receives an OffscreenCanvas from the main thread and renders frames plus overlays.

import LRUFrames from "../lib/LRUFrames";
import type { IndexMeta, LabelSet, RectPX, Track } from "../types";
import { rectAtFrame } from "../utils/geom";

type SourceRemote = { kind: "remote"; baseUrl: string; files: string[] };
type SourceLocal = { kind: "local"; count: number };

type WorkerState = {
  meta: IndexMeta | null;
  scale: number;
  fps: number;
  ghostAlpha: number;
  interpolate: boolean;
  showGhosts: boolean;
  labelSet: LabelSet | null;
  tracks: Track[];
  selectedIds: Set<string>;
  frame: number;
  source: SourceRemote | SourceLocal | null;
  decodeScaleHint: number;
};

const state: WorkerState = {
  meta: null,
  scale: 1,
  fps: 30,
  ghostAlpha: 0.35,
  interpolate: true,
  showGhosts: true,
  labelSet: null,
  tracks: [],
  selectedIds: new Set(),
  frame: 0,
  source: null,
  decodeScaleHint: 1,
};

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

const cache = new LRUFrames(128);
const inFlight = new Map<number, Promise<ImageBitmap | null>>();
let lastDrawn: { frame: number; bmp: ImageBitmap | null } = { frame: -1, bmp: null };
let timer: number | null = null;
let lastDecodeReq = 0;
let decodeIntervalMs = 1000 / 30;
const upgradeInFlight = new Set<number>();

// Local source blob request handling
const pendingBlobResolvers = new Map<number, (blob: Blob | null) => void>();
async function getLocalBlob(index: number): Promise<Blob | null> {
  if (pendingBlobResolvers.has(index)) return null; // prevent duplicate asks
  const p = new Promise<Blob | null>((resolve) => {
    pendingBlobResolvers.set(index, resolve);
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: "needBlob", index });
  });
  return p.finally(() => pendingBlobResolvers.delete(index));
}

function setTimer() {
  if (timer != null) clearInterval(timer);
  const interval = Math.max(4, Math.floor(1000 / Math.max(1, state.fps)));
  // @ts-ignore - setInterval in worker returns number
  timer = setInterval(tick, interval) as unknown as number;
}

function ensureCtx() {
  if (!canvas) return false;
  if (!ctx) ctx = canvas.getContext("2d");
  return !!ctx;
}

async function getImage(idx: number, hintOverride?: number): Promise<ImageBitmap | null> {
  if (!state.meta || !state.source) return null;
  const source = state.source;
  const total = source.kind === "remote" ? source.files.length : source.count;
  if (idx < 0 || idx >= total) return null;
  const cached = cache.get(idx);
  if (cached) return cached;
  const ex = inFlight.get(idx);
  if (ex) return ex;

  const p = (async () => {
    try {
      const baseW = canvas?.width ?? Math.round((state.meta?.width ?? 0) * (state.scale || 1));
      const baseH = canvas?.height ?? Math.round((state.meta?.height ?? 0) * (state.scale || 1));
      const hint = (hintOverride ?? state.decodeScaleHint) || 1;
      const targetW = Math.max(1, Math.round(baseW * hint));
      const targetH = Math.max(1, Math.round(baseH * hint));
      if (source.kind === "remote") {
        const url = `${source.baseUrl}/${source.files[idx]}`;
        const res = await fetch(url, { cache: "force-cache" });
        if (!res.ok) throw new Error(`image fetch ${res.status}`);
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob, {
          resizeWidth: targetW,
          resizeHeight: targetH,
          resizeQuality: "low",
        } as any);
        cache.set(idx, bmp);
        return bmp;
      } else {
        const blob = await getLocalBlob(idx);
        if (!blob) return null;
        const bmp = await createImageBitmap(blob, {
          resizeWidth: targetW,
          resizeHeight: targetH,
          resizeQuality: "low",
        } as any);
        cache.set(idx, bmp);
        return bmp;
      }
    } catch {
      return null;
    } finally {
      inFlight.delete(idx);
    }
  })();
  inFlight.set(idx, p);
  return p;
}

function drawOverlays(drawIndex: number) {
  if (!ctx || !state.meta || !state.labelSet) return;
  const { tracks, selectedIds, interpolate, showGhosts, ghostAlpha, labelSet } = state;
  const sc = state.scale;
  const drawRect = (r: RectPX, color = "#00e5ff", alpha = 1, dashed = false) => {
    const x = r.x * sc, y = r.y * sc, w = r.w * sc, h = r.h * sc;
    ctx!.save();
    ctx!.globalAlpha = alpha;
    ctx!.setLineDash(dashed ? [6, 6] : []);
    ctx!.lineWidth = 2;
    ctx!.strokeStyle = color;
    ctx!.strokeRect(x, y, w, h);
    const hs = 6;
    ctx!.fillStyle = color;
    const dots = [[x,y],[x+w,y],[x,y+h],[x+w,y+h],[x+w/2,y],[x+w/2,y+h],[x,y+h/2],[x+w,y+h/2]] as const;
    for (const [dx, dy] of dots) ctx!.fillRect(dx - hs, dy - hs, hs * 2, hs * 2);
    ctx!.restore();
  };

  if (showGhosts && ghostAlpha > 0) {
    for (const tck of tracks) {
      if ((tck as any).hidden) continue;
      const color = labelSet.colors[tck.class_id] || "#66d9ef";
      const prev = rectAtFrame(tck, drawIndex - 1, interpolate);
      if (prev) drawRect(prev, color, ghostAlpha, true);
      const next = rectAtFrame(tck, drawIndex + 1, interpolate);
      if (next) drawRect(next, color, ghostAlpha, true);
    }
  }
  for (const tck of tracks) {
    if ((tck as any).hidden) continue;
    const r = rectAtFrame(tck, drawIndex, interpolate);
    if (!r) continue;
    const color = labelSet.colors[tck.class_id] || "#66d9ef";
    const isSel = selectedIds.has(tck.track_id);
    drawRect(r, color, isSel ? 1 : 0.7, false);
    ctx!.save();
    const cls = labelSet.classes[tck.class_id] ?? String(tck.class_id);
    const tag = `${cls}${tck.name ? ` (${tck.name})` : ""}`;
    ctx!.font = "12px monospace";
    const x = r.x * sc, y = r.y * sc, w = ctx!.measureText(tag).width + 8;
    ctx!.fillStyle = color;
    ctx!.globalAlpha = 0.5;
    ctx!.fillRect(x, y - 18, w, 18);
    ctx!.globalAlpha = 1;
    ctx!.fillStyle = "#fff";
    ctx!.fillText(tag, x + 4, y - 5);
    ctx!.restore();
  }
}

async function tick() {
  if (!ensureCtx() || !state.meta || !state.source) return;
  const now = performance.now();
  const source = state.source as SourceRemote | SourceLocal;
  const total = source.kind === "remote" ? source.files.length : source.count;
  const desired = Math.max(0, Math.min(total - 1, state.frame));
  const delta = Math.abs((lastDrawn.frame ?? 0) - desired);
  const stride = delta > 120 ? 8 : delta > 60 ? 4 : delta > 20 ? 2 : 1;
  state.decodeScaleHint = stride >= 8 ? 0.25 : stride >= 4 ? 0.5 : 1;
  const target = Math.max(0, Math.min(total - 1, Math.round(desired / stride) * stride));

  // choose bitmap: target->neighbors->lastDrawn
  let drawBmp: ImageBitmap | null = cache.get(target) ?? null;
  let drawIndex = target;
  if (!drawBmp) {
    if (now - lastDecodeReq >= decodeIntervalMs) {
      lastDecodeReq = now;
      void getImage(target).then(() => {
        // trigger a repaint soon
      });
    }
    const maxSearch = 24;
    for (let d = 1; d <= maxSearch; d++) {
      const before = target - d * stride;
      const after = target + d * stride;
      if (before >= 0 && cache.has(before)) { drawBmp = cache.get(before)!; drawIndex = before; break; }
      if (after < total && cache.has(after)) { drawBmp = cache.get(after)!; drawIndex = after; break; }
    }
    if (!drawBmp && lastDrawn.bmp) { drawBmp = lastDrawn.bmp; drawIndex = lastDrawn.frame; }
  }
  if (drawBmp) {
    ctx!.imageSmoothingEnabled = false;
    ctx!.fillStyle = "#111";
    ctx!.fillRect(0, 0, (canvas as OffscreenCanvas).width, (canvas as OffscreenCanvas).height);
    ctx!.drawImage(drawBmp, 0, 0, (canvas as OffscreenCanvas).width, (canvas as OffscreenCanvas).height);
    lastDrawn = { frame: drawIndex, bmp: drawBmp };
    drawOverlays(drawIndex);

    // prefetch
    const dir = desired > drawIndex ? 1 : desired < drawIndex ? -1 : 0;
    const ahead = dir ? 8 : 4;
    if (stride < 4 && (now - lastDecodeReq >= decodeIntervalMs)) {
      lastDecodeReq = now;
      for (let d = 1; d <= ahead; d++) {
        const idx = drawIndex + dir * d * stride;
        if (idx >= 0 && idx < total && !cache.has(idx)) {
          void getImage(idx);
          break;
        }
      }
    }
    // hi-res upgrade
    if (stride === 1 && drawBmp && drawBmp.width < (canvas as OffscreenCanvas).width && !upgradeInFlight.has(drawIndex)) {
      if (now - lastDecodeReq >= decodeIntervalMs) {
        lastDecodeReq = now;
        upgradeInFlight.add(drawIndex);
        void getImage(drawIndex, 1).then(() => upgradeInFlight.delete(drawIndex));
      }
    }
  }
  // no-op
}

function handleMessage(e: MessageEvent) {
  const data = e.data as any;
  switch (data?.type) {
    case "init": {
      canvas = data.canvas as OffscreenCanvas;
      ctx = null;
      state.meta = data.meta ?? state.meta;
      state.scale = data.scale ?? state.scale;
      state.fps = data.fps ?? state.fps;
      decodeIntervalMs = 1000 / Math.max(1, state.fps);
      if (data.width && data.height && canvas) {
        (canvas as OffscreenCanvas).width = data.width;
        (canvas as OffscreenCanvas).height = data.height;
      }
      setTimer();
      break;
    }
    case "setRemoteSource": {
      const src: SourceRemote = { kind: "remote", baseUrl: data.baseUrl, files: data.files };
      state.source = src;
      cache.clear();
      lastDrawn = { frame: -1, bmp: null };
      break;
    }
    case "setLocalSource": {
      const src: SourceLocal = { kind: "local", count: data.count };
      state.source = src;
      cache.clear();
      lastDrawn = { frame: -1, bmp: null };
      break;
    }
    case "setMeta": {
      state.meta = data.meta;
      break;
    }
    case "setScale": {
      state.scale = data.scale;
      break;
    }
    case "resize": {
      if (canvas) {
        (canvas as OffscreenCanvas).width = data.width;
        (canvas as OffscreenCanvas).height = data.height;
      }
      break;
    }
    case "setFPS": {
      state.fps = data.fps;
      decodeIntervalMs = 1000 / Math.max(1, state.fps);
      setTimer();
      break;
    }
    case "setFrame": {
      state.frame = data.frame | 0;
      break;
    }
    case "updateState": {
      const { tracks, selectedIds, labelSet, interpolate, showGhosts, ghostAlpha } = data;
      if (Array.isArray(tracks)) state.tracks = tracks;
      if (Array.isArray(selectedIds)) state.selectedIds = new Set<string>(selectedIds);
      if (labelSet) state.labelSet = labelSet;
      if (typeof interpolate === "boolean") state.interpolate = interpolate;
      if (typeof showGhosts === "boolean") state.showGhosts = showGhosts;
      if (typeof ghostAlpha === "number") state.ghostAlpha = ghostAlpha;
      break;
    }
    case "provideBlob": {
      const { index, blob } = data as { index: number; blob: Blob | null };
      const resolve = pendingBlobResolvers.get(index);
      resolve?.(blob ?? null);
      break;
    }
    case "forceTick": {
      void tick();
      break;
    }
    default:
      break;
  }
}

self.onmessage = handleMessage;
