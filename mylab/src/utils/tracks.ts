import type { RectPX, Track } from "../types";

// Ensure there is a keyframe at frame f with rect r. If a keyframe already
// exists at f, preserves the existing `absent` flag.
export function ensureKFAt(t: Track, f: number, r: RectPX): Track {
  const kfs = [...t.keyframes];
  const idx = kfs.findIndex((k) => k.frame === f);
  const kf = {
    frame: f,
    bbox_xywh: [r.x, r.y, r.w, r.h] as [number, number, number, number],
  };
  if (idx >= 0) kfs[idx] = { ...kf, absent: kfs[idx].absent };
  else {
    kfs.push(kf);
    kfs.sort((a, b) => a.frame - b.frame);
  }
  return { ...t, keyframes: kfs };
}

