import { useRef, useState } from "react";
import type { Handle, IndexMeta, RectPX, Track } from "../types";
import { clamp, rectAtFrame, handleAt, uuid } from "../utils/geom";

interface Options {
  meta: IndexMeta | null;
  frame: number;
  tracks: Track[];
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  selectedTracks: Track[];
  interpolate: boolean;
  applyTracks: (updater: (ts: Track[]) => Track[], record?: boolean) => void;
  historyRef: React.MutableRefObject<Track[][]>;
  futureRef: React.MutableRefObject<Track[][]>;
  scale: number;
  curClass: number;
}

export default function useViewportInteraction({
  meta,
  frame,
  tracks,
  selectedIds,
  setSelectedIds,
  selectedTracks,
  interpolate,
  applyTracks,
  historyRef,
  futureRef,
  scale,
  curClass,
}: Options) {
  const [dragHandle, setDragHandle] = useState<Handle>("none");
  const [hoverHandle, setHoverHandle] = useState<Handle>("none");
  const [shiftHeld, setShiftHeld] = useState(false);
  const dragRef = useRef<{
    mx: number;
    my: number;
    origRects?: Map<string, RectPX>;
    creating?: boolean;
    tempRect?: RectPX;
    multi?: boolean;
    historyPushed?: boolean;
  }>({ mx: 0, my: 0 });
  const [draftRect, setDraftRect] = useState<RectPX | null>(null);

  const handleCursor = (h: Handle, dragging = false): string => {
    if (dragging && h === "move") return "grabbing";
    switch (h) {
      case "move":
        return "grab";
      case "n":
      case "s":
        return "ns-resize";
      case "e":
      case "w":
        return "ew-resize";
      case "ne":
      case "sw":
        return "nesw-resize";
      case "nw":
      case "se":
        return "nwse-resize";
      default:
        return "crosshair";
    }
  };

  const toImgCoords = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = (ev.target as HTMLCanvasElement).getBoundingClientRect();
    return {
      mx: (ev.clientX - rect.left) / scale,
      my: (ev.clientY - rect.top) / scale,
    };
  };

  function ensureKFAt(t: Track, f: number, r: RectPX): Track {
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

  const onMouseDown = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (!meta) return;
    const { mx, my } = toImgCoords(ev);
    let hitTrack: Track | null = null;
    let handle: Handle = "none";
    let rect: RectPX | null = null;
    for (let i = tracks.length - 1; i >= 0; i--) {
      const t = tracks[i];
      if (t.hidden) continue;
      const r = rectAtFrame(t, frame, interpolate);
      if (!r) continue;
      const h = handleAt(r, mx, my);
      if (h !== "none") {
        hitTrack = t;
        handle = h;
        rect = r;
        break;
      }
    }
    if (hitTrack && rect) {
      const multi = ev.altKey && selectedIds.size > 1 && handle === "move";
      if (ev.ctrlKey || ev.metaKey) {
        setSelectedIds((prev) => {
          const n = new Set(prev);
          if (n.has(hitTrack!.track_id)) n.delete(hitTrack!.track_id);
          else n.add(hitTrack!.track_id);
          return n;
        });
      } else if (!selectedIds.has(hitTrack.track_id)) {
        setSelectedIds(new Set([hitTrack.track_id]));
      }
      setDragHandle(handle);
      const origRects = new Map<string, RectPX>();
      const group = multi ? selectedTracks : [hitTrack];
      for (const st of group) {
        const rr = rectAtFrame(st, frame, interpolate);
        if (rr) origRects.set(st.track_id, rr);
      }
      dragRef.current = {
        mx,
        my,
        origRects,
        creating: false,
        tempRect: undefined,
        multi,
        historyPushed: false,
      };
    } else if (ev.shiftKey) {
      const temp: RectPX = { x: mx, y: my, w: 1, h: 1 };
      dragRef.current = {
        mx,
        my,
        creating: true,
        tempRect: temp,
        multi: false,
        historyPushed: false,
      };
      setDraftRect(temp);
      setDragHandle("se");
    } else {
      setDragHandle("none");
      setHoverHandle("none");
    }
  };

  const onMouseMove = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (!meta) return;
    const { mx, my } = toImgCoords(ev);
    if (dragHandle === "none") {
      let h: Handle = "none";
      for (let i = tracks.length - 1; i >= 0; i--) {
        const t = tracks[i];
        if (t.hidden) continue;
        const r = rectAtFrame(t, frame, interpolate);
        if (!r) continue;
        h = handleAt(r, mx, my);
        if (h !== "none") break;
      }
      setHoverHandle(h);
      return;
    }
    const dx = mx - dragRef.current.mx,
      dy = my - dragRef.current.my;
    if (dragRef.current.creating && dragRef.current.tempRect) {
      const x1 = dragRef.current.mx,
        y1 = dragRef.current.my,
        x2 = mx,
        y2 = my;
      let nx = Math.min(x1, x2),
        ny = Math.min(y1, y2);
      const nw = Math.max(2, Math.abs(x2 - x1)),
        nh = Math.max(2, Math.abs(y2 - y1));
      nx = clamp(nx, 0, meta.width - nw);
      ny = clamp(ny, 0, meta.height - nh);
      const nr = { x: nx, y: ny, w: nw, h: nh };
      dragRef.current.tempRect = nr;
      setDraftRect(nr);
      return;
    }
    const { origRects, multi, historyPushed } = dragRef.current;
    if (!origRects || origRects.size === 0) return;
    if (!historyPushed) {
      historyRef.current.push(JSON.parse(JSON.stringify(tracks)));
      if (historyRef.current.length > 100) historyRef.current.shift();
      futureRef.current = [];
      dragRef.current.historyPushed = true;
    }
    applyTracks((ts) => {
      const map = new Map(ts.map((t) => [t.track_id, t]));
      const apply = (tid: string, r: RectPX) => {
        const t = map.get(tid);
        if (!t) return;
        map.set(tid, ensureKFAt(t, frame, r));
      };
      if (multi && dragHandle === "move") {
        for (const [tid, orig] of origRects.entries()) {
          const rx = clamp(orig.x + dx, 0, meta.width - orig.w);
          const ry = clamp(orig.y + dy, 0, meta.height - orig.h);
          apply(tid, { x: rx, y: ry, w: orig.w, h: orig.h });
        }
        return Array.from(map.values());
      }
      const firstEntry = origRects.entries().next();
      if (firstEntry.done) return ts;
      const [tid, orig] = firstEntry.value as [string, RectPX];
      const minW = 2,
        minH = 2;
      let r: RectPX = { ...orig };
      const applyMove = () => {
        r.x = clamp(orig.x + dx, 0, meta.width - r.w);
        r.y = clamp(orig.y + dy, 0, meta.height - r.h);
      };
      const applyResize = (side: Handle) => {
        let x1 = orig.x,
          y1 = orig.y,
          x2 = orig.x + orig.w,
          y2 = orig.y + orig.h;
        const mx2 = clamp(orig.x + orig.w + dx, 0, meta.width);
        const my2 = clamp(orig.y + orig.h + dy, 0, meta.height);
        const mx1 = clamp(orig.x + dx, 0, meta.width);
        const my1 = clamp(orig.y + dy, 0, meta.height);
        if (side.includes("e")) x2 = mx2;
        if (side.includes("s")) y2 = my2;
        if (side.includes("w")) x1 = mx1;
        if (side.includes("n")) y1 = my1;
        let nx = Math.min(x1, x2),
          ny = Math.min(y1, y2);
        const nw = Math.max(minW, Math.abs(x2 - x1)),
          nh = Math.max(minH, Math.abs(y2 - y1));
        nx = clamp(nx, 0, meta.width - nw);
        ny = clamp(ny, 0, meta.height - nh);
        r = { x: nx, y: ny, w: nw, h: nh };
      };
      if (dragHandle === "move") applyMove();
      else applyResize(dragHandle);
      apply(tid, r);
      return Array.from(map.values());
    });
  };

  const onMouseUp = () => {
    if (dragRef.current.creating && dragRef.current.tempRect && meta) {
      const rect = dragRef.current.tempRect;
      const t: Track = {
        track_id: `t_${uuid()}`,
        class_id: curClass,
        name: `T${tracks.length + 1}`,
        keyframes: [{ frame, bbox_xywh: [rect.x, rect.y, rect.w, rect.h] }],
      };
      applyTracks((ts) => [...ts, t], true);
      setSelectedIds(new Set([t.track_id]));
    }
    setDragHandle("none");
    setHoverHandle("none");
    setDraftRect(null);
    dragRef.current = { mx: 0, my: 0 };
  };

  return {
    dragHandle,
    hoverHandle,
    shiftHeld,
    setShiftHeld,
    draftRect,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    handleCursor,
  };
}
