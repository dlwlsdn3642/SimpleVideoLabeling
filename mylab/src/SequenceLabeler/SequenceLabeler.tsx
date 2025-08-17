import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_SCHEMA, DEFAULT_VERSION } from "../constants";
import LRUFrames from "../lib/LRUFrames";
import Timeline from "../components/Timeline";
import TrackPanel from "../components/TrackPanel";
import ShortcutModal from "../components/ShortcutModal";
import type { IndexMeta, RectPX, Track, LabelSet, KeyMap, LocalFile, Handle } from "../types";
import {
  clamp, pad, uuid, rectAtFrame, handleAt,
  findKFIndexAtOrBefore
} from "../utils/geom";
import { eventToKeyString, normalizeKeyString } from "../utils/keys";

const SequenceLabeler: React.FC<{
  framesBaseUrl: string;
  indexUrl: string;
  taskId?: string;
  initialLabelSetName?: string;
  defaultClasses: string[];
  prefetchRadius?: number;
  ghostAlpha?: number;
}> = ({
  framesBaseUrl,
  indexUrl,
  taskId,
  initialLabelSetName = "Default",
  defaultClasses,
  prefetchRadius = 8,
  ghostAlpha = 0.35
}) => {
  // media
  const [meta, setMeta] = useState<IndexMeta | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [localFiles] = useState<LocalFile[] | null>(null);
  const [frame, setFrame] = useState(0);
  const [scale, setScale] = useState(1);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const [scaleMax, setScaleMax] = useState(3);
  const cacheRef = useRef(new LRUFrames(prefetchRadius * 3));
  const [playing, setPlaying] = useState(false);

  // labels
  const [labelSet, setLabelSet] = useState<LabelSet>({ name: initialLabelSetName, classes: defaultClasses });
  const [availableSets, setAvailableSets] = useState<LabelSet[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [interpolate, setInterpolate] = useState(true);

  // selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectedTracks = useMemo(() => tracks.filter(t => selectedIds.has(t.track_id)), [tracks, selectedIds]);
  const oneSelected = selectedTracks[0] ?? null;

  // editing
  const [dragHandle, setDragHandle] = useState<Handle>("none");
  const [hoverHandle, setHoverHandle] = useState<Handle>("none");
  const dragRef = useRef<{ mx: number; my: number; origRects?: Map<string, RectPX>; creating?: boolean; tempRect?: RectPX; multi?: boolean }>({ mx: 0, my: 0 });
  const [draftRect, setDraftRect] = useState<RectPX | null>(null);
  const handleCursor = (h: Handle, dragging = false): string => {
    if (dragging && h === "move") return "grabbing";
    switch (h) {
      case "move": return "grab";
      case "n":
      case "s": return "ns-resize";
      case "e":
      case "w": return "ew-resize";
      case "ne":
      case "sw": return "nesw-resize";
      case "nw":
      case "se": return "nwse-resize";
      default: return "crosshair";
    }
  };

  // keymap
  const DEFAULT_KEYMAP: KeyMap = {
    "frame_prev": "ArrowLeft",
    "frame_next": "ArrowRight",
    "frame_prev10": "Shift+ArrowLeft",
    "frame_next10": "Shift+ArrowRight",
    "frame_prev100": "Ctrl+ArrowLeft",
    "frame_next100": "Ctrl+ArrowRight",
    "toggle_play": "Space",
    "kf_add": "k",
    "kf_del": "Shift+k",
    "kf_prev": ",",
    "kf_next": ".",
    "toggle_interpolate": "i",
    "toggle_presence": "n",
    "copy_tracks": "Ctrl+c",
    "paste_tracks": "Ctrl+v"
  };
  const storagePrefix = taskId ?? indexUrl;
  const [keymap, setKeymap] = useState<KeyMap>(() => {
    const raw = localStorage.getItem(`${storagePrefix}::keymap_v2`);
    return raw ? JSON.parse(raw) : DEFAULT_KEYMAP;
  });
  const [keyUIOpen, setKeyUIOpen] = useState(false);
  const [recordingAction, setRecordingAction] = useState<string | null>(null);

  // layout refs for timeline width
  const timelineWrapRef = useRef<HTMLDivElement | null>(null);
  const [timelineWidth, setTimelineWidth] = useState<number>(800);

  /** ===== Restore & Load ===== */
  useEffect(() => {
    const raw = localStorage.getItem(`${storagePrefix}::autosave_v2`);
    if (raw) {
      try {
        const s = JSON.parse(raw);
        if (s.labelSet) setLabelSet(s.labelSet);
        if (s.tracks) setTracks(s.tracks);
        if (typeof s.frame === "number") setFrame(s.frame);
        if (typeof s.interpolate === "boolean") setInterpolate(s.interpolate);
      } catch (err) {
        console.error(err);
      }
    }
  }, [storagePrefix]);

  useEffect(() => {
    let aborted = false;
    (async () => {
      try {
        const r = await fetch(indexUrl);
        if (!r.ok) throw new Error(`index fetch ${r.status}`);

        const raw = await r.text();
        let m: IndexMeta;
        try {
          m = JSON.parse(raw) as IndexMeta;
        } catch (err) {
          console.error("index meta parse error", err);
          return;
        }
        if (aborted) return;
        setMeta(m);
        if (m.files?.length) setFiles(m.files);
        else {
          const padW = m.zeroPad ?? Math.max(6, String(Math.max(0, m.count - 1)).length);
          const ext = m.ext ?? "webp";
          setFiles(Array.from({ length: m.count }, (_, i) => `frame_${pad(i, padW)}.${ext}`));
        }
        setTimeout(() => {
          if (!canvasWrapRef.current || !m) return;
          const { width } = canvasWrapRef.current.getBoundingClientRect();
          const max = width / m.width;
          setScale(Math.min(1, max));
        }, 0);
      } catch (err) {
        console.error(err);
      }
    })();
    return () => { aborted = true; };
  }, [indexUrl]);

  useEffect(() => {
    const raw = localStorage.getItem("sequence_label_sets_v1");
    if (raw) {
      try {
        setAvailableSets(JSON.parse(raw));
      } catch (err) {
        console.error(err);
      }
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      localStorage.setItem(`${storagePrefix}::autosave_v2`, JSON.stringify({
        schema: DEFAULT_SCHEMA, version: DEFAULT_VERSION,
        meta, labelSet, tracks, frame, interpolate
      }));
    }, 300);
    return () => clearTimeout(t);
  }, [meta, labelSet, tracks, frame, interpolate, storagePrefix]);

  // observe timeline width
  useEffect(() => {
    if (!timelineWrapRef.current) return;
    const el = timelineWrapRef.current;
    const ro = new ResizeObserver(entries => {
      const cr = entries[0].contentRect;
      setTimelineWidth(Math.max(300, cr.width - 24)); // padding 12*2
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // observe canvas container size to enforce scale limits
  useEffect(() => {
    if (!meta || !canvasWrapRef.current) return;
    const el = canvasWrapRef.current;
    const update = () => {
      const { width, height } = el.getBoundingClientRect();
      const max = Math.max(0.1, Math.min(3, width / meta.width, height / meta.height));
      setScaleMax(max);
      setScale(s => Math.min(s, max));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [meta]);

  /** ===== Image loading ===== */
  const getImage = useCallback(async (idx: number): Promise<ImageBitmap | null> => {
    if (!meta) return null;
    const total = localFiles ? localFiles.length : files.length;
    if (idx < 0 || idx >= total) return null;

    const cached = cacheRef.current.get(idx);
    if (cached) return cached;

    try {
      if (localFiles) {
        const file = await localFiles[idx].handle.getFile();
        const bmp = await createImageBitmap(file);
        cacheRef.current.set(idx, bmp);
        return bmp;
      } else {
        const url = `${framesBaseUrl}/${files[idx]}`;
        const res = await fetch(url, { cache: "force-cache" });
        if (!res.ok) throw new Error(`image fetch ${res.status}`);
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        cacheRef.current.set(idx, bmp);
        return bmp;
      }
    } catch {
      return null;
    }
  }, [meta, files, framesBaseUrl, localFiles]);

  // prefetch around current frame
  useEffect(() => {
    (async () => {
      const total = localFiles ? localFiles.length : files.length;
      if (!meta || total <= 0) return;
      const tasks: Promise<HTMLImageElement | null>[] = [];
      for (let d = -prefetchRadius; d <= prefetchRadius; d++) {
        const i = frame + d; if (i < 0 || i >= total) continue;
        if (cacheRef.current.has(i)) continue;
        tasks.push(getImage(i).catch(() => null));
      }
      await Promise.allSettled(tasks);
    })();
  }, [frame, meta, files.length, localFiles, getImage, prefetchRadius]);

  /** ===== Canvas size: update only when meta/scale changes (prevents flicker) ===== */
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !meta) return;
    const W = Math.round(meta.width * scale);
    const H = Math.round(meta.height * scale);
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
  }, [meta, scale]);

  /** ===== Drawing ===== */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const c = canvasRef.current; if (!c || !meta) return;
      const ctx = c.getContext("2d"); if (!ctx) return;

      const bmpInCache = cacheRef.current.has(frame);
      const bmp = bmpInCache ? cacheRef.current.get(frame) : await getImage(frame);
      if (cancelled || !bmp) return;

      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#111"; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);

      const drawRect = (r: RectPX, color = "#00e5ff", alpha = 1, dashed = false) => {
        const x = r.x * scale, y = r.y * scale, w = r.w * scale, h = r.h * scale;
        ctx.save(); ctx.globalAlpha = alpha; ctx.setLineDash(dashed ? [6, 6] : []);
        ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.strokeRect(x, y, w, h);
        const hs = 6; ctx.fillStyle = color;
        const dots = [[x, y], [x + w, y], [x, y + h], [x + w, y + h], [x + w / 2, y], [x + w / 2, y + h], [x, y + h / 2], [x + w, y + h / 2]];
        for (const [dx, dy] of dots) ctx.fillRect(dx - hs, dy - hs, hs * 2, hs * 2);
        ctx.restore();
      };

      // ghosts
      for (const t of tracks) {
        if (t.hidden) continue;
        const prev = rectAtFrame(t, frame - 1, interpolate);
        if (prev) drawRect(prev, "#9cf", ghostAlpha, true);
        const next = rectAtFrame(t, frame + 1, interpolate);
        if (next) drawRect(next, "#fc9", ghostAlpha, true);
      }

      // current rects
      for (const t of tracks) {
        if (t.hidden) continue;
        const r = rectAtFrame(t, frame, interpolate);
        if (!r) continue;
        const isSel = selectedIds.has(t.track_id);
        drawRect(r, isSel ? "#00e5ff" : "#66d9ef", 1, false);

        // tag
        ctx.save();
        const cls = labelSet.classes[t.class_id] ?? t.class_id;
        const tag = `${cls}${t.name ? ` (${t.name})` : ""}`;
        ctx.font = "12px monospace";
        const x = r.x * scale, y = r.y * scale, w = ctx.measureText(tag).width + 8;
        ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(x, y - 18, w, 18);
        ctx.fillStyle = "#fff"; ctx.fillText(tag, x + 4, y - 5);
        ctx.restore();
      }
      if (dragRef.current.creating && draftRect) {
        const x = draftRect.x * scale, y = draftRect.y * scale,
          w = draftRect.w * scale, h = draftRect.h * scale;
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#fff";
        ctx.strokeRect(x, y, w, h);
        const label = `${Math.round(draftRect.w)}×${Math.round(draftRect.h)}`;
        ctx.font = "12px monospace";
        const tw = ctx.measureText(label).width + 6;
        const th = 16;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(x + w - tw, y + h + 4, tw, th);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, x + w - tw + 3, y + h + 16);
        ctx.restore();
      }
    })();
    return () => { cancelled = true; };
  }, [frame, tracks, selectedIds, labelSet.classes, interpolate, ghostAlpha, meta, getImage, scale, draftRect]);

  /** ===== Keyboard ===== */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (recordingAction) {
        const s = eventToKeyString(e);
        if (s) {
          setKeymap(m => ({ ...m, [recordingAction]: normalizeKeyString(s) }));
          setRecordingAction(null);
        }
        e.preventDefault();
        return;
      }
      if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName ?? "")) return;

      const keyStr = normalizeKeyString(eventToKeyString(e) ?? "");
      const match = (action: string) => keymap[action] && normalizeKeyString(keymap[action]) === keyStr;

      const total = localFiles ? localFiles.length : files.length;

      if (match("frame_prev")) { setFrame(f => clamp(f - 1, 0, total - 1)); e.preventDefault(); }
      else if (match("frame_next")) { setFrame(f => clamp(f + 1, 0, total - 1)); e.preventDefault(); }
      else if (match("frame_prev10")) setFrame(f => clamp(f - 10, 0, total - 1));
      else if (match("frame_next10")) setFrame(f => clamp(f + 10, 0, total - 1));
      else if (match("frame_prev100")) setFrame(f => clamp(f - 100, 0, total - 1));
      else if (match("frame_next100")) setFrame(f => clamp(f + 100, 0, total - 1));
      else if (match("toggle_play")) { setPlaying(p => !p); e.preventDefault(); }
      else if (match("kf_add")) addKeyframeAtCurrent();
      else if (match("kf_del")) deleteKeyframeAtCurrent();
      else if (match("kf_prev")) gotoPrevKeyframe();
      else if (match("kf_next")) gotoNextKeyframe();
      else if (match("toggle_interpolate")) setInterpolate(v => !v);
      else if (match("toggle_presence")) togglePresenceAtCurrent();
      else if (match("copy_tracks")) copySelectedTracks();
      else if (match("paste_tracks")) pasteTracks();
      else {
        if (/^\d$/.test(e.key) && e.key !== "0") {
          const idx = parseInt(e.key, 10) - 1;
          if (labelSet.classes[idx]) setCurClass(idx);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keymap, files.length, localFiles, labelSet.classes, recordingAction, selectedIds]);

  /** ===== Playback ===== */
  useEffect(() => {
    if (!playing) return;
    let raf = 0; let last = performance.now();
    const fps = meta?.fps ?? 30; const dur = 1000 / fps;
    const total = localFiles ? localFiles.length : files.length;
    const loop = () => {
      const now = performance.now();
      if (now - last >= dur) {
        setFrame(f => (f + 1 < total ? f + 1 : 0));
        last = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, meta?.fps, files.length, localFiles]);

  /** ===== Mouse (edit) ===== */
  const toImgCoords = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = (ev.target as HTMLCanvasElement).getBoundingClientRect();
    return { mx: (ev.clientX - rect.left) / scale, my: (ev.clientY - rect.top) / scale };
  };
  function ensureKFAt(t: Track, f: number, r: RectPX): Track {
    const kfs = [...t.keyframes];
    const idx = kfs.findIndex(k => k.frame === f);
    const kf = { frame: f, bbox_xywh: [r.x, r.y, r.w, r.h] as [number, number, number, number] };
    if (idx >= 0) kfs[idx] = kf; else { kfs.push(kf); kfs.sort((a, b) => a.frame - b.frame); }
    return { ...t, keyframes: kfs };
  }
  const [curClass, setCurClass] = useState(0);

  const onMouseDown = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (!meta) return;
    const { mx, my } = toImgCoords(ev);

    // hit-test visible rects (top-most)
    let hitTrack: Track | null = null; let handle: Handle = "none"; let rect: RectPX | null = null;
    for (let i = tracks.length - 1; i >= 0; i--) {
      const t = tracks[i]; if (t.hidden) continue;
      const r = rectAtFrame(t, frame, interpolate); if (!r) continue;
      const h = handleAt(r, mx, my);
      if (h !== "none") { hitTrack = t; handle = h; rect = r; break; }
    }

    if (hitTrack && rect) {
      const multi = ev.altKey && selectedIds.size > 1 && handle === "move";

      // Ctrl/Cmd 클릭으로 선택 토글
      if (ev.ctrlKey || ev.metaKey) {
        setSelectedIds(prev => {
          const n = new Set(prev);
          if (n.has(hitTrack!.track_id)) n.delete(hitTrack!.track_id); else n.add(hitTrack!.track_id);
          return n;
        });
      } else if (!selectedIds.has(hitTrack.track_id)) {
        setSelectedIds(new Set([hitTrack.track_id]));
      }

      setDragHandle(handle);

      // 선택된 트랙들의 현재 프레임 rect 스냅샷
      const origRects = new Map<string, RectPX>();
      const group = multi ? selectedTracks : [hitTrack];
      for (const st of group) {
        const rr = rectAtFrame(st, frame, interpolate);
        if (rr) origRects.set(st.track_id, rr);
      }
      dragRef.current = { mx, my, origRects, creating: false, tempRect: undefined, multi };
    } else {
      // 새 트랙 생성 드래그 시작
      const temp: RectPX = { x: mx, y: my, w: 1, h: 1 };
      dragRef.current = { mx, my, creating: true, tempRect: temp, multi: false };
      setDraftRect(temp);
      setDragHandle("se");
    }
  };

  const onMouseMove = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (!meta) return;
    const { mx, my } = toImgCoords(ev);
    if (dragHandle === "none") {
      let h: Handle = "none";
      for (let i = tracks.length - 1; i >= 0; i--) {
        const t = tracks[i]; if (t.hidden) continue;
        const r = rectAtFrame(t, frame, interpolate); if (!r) continue;
        h = handleAt(r, mx, my); if (h !== "none") break;
      }
      setHoverHandle(h);
      return;
    }
    const dx = mx - dragRef.current.mx, dy = my - dragRef.current.my;

    // 새 트랙 드래그 중
    if (dragRef.current.creating && dragRef.current.tempRect) {
      const x1 = dragRef.current.mx, y1 = dragRef.current.my, x2 = mx, y2 = my;
      let nx = Math.min(x1, x2), ny = Math.min(y1, y2);
      const nw = Math.max(2, Math.abs(x2 - x1)), nh = Math.max(2, Math.abs(y2 - y1));
      nx = clamp(nx, 0, meta.width - nw); ny = clamp(ny, 0, meta.height - nh);
      const nr = { x: nx, y: ny, w: nw, h: nh };
      dragRef.current.tempRect = nr;
      setDraftRect(nr);
      return;
    }

    // 기존 편집: origRects가 없으면 안전하게 종료
    const { origRects, multi } = dragRef.current;
    if (!origRects || origRects.size === 0) return;

    setTracks(ts => {
      const map = new Map(ts.map(t => [t.track_id, t]));

      const apply = (tid: string, r: RectPX) => {
        const t = map.get(tid);
        if (!t) return;
        map.set(tid, ensureKFAt(t, frame, r));
      };

      // 다중 이동 (move만 허용)
      if (multi && dragHandle === "move") {
        for (const [tid, orig] of origRects.entries()) {
          const rx = clamp(orig.x + dx, 0, meta.width - orig.w);
          const ry = clamp(orig.y + dy, 0, meta.height - orig.h);
          apply(tid, { x: rx, y: ry, w: orig.w, h: orig.h });
        }
        return Array.from(map.values());
      }

      // 단일 편집: 첫 엔트리 가져오기 (없으면 종료)
      const firstEntry = origRects.entries().next();
      if (firstEntry.done) return ts;
      const [tid, orig] = firstEntry.value as [string, RectPX];

      const minW = 2, minH = 2;
      let r: RectPX = { ...orig };

      const applyMove = () => {
        r.x = clamp(orig.x + dx, 0, meta.width - r.w);
        r.y = clamp(orig.y + dy, 0, meta.height - r.h);
      };
      const applyResize = (side: Handle) => {
        let x1 = orig.x, y1 = orig.y, x2 = orig.x + orig.w, y2 = orig.y + orig.h;
        const mx2 = clamp(orig.x + orig.w + dx, 0, meta.width);
        const my2 = clamp(orig.y + orig.h + dy, 0, meta.height);
        const mx1 = clamp(orig.x + dx, 0, meta.width);
        const my1 = clamp(orig.y + dy, 0, meta.height);
        if (side.includes("e")) x2 = mx2; if (side.includes("s")) y2 = my2;
        if (side.includes("w")) x1 = mx1; if (side.includes("n")) y1 = my1;
        let nx = Math.min(x1, x2), ny = Math.min(y1, y2);
        const nw = Math.max(minW, Math.abs(x2 - x1)), nh = Math.max(minH, Math.abs(y2 - y1));
        nx = clamp(nx, 0, meta.width - nw); ny = clamp(ny, 0, meta.height - nh);
        r = { x: nx, y: ny, w: nw, h: nh };
      };

      if (dragHandle === "move") applyMove(); else applyResize(dragHandle);
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
        presence_toggles: []
      };
      setTracks(ts => [...ts, t]);
      setSelectedIds(new Set([t.track_id]));
    }
    setDragHandle("none");
    setHoverHandle("none");
    setDraftRect(null);
    dragRef.current = { mx: 0, my: 0 };
  };

  /** ===== KF / Presence ops ===== */
  function addKeyframeAtCurrent() {
    if (!oneSelected) return;
    const r = rectAtFrame(oneSelected, frame, interpolate);
    if (!r) return;
    setTracks(ts => ts.map(t => t.track_id === oneSelected.track_id ? ensureKFAt(t, frame, r) : t));
  }
  function deleteKeyframeAtCurrent() {
    if (!oneSelected) return;
    setTracks(ts => ts.map(t => {
      if (t.track_id !== oneSelected.track_id) return t;
      const kfs = t.keyframes.filter(k => k.frame !== frame);
      return { ...t, keyframes: kfs };
    }));
  }
  function gotoPrevKeyframe() {
    if (!oneSelected) return;
    const kfs = oneSelected.keyframes;
    const idx = findKFIndexAtOrBefore(kfs, frame);
    const prev = (idx > 0) ? kfs[idx - 1].frame : (idx === 0 ? kfs[0].frame : 0);
    setFrame(prev);
  }
  function gotoNextKeyframe() {
    if (!oneSelected) return;
    const kfs = oneSelected.keyframes;
    const idx = findKFIndexAtOrBefore(kfs, frame);
    // If no keyframe exists at or before the current frame (idx === -1),
    // jump to the first keyframe instead of wrapping to the last.
    // Otherwise move to the next keyframe, or stay on the last one if already there.
    const next = (idx === -1)
      ? kfs[0].frame
      : (idx < kfs.length - 1 ? kfs[idx + 1].frame : kfs[kfs.length - 1].frame);
    setFrame(next);
  }
  function togglePresenceAtCurrent() {
    if (!selectedTracks.length) return;
    setTracks(ts => ts.map(t => {
      if (!selectedIds.has(t.track_id)) return t;
      const arr = [...t.presence_toggles];
      const i = arr.indexOf(frame);
      if (i >= 0) arr.splice(i, 1); else { arr.push(frame); arr.sort((a, b) => a - b); }
      return { ...t, presence_toggles: arr };
    }));
  }

  /** ===== Export ===== */
  function exportJSON() {
    if (!meta) return;
    const total = localFiles ? localFiles.length : files.length;
    const out = {
      schema: DEFAULT_SCHEMA,
      version: DEFAULT_VERSION,
      meta: { width: meta.width, height: meta.height, fps: meta.fps ?? 30, count: total },
      label_set: labelSet,
      files: localFiles ? localFiles.map(f => f.name) : files,
      tracks: tracks.map(t => ({
        track_id: t.track_id,
        class_id: t.class_id,
        name: t.name,
        keyframes: t.keyframes.map(k => ({ frame: k.frame, bbox_xywh: k.bbox_xywh })),
        presence_toggles: t.presence_toggles
      }))
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "labels_v1.json"; a.click();
    URL.revokeObjectURL(url);
  }

  async function exportYOLO() {
    if (!meta) return;
    if (!('showDirectoryPicker' in window)) {
      alert('Chromium 계열 브라우저에서 사용하세요.');
      return;
    }
    const dir: FileSystemDirectoryHandle = await (window as unknown as {
      showDirectoryPicker: (opts: { id: string }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker({ id: 'yolo-export' });
    const total = localFiles ? localFiles.length : files.length;
    const names = localFiles ? localFiles.map(f => f.name) : files;

    const perFrame: string[][] = Array.from({ length: total }, () => []);
    for (const t of tracks) {
      for (let f = 0; f < total; f++) {
        const r = rectAtFrame(t, f, interpolate);
        if (!r) continue;
        const cx = (r.x + r.w / 2) / meta.width;
        const cy = (r.y + r.h / 2) / meta.height;
        const ww = r.w / meta.width;
        const hh = r.h / meta.height;
        perFrame[f].push(`${t.class_id} ${cx.toFixed(6)} ${cy.toFixed(6)} ${ww.toFixed(6)} ${hh.toFixed(6)}`);
      }
    }
    for (let i = 0; i < total; i++) {
      if (!perFrame[i].length) continue;
      const base = names[i].replace(/\.[^.]+$/, "");
      const handle = await dir.getFileHandle(`${base}.txt`, { create: true });
      const w = await handle.createWritable();
      await w.write(perFrame[i].join("\n") + "\n"); await w.close();
    }
    alert("YOLO 내보내기 완료");
  }

  /** ===== RAF-throttled seek for timeline ===== */
  const seekRaf = useRef<number | null>(null);
  const pendingSeek = useRef<number | null>(null);
  const scheduleSeek = (f: number) => {
    pendingSeek.current = f;
    if (seekRaf.current != null) return;
    seekRaf.current = requestAnimationFrame(() => {
      if (pendingSeek.current != null) setFrame(pendingSeek.current);
      pendingSeek.current = null;
      seekRaf.current = null;
    });
  };

  const totalFrames = localFiles ? localFiles.length : files.length;

  return (
    <div ref={containerRef} style={{ display: "grid", gridTemplateRows: "auto 1fr auto auto", height: "100%", background: "#0b0b0b", color: "#e7e7e7", fontFamily: "Inter, ui-monospace, Menlo, Consolas" }}>
      {/* Top bar */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #222", flexWrap: "wrap" }}>
        <button onClick={() => setFrame(f => clamp(f - 1, 0, totalFrames - 1))}>←</button>
        <input type="range" min={0} max={Math.max(0, totalFrames - 1)} value={frame} onChange={e => setFrame(parseInt(e.target.value))} style={{ flex: 1, minWidth: 180 }} />
        <button onClick={() => setFrame(f => clamp(f + 1, 0, totalFrames - 1))}>→</button>
        <button onClick={() => setPlaying(p => !p)}>{playing ? "Pause" : "Play"}</button>
        <span style={{ opacity: 0.85 }}>Frame {frame + 1}/{totalFrames || "—"}</span>

        <span style={{ marginLeft: 16 }}>
          Scale: <input type="range" min={0.1} max={scaleMax} step={0.05} value={scale} onChange={e => setScale(Math.min(parseFloat(e.target.value), scaleMax))} />
          <span style={{ marginLeft: 6 }}>{(scale * 100).toFixed(0)}%</span>
        </span>

        <span style={{ marginLeft: 16 }}>
          Interp <input type="checkbox" checked={interpolate} onChange={e => setInterpolate(e.target.checked)} />
        </span>

        <button onClick={togglePresenceAtCurrent} disabled={!selectedTracks.length}>Toggle Presence (N)</button>

        <button style={{ marginLeft: "auto" }} onClick={exportJSON}>Export JSON</button>
        <button onClick={exportYOLO}>Export YOLO</button>
        <button onClick={() => setKeyUIOpen(true)}>Shortcuts</button>
      </div>

      {/* Middle: Left panel + Canvas */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(240px, 25vw) 1fr", minHeight: 0 }}>
        {/* Left panel */}
        <div style={{ borderRight: "1px solid #222", padding: 8, overflow: "auto", minWidth: 240 }}>
          {/* Label set */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Label Set</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select
                value={labelSet.name}
                onChange={e => {
                  const name = e.target.value;
                  const raw = localStorage.getItem("sequence_label_sets_v1");
                  if (!raw) return;
                  try {
                    const sets: LabelSet[] = JSON.parse(raw);
                    const s = sets.find(x => x.name === name);
                    if (s) setLabelSet({ name: s.name, classes: [...s.classes] });
                  } catch (err) {
                    console.error(err);
                  }
                }}
              >
                <option value={labelSet.name}>{labelSet.name}</option>
                {availableSets.filter(s => s.name !== labelSet.name).map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
              <button onClick={() => {
                const name = prompt("Save label set as:", labelSet.name || "Set");
                if (name) {
                  const sets = [...availableSets.filter(s => s.name !== name), { name, classes: labelSet.classes }];
                  setAvailableSets(sets);
                  localStorage.setItem("sequence_label_sets_v1", JSON.stringify(sets));
                  setLabelSet({ ...labelSet, name });
                }
              }}>Save</button>
            </div>
            {/* Classes editor */}
            <div style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Classes</div>
              {labelSet.classes.map((c, i) => (
                <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                  <span style={{ width: 22, opacity: 0.8 }}>{i + 1}.</span>
                  <input
                    value={c}
                    onChange={e => setLabelSet(s => ({ ...s, classes: s.classes.map((x, idx) => idx === i ? e.target.value : x) }))}
                  />
                  <button onClick={() => setLabelSet(s => ({ ...s, classes: s.classes.filter((_, idx) => idx !== i) }))}>-</button>
                </div>
              ))}
              <button onClick={() => setLabelSet(s => ({ ...s, classes: [...s.classes, `Class${s.classes.length + 1}`] }))}>+ Add Class</button>
            </div>
          </div>

          {/* Tracks */}
          <div style={{ borderTop: "1px solid #222", paddingTop: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 600 }}>Tracks</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={copySelectedTracks} disabled={!selectedTracks.length}>Copy</button>
                <button onClick={pasteTracks} disabled={!clipboardRef.current?.length}>Paste</button>
                <button onClick={() => { setTracks([]); setSelectedIds(new Set()); }}>Clear</button>
              </div>
            </div>

            <TrackPanel
              labelSet={labelSet}
              tracks={tracks}
              selectedIds={selectedIds}
              setSelectedIds={setSelectedIds}
              setTracks={updater => setTracks(updater)}
            />
          </div>
        </div>

        {/* Canvas + Timeline */}
        <div style={{ display: "grid", gridTemplateRows: "1fr auto", background: "#111", minWidth: 0 }}>
          <div ref={canvasWrapRef} style={{ display: "grid", placeItems: "center" }}>
            {!meta ? (
              <div style={{ padding: 20 }}>Loading index…</div>
            ) : (
              <canvas
                ref={canvasRef}
                style={{ border: "1px solid #333", imageRendering: "pixelated", cursor: handleCursor(dragHandle !== "none" ? dragHandle : hoverHandle, dragHandle !== "none") }}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
              />
            )}
          </div>
          <div ref={timelineWrapRef} style={{ padding: "6px 12px", borderTop: "1px solid #222" }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
              <button onClick={() => setFrame(f => clamp(f - 1, 0, totalFrames - 1))}>Prev</button>
              <button onClick={() => setFrame(f => clamp(f + 1, 0, totalFrames - 1))}>Next</button>
              <button onClick={gotoPrevKeyframe} disabled={!oneSelected || oneSelected.keyframes.length === 0}>Prev KF</button>
              <button onClick={gotoNextKeyframe} disabled={!oneSelected || oneSelected.keyframes.length === 0}>Next KF</button>
            </div>
            <Timeline
              total={totalFrames || 1}
              frame={frame}
              onSeek={scheduleSeek}
              selectedTracks={selectedTracks.length ? selectedTracks : tracks.slice(0, 1)}
              width={timelineWidth}
              height={56}
            />
          </div>
        </div>
      </div>

      {/* Bottom help */}
      <div style={{ padding: "6px 12px", borderTop: "1px solid #222", fontSize: 12, opacity: 0.85 }}>
        Frames: ←/→ ±1, Shift+←/Shift+→ ±10, Ctrl+←/Ctrl+→ ±100, Space Play ·
        KF: K add, Shift+K del, , prev, . next ·
        Presence: N toggle ·
        Multi-move: Alt+드래그 ·
        Copy/Paste: Ctrl+C / Ctrl+V ·
        1~9 pick class
      </div>

      {/* Shortcuts Modal */}
      <ShortcutModal
        open={keyUIOpen}
        keymap={keymap}
        setKeymap={fn => setKeymap(fn(keymap))}
        indexUrl={indexUrl}
        recordingAction={recordingAction}
        setRecordingAction={setRecordingAction}
        onClose={() => { setRecordingAction(null); setKeyUIOpen(false); }}
      />
    </div>
  );

  /** ===== Track copy/paste (클로저 아래서 참조되므로 컴포넌트 끝으로 이동) ===== */
  function copySelectedTracks() {
    if (!selectedTracks.length) return;
    clipboardRef.current = selectedTracks.map(t => JSON.parse(JSON.stringify(t)));
  }
  function pasteTracks() {
    if (!clipboardRef.current?.length) return;
    const pasted = clipboardRef.current.map(t => ({
      ...t,
      track_id: `t_${uuid()}`,
      name: (t.name ?? t.track_id) + " (copy)"
    }));
    setTracks(ts => [...ts, ...pasted]);
    setSelectedIds(new Set(pasted.map(t => t.track_id)));
  }
};

const clipboardRef: { current: Track[] | null } = { current: null };

export default SequenceLabeler;