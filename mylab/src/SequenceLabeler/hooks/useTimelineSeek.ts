import { useCallback, useRef } from "react";

type Params = {
  setFrame: (f: number) => void;
  videoWorkerRef: React.MutableRefObject<Worker | null>;
  currentFrameRef: React.MutableRefObject<number>;
  scrubActiveRef: React.MutableRefObject<boolean>;
};

// Coalesced 60Hz seek scheduler for timeline scrubbing.
export function useTimelineSeek({ setFrame, videoWorkerRef, currentFrameRef, scrubActiveRef }: Params) {
  const seekIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seekTargetFrameRef = useRef<number | null>(null);

  const scheduleSeek = useCallback((f: number) => {
    const frame = Math.round(f);
    seekTargetFrameRef.current = frame;

    if (!seekIntervalRef.current) {
      // Apply first target immediately for responsiveness
      scrubActiveRef.current = true;
      setFrame(frame);
      if (videoWorkerRef.current) {
        try { videoWorkerRef.current.postMessage({ type: 'seekFrame', index: frame }); } catch { /* noop */ }
      }

      seekIntervalRef.current = setInterval(() => {
        const target = seekTargetFrameRef.current;
        if (target !== null) {
          setFrame(target);
          seekTargetFrameRef.current = null;
        } else {
          try {
            if (videoWorkerRef.current) {
              videoWorkerRef.current.postMessage({ type: 'seekFrame', index: currentFrameRef.current, exact: true });
            }
          } catch { /* noop */ }
          if (seekIntervalRef.current) clearInterval(seekIntervalRef.current);
          seekIntervalRef.current = null;
          scrubActiveRef.current = false;
        }
      }, 1000 / 60);
    }
  }, [setFrame, videoWorkerRef, currentFrameRef, scrubActiveRef]);

  return { scheduleSeek };
}

