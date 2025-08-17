import type { Keyframe } from "../types";
import { findKFIndexAtOrBefore } from "./geom";

export function togglePresenceAtFrame(presence: number[], keyframes: Keyframe[], frame: number): number[] {
  const arr = [...presence];
  const idx = findKFIndexAtOrBefore(keyframes, frame);
  const toggle = (f: number) => {
    const j = arr.indexOf(f);
    if (j >= 0) arr.splice(j, 1); else arr.push(f);
  };
  if (idx >= 0 && keyframes[idx].frame === frame) {
    const hadFrame = arr.includes(frame);
    toggle(frame);
    const nextKF = idx + 1 < keyframes.length ? keyframes[idx + 1].frame : null;
    if (nextKF !== null) {
      const j2 = arr.indexOf(nextKF + 1);
      if (j2 >= 0) arr.splice(j2, 1);
      if (hadFrame) {
        const j = arr.indexOf(nextKF);
        if (j >= 0 && !arr.some(f => f > nextKF)) arr.splice(j, 1);
      }
    }
  } else {
    const prev = idx >= 0 ? keyframes[idx].frame : null;
    const next = idx + 1 < keyframes.length ? keyframes[idx + 1].frame : null;
    if (prev !== null) toggle(prev);
    if (next !== null) toggle(next);
  }
  arr.sort((a, b) => a - b);
  return arr;
}
