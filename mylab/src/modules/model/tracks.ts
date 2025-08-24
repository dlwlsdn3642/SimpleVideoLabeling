import type { RectPX, Track } from "../../types";

export type TracksState = Track[];

type Meta = { meta?: { record?: boolean } };

export type Action =
  | ({ type: "ADD_KF"; trackId: string; f: number; rect: RectPX } & Meta)
  | ({ type: "DEL_KF"; trackId: string; f: number } & Meta)
  | ({
      type: "MOVE_RECT";
      trackId: string;
      f: number;
      delta: { dx: number; dy: number };
    } & Meta)
  | ({ type: "TOGGLE_PRESENCE"; trackId: string; f: number } & Meta)
  | ({ type: "APPLY_TRACKS"; payload: TracksState } & Meta)
  | ({ type: "UNDO" } & Meta)
  | ({ type: "REDO" } & Meta);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export function reduce(state: TracksState, action: Action): TracksState {
  switch (action.type) {
    case "ADD_KF": {
      const { trackId, f, rect } = action;
      return state.map((t) => {
        if (t.track_id !== trackId) return t;
        const kf = {
          frame: f,
          bbox_xywh: [rect.x, rect.y, rect.w, rect.h] as [
            number,
            number,
            number,
            number,
          ],
        };
        const keyframes = [...t.keyframes];
        const idx = keyframes.findIndex((k) => k.frame === f);
        if (idx >= 0) keyframes[idx] = kf;
        else
          keyframes.splice(
            keyframes.findIndex((k) => k.frame > f),
            0,
            kf,
          );
        return { ...t, keyframes };
      });
    }
    case "DEL_KF": {
      const { trackId, f } = action;
      return state.map((t) => {
        if (t.track_id !== trackId) return t;
        return { ...t, keyframes: t.keyframes.filter((k) => k.frame !== f) };
      });
    }
    case "MOVE_RECT": {
      const { trackId, f, delta } = action;
      return state.map((t) => {
        if (t.track_id !== trackId) return t;
        const keyframes = t.keyframes.map((k) =>
          k.frame === f
            ? {
                ...k,
                bbox_xywh: [
                  k.bbox_xywh[0] + delta.dx,
                  k.bbox_xywh[1] + delta.dy,
                  k.bbox_xywh[2],
                  k.bbox_xywh[3],
                ] as [number, number, number, number],
              }
            : k,
        );
        return { ...t, keyframes };
      });
    }
    case "TOGGLE_PRESENCE": {
      const { trackId, f } = action;
      return state.map((t) => {
        if (t.track_id !== trackId) return t;
        const keyframes = t.keyframes.map((k) =>
          k.frame === f ? { ...k, absent: !k.absent } : k,
        );
        return { ...t, keyframes };
      });
    }
    case "APPLY_TRACKS":
      return clone(action.payload);
    default:
      return state;
  }
}
