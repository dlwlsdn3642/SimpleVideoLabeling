/**
 * Media module: frame sourcing and seeking.
 *
 * Public API:
 *   - requestVideoFrame(videoWorkerRef, pendingVideoSeekRef, videoSeekScheduledRef, idx, exact?)
 *     Schedules a seek request on the video worker. The seek is coalesced to
 *     the last requested frame and executed on the next animation frame.
 */
import type React from "react";

export function requestVideoFrame(
  videoWorkerRef: React.MutableRefObject<Worker | null>,
  pendingVideoSeekRef: React.MutableRefObject<number | null>,
  videoSeekScheduledRef: React.MutableRefObject<boolean>,
  idx: number,
  exact = false
): void {
  pendingVideoSeekRef.current = idx;
  if (videoSeekScheduledRef.current) return;
  videoSeekScheduledRef.current = true;
  requestAnimationFrame(() => {
    if (videoWorkerRef.current && pendingVideoSeekRef.current !== null) {
      try {
        videoWorkerRef.current.postMessage({
          type: 'seekFrame',
          index: pendingVideoSeekRef.current,
          exact,
        });
      } catch {
        // swallow postMessage failures; caller handles worker lifecycle
      }
    }
    videoSeekScheduledRef.current = false;
  });
}
