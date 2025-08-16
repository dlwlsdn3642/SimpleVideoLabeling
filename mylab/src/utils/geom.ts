import type { Keyframe, RectPX, Track, Handle } from "../types";

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const pad = (n: number, width: number) => n.toString().padStart(width, "0");
export const uuid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

export function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
export function rectLerp(a: RectPX, b: RectPX, t: number): RectPX {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) };
}
export function rectFromKF(kf: Keyframe): RectPX {
  const [x, y, w, h] = kf.bbox_xywh; return { x, y, w, h };
}
export function findKFIndexAtOrBefore(kfs: Keyframe[], f: number): number {
  let lo = 0, hi = kfs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid].frame <= f) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
export function isVisibleAt(track: Track, f: number): boolean {
  let cnt = 0;
  for (let i = 0; i < track.presence_toggles.length; i++) {
    if (track.presence_toggles[i] <= f) cnt++; else break;
  }
  return (cnt % 2) === 0; // even -> visible
}
export function rectAtFrame(track: Track, f: number, interpolate = true): RectPX | null {
  if (!isVisibleAt(track, f)) return null;
  if (track.keyframes.length === 0) return null;
  const k = findKFIndexAtOrBefore(track.keyframes, f);
  if (k === -1) return rectFromKF(track.keyframes[0]);
  const kf = track.keyframes[k];
  if (kf.frame === f || !interpolate || k === track.keyframes.length - 1) return rectFromKF(kf);
  const kf2 = track.keyframes[k + 1];
  const span = kf2.frame - kf.frame;
  if (span <= 0) return rectFromKF(kf);
  const t = (f - kf.frame) / span;
  return rectLerp(rectFromKF(kf), rectFromKF(kf2), t);
}
export function hitRect(r: RectPX, px: number, py: number) {
  return px >= r.x && py >= r.y && px <= r.x + r.w && py <= r.y + r.h;
}
export function handleAt(r: RectPX, px: number, py: number, s = 8): Handle {
  const within = (x: number, y: number) => Math.hypot(px - x, py - y) <= s;
  const x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
  if (within(x1, y1)) return "nw"; if (within(x2, y1)) return "ne";
  if (within(x1, y2)) return "sw"; if (within(x2, y2)) return "se";
  if (Math.abs(py - y1) <= s && px >= x1 && px <= x2) return "n";
  if (Math.abs(py - y2) <= s && px >= x1 && px <= x2) return "s";
  if (Math.abs(px - x1) <= s && py >= y1 && py <= y2) return "w";
  if (Math.abs(px - x2) <= s && py >= y1 && py <= y2) return "e";
  if (hitRect(r, px, py)) return "move";
  return "none";
}
export function parseNumericKey(name: string): number {
  const m = name.match(/(\d+)(?!.*\d)/);
  return m ? parseInt(m[1], 10) : NaN;
}