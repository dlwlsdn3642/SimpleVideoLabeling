import { describe, it, expect } from "vitest";
import { reduce } from "./tracks";
import type { TracksState } from "./tracks";
import { createHistory } from "./history";

const baseTrack = { track_id: "t1", class_id: 0, keyframes: [] as any[] };

describe("tracks reducer", () => {
  it("adds and removes keyframes", () => {
    let state: TracksState = [baseTrack];
    state = reduce(state, {
      type: "ADD_KF",
      trackId: "t1",
      f: 0,
      rect: { x: 1, y: 2, w: 3, h: 4 },
    });
    expect(state[0].keyframes).toHaveLength(1);
    state = reduce(state, { type: "DEL_KF", trackId: "t1", f: 0 });
    expect(state[0].keyframes).toHaveLength(0);
  });

  it("supports undo and redo", () => {
    const h = createHistory([baseTrack]);
    h.dispatch({
      type: "ADD_KF",
      trackId: "t1",
      f: 0,
      rect: { x: 0, y: 0, w: 1, h: 1 },
      meta: { record: true },
    });
    expect(h.present[0].keyframes).toHaveLength(1);
    h.undo();
    expect(h.present[0].keyframes).toHaveLength(0);
    h.redo();
    expect(h.present[0].keyframes).toHaveLength(1);
  });
});
