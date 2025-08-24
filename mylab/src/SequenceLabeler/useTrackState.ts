import { useCallback, useMemo, useRef, useState } from "react";
import type { LabelSet, Track } from "../types";
import DEFAULT_COLORS from "./defaultColors";

export default function useTrackState(
  initialLabelSetName: string,
  defaultClasses: string[],
) {
  const [labelSet, setLabelSet] = useState<LabelSet>({
    name: initialLabelSetName,
    classes: defaultClasses,
    colors: defaultClasses.map(
      (_, i) => DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    ),
  });
  const [availableSets, setAvailableSets] = useState<LabelSet[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [hiddenClasses, setHiddenClasses] = useState<Set<number>>(new Set());
  const historyRef = useRef<Track[][]>([]);
  const futureRef = useRef<Track[][]>([]);
  const applyTracks = useCallback(
    (updater: (ts: Track[]) => Track[], record = false) => {
      setTracks((ts) => {
        const next = updater(ts);
        if (record && next !== ts) {
          historyRef.current.push(JSON.parse(JSON.stringify(ts)));
          if (historyRef.current.length > 100) historyRef.current.shift();
          futureRef.current = [];
        }
        return next;
      });
    },
    [],
  );
  const undo = useCallback(() => {
    setTracks((curr) => {
      const prev = historyRef.current.pop();
      if (!prev) return curr;
      futureRef.current.push(JSON.parse(JSON.stringify(curr)));
      return prev;
    });
  }, []);
  const redo = useCallback(() => {
    setTracks((curr) => {
      const next = futureRef.current.pop();
      if (!next) return curr;
      historyRef.current.push(JSON.parse(JSON.stringify(curr)));
      return next;
    });
  }, []);
  const [interpolate, setInterpolate] = useState(true);
  const [showGhosts, setShowGhosts] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectedTracks = useMemo(
    () => tracks.filter((t) => selectedIds.has(t.track_id)),
    [tracks, selectedIds],
  );
  const oneSelected = selectedTracks[0] ?? null;
  return {
    labelSet,
    setLabelSet,
    availableSets,
    setAvailableSets,
    tracks,
    setTracks,
    applyTracks,
    undo,
    redo,
    hiddenClasses,
    setHiddenClasses,
    interpolate,
    setInterpolate,
    showGhosts,
    setShowGhosts,
    selectedIds,
    setSelectedIds,
    selectedTracks,
    oneSelected,
    historyRef,
    futureRef,
  };
}
