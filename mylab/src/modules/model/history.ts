import { useCallback, useRef, useState } from "react";
import type { TracksState, Action } from "./tracks";
import { reduce } from "./tracks";

export interface History {
  present: TracksState;
  canUndo: boolean;
  canRedo: boolean;
  dispatch(a: Action): void;
  undo(): void;
  redo(): void;
  reset(s: TracksState): void;
}

export function createHistory(initial: TracksState): History {
  let present = initial;
  const past: TracksState[] = [];
  const future: TracksState[] = [];

  return {
    get present() {
      return present;
    },
    get canUndo() {
      return past.length > 0;
    },
    get canRedo() {
      return future.length > 0;
    },
    dispatch(a: Action) {
      if (a.type === "UNDO") {
        this.undo();
        return;
      }
      if (a.type === "REDO") {
        this.redo();
        return;
      }
      const next = reduce(present, a);
      if (a.meta?.record !== false && next !== present) {
        past.push(present);
        if (past.length > 100) past.shift();
        future.length = 0;
      }
      present = next;
    },
    undo() {
      const prev = past.pop();
      if (!prev) return;
      future.push(present);
      present = prev;
    },
    redo() {
      const next = future.pop();
      if (!next) return;
      past.push(present);
      present = next;
    },
    reset(s: TracksState) {
      past.length = 0;
      future.length = 0;
      present = s;
    },
  };
}

export function useHistory(initial: TracksState): History {
  const [present, setPresent] = useState<TracksState>(initial);
  const pastRef = useRef<TracksState[]>([]);
  const futureRef = useRef<TracksState[]>([]);

  const dispatch = useCallback((a: Action) => {
    if (a.type === "UNDO") {
      undo();
      return;
    }
    if (a.type === "REDO") {
      redo();
      return;
    }
    setPresent((curr) => {
      const next = reduce(curr, a);
      if (a.meta?.record !== false && next !== curr) {
        pastRef.current.push(curr);
        if (pastRef.current.length > 100) pastRef.current.shift();
        futureRef.current = [];
      }
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    setPresent((curr) => {
      const prev = pastRef.current.pop();
      if (!prev) return curr;
      futureRef.current.push(curr);
      return prev;
    });
  }, []);

  const redo = useCallback(() => {
    setPresent((curr) => {
      const next = futureRef.current.pop();
      if (!next) return curr;
      pastRef.current.push(curr);
      return next;
    });
  }, []);

  const reset = useCallback((s: TracksState) => {
    pastRef.current = [];
    futureRef.current = [];
    setPresent(s);
  }, []);

  return {
    present,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
    dispatch,
    undo,
    redo,
    reset,
  };
}
