import type { Keyframe } from "../types";
import { findKFIndexAtOrBefore } from "./geom";

/**
 * Toggle presence (object absence) spanning the interval between the surrounding
 * keyframes. Presence is owned by the keyframe and indicates that the object is
 * absent until the next keyframe. Toggling simply flips the start and end
 * boundaries of that interval, automatically merging with any neighbouring
 * intervals.
 */
export function togglePresenceAtFrame(presence: number[], keyframes: Keyframe[], frame: number): number[] {
  const arr = [...presence];
  const idx = findKFIndexAtOrBefore(keyframes, frame);
  if (idx < 0) return arr;

  const prev = keyframes[idx].frame;
  const next = idx + 1 < keyframes.length ? keyframes[idx + 1].frame : undefined;
  if (next === undefined) return arr;

  const toggle = (f: number) => {
    const j = arr.indexOf(f);
    if (j >= 0) arr.splice(j, 1); else arr.push(f);
  };

  toggle(prev);
  toggle(next);

  arr.sort((a, b) => a - b);
  return arr;
}
