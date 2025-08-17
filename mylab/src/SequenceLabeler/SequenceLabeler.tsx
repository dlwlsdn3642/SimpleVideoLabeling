import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  startTransition,
} from "react";
import { DEFAULT_SCHEMA, DEFAULT_VERSION } from "../constants";
import LRUFrames from "../lib/LRUFrames";
import { Timeline, TrackPanel, ShortcutModal } from "../components";
import type {
  IndexMeta,
  RectPX,
  Track,
  LabelSet,
  KeyMap,
  LocalFile,
  Handle,
} from "../types";
import {
  clamp,
  pad,
  uuid,
  rectAtFrame,
  handleAt,
  findKFIndexAtOrBefore,
  rectFromKF,
  parseNumericKey,
} from "../utils/geom";
import { eventToKeyString, normalizeKeyString } from "../utils/keys";
import { loadDirHandle, saveDirHandle } from "../utils/handles";

const DEFAULT_COLORS = [
  "#e6194b",
  "#3cb44b",
  "#ffe119",
  "#0082c8",
  "#f58231",
  "#911eb4",
  "#46f0f0",
  "#f032e6",
  "#d2f53c",
  "#fabebe",
];

const SequenceLabeler: React.FC<{
  framesBaseUrl: string;
  indexUrl: string;
  taskId?: string;
  initialLabelSetName?: string;
  defaultClasses: string[];
  prefetchRadius?: number;
  ghostAlpha?: number;
  onFolderImported?: (folder: string) => void;
}> = ({
  framesBaseUrl,
  indexUrl,
  taskId,
  initialLabelSetName = "Default",
  defaultClasses,
  prefetchRadius = 8,
  ghostAlpha = 0.35,
  onFolderImported,
}) => {
  // media
  const [meta, setMeta] = useState<IndexMeta | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [localFiles, setLocalFiles] = useState<LocalFile[] | null>(null);
  const [frame, setFrame] = useState(0);
  const [scale, setScale] = useState(1);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const workAreaRef = useRef<HTMLDivElement | null>(null);
  const [sideWidth, setSideWidth] = useState(240);
  const MIN_SIDE_WIDTH = 160;
  const cacheRef = useRef(new LRUFrames(prefetchRadius * 3));
  const [playing, setPlaying] = useState(false);

  // labels
  const [labelSet, setLabelSet] = useState<LabelSet>({
    name: initialLabelSetName,
    classes: defaultClasses,
    colors: defaultClasses.map(
      (_, i) => DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    ),
  });
  const [availableSets, setAvailableSets] = useState<LabelSet[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
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

  // selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectedTracks = useMemo(
    () => tracks.filter((t) => selectedIds.has(t.track_id)),
    [tracks, selectedIds],
  );
  const oneSelected = selectedTracks[0] ?? null;

  // editing
  const [dragHandle, setDragHandle] = useState<Handle>("none");
  const [hoverHandle, setHoverHandle] = useState<Handle>("none");
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

  // keymap
  const DEFAULT_KEYMAP: KeyMap = {
    frame_prev: "ArrowLeft",
    frame_next: "ArrowRight",
    frame_prev10: "Shift+ArrowLeft",
    frame_next10: "Shift+ArrowRight",
    frame_prev100: "Ctrl+ArrowLeft",
    frame_next100: "Ctrl+ArrowRight",
    toggle_play: "Space",
    kf_add: "k",
    kf_del: "Shift+k",
    kf_prev: ",",
    kf_next: ".",
    toggle_interpolate: "i",
    toggle_ghosts: "g",
    toggle_presence: "n",
    copy_tracks: "Ctrl+c",
    paste_tracks: "Ctrl+v",
    undo: "Ctrl+z",
    redo: "Ctrl+y",
  };
  const storagePrefix = taskId ?? indexUrl;
  const [keymap, setKeymap] = useState<KeyMap>(() => {
    const raw = localStorage.getItem(`${storagePrefix}::keymap_v2`);
    return raw ? { ...DEFAULT_KEYMAP, ...JSON.parse(raw) } : DEFAULT_KEYMAP;
  });
  const [keyUIOpen, setKeyUIOpen] = useState(false);
  const [recordingAction, setRecordingAction] = useState<string | null>(null);

  // layout refs for timeline width
  const timelineWrapRef = useRef<HTMLDivElement | null>(null);
  const [timelineWidth, setTimelineWidth] = useState<number>(800);
  const [needsImport, setNeedsImport] = useState(false);

  const loadFromDir = useCallback(async (dir: FileSystemDirectoryHandle) => {
    const entries: LocalFile[] = [];
    // @ts-expect-error FileSystemDirectoryHandle.values is not yet typed
    for await (const entry of (
      dir as unknown as { values(): AsyncIterable<FileSystemHandle> }
    ).values()) {
      if (entry.kind === "file") {
        const name = String(entry.name);
        if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) continue;
        const file = await entry.getFile();
        const url = URL.createObjectURL(file);
        entries.push({ name, handle: entry as FileSystemFileHandle, url });
      }
    }
    if (!entries.length) {
      alert("이미지 파일이 없습니다.");
      return;
    }
    entries.sort((a, b) => {
      const na = parseNumericKey(a.name);
      const nb = parseNumericKey(b.name);
      if (Number.isNaN(na) && Number.isNaN(nb))
        return a.name.localeCompare(b.name);
      if (Number.isNaN(na)) return 1;
      if (Number.isNaN(nb)) return -1;
      return na - nb;
    });

    const first = await entries[0].handle.getFile();
    const bmp = await createImageBitmap(first);
    const m: IndexMeta = {
      width: bmp.width,
      height: bmp.height,
      fps: 30,
      count: entries.length,
      files: entries.map((e) => e.name),
    };
    setMeta(m);
    setLocalFiles(entries);
    setFiles([]);
    cacheRef.current.clear();
    setFrame(0);
  }, []);

  /** ===== Restore & Load ===== */
  useEffect(() => {
    const raw = localStorage.getItem(`${storagePrefix}::autosave_v2`);
    if (raw) {
      try {
        const s = JSON.parse(raw);
        if (s.labelSet)
          setLabelSet({
            ...s.labelSet,
            colors:
              s.labelSet.colors ??
              s.labelSet.classes.map(
                (_: unknown, i: number) =>
                  DEFAULT_COLORS[i % DEFAULT_COLORS.length],
              ),
          });
        if (s.tracks) setTracks(s.tracks);
        if (typeof s.frame === "number") setFrame(s.frame);
        if (typeof s.interpolate === "boolean") setInterpolate(s.interpolate);
        if (typeof s.showGhosts === "boolean") setShowGhosts(s.showGhosts);
      } catch (err) {
        console.error(err);
      }
    }
  }, [storagePrefix]);

  useEffect(() => {
    let aborted = false;
    if (localFiles) return;
    (async () => {
      try {
        const handle = await loadDirHandle(storagePrefix);
        if (
          handle &&
          (await handle.queryPermission({ mode: "read" })) === "granted"
        ) {
          await loadFromDir(handle);
          setNeedsImport(false);
          onFolderImported?.(handle.name);
          return;
        }
      } catch {
        /* ignore */
      }
      try {
        const r = await fetch(indexUrl);
        if (!r.ok) throw new Error(`index fetch ${r.status}`);

        const raw = await r.text();
        let m: IndexMeta;
        try {
          m = JSON.parse(raw) as IndexMeta;
        } catch (err) {
          console.warn("index meta parse error", err, {
            contentType: r.headers.get("content-type"),
            bodyPreview: raw.slice(0, 200),
          });
          setNeedsImport(true);
          return;
        }
        if (aborted) return;
        setMeta(m);
        if (m.files?.length) setFiles(m.files);
        else {
          const padW =
            m.zeroPad ?? Math.max(6, String(Math.max(0, m.count - 1)).length);
          const ext = m.ext ?? "webp";
          setFiles(
            Array.from(
              { length: m.count },
              (_, i) => `frame_${pad(i, padW)}.${ext}`,
            ),
          );
        }
      } catch (err) {
        console.error(err);
        setNeedsImport(true);
      }
    })();
    return () => {
      aborted = true;
    };
  }, [indexUrl, localFiles, storagePrefix, loadFromDir, onFolderImported]);

  useEffect(() => {
    const raw = localStorage.getItem("sequence_label_sets_v1");
    if (raw) {
      try {
        const sets: LabelSet[] = JSON.parse(raw);
        setAvailableSets(
          sets.map((s) => ({
            ...s,
            colors:
              s.colors ??
              s.classes.map(
                (_: unknown, i: number) =>
                  DEFAULT_COLORS[i % DEFAULT_COLORS.length],
              ),
          })),
        );
      } catch (err) {
        console.error(err);
      }
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      localStorage.setItem(
        `${storagePrefix}::autosave_v2`,
        JSON.stringify({
          schema: DEFAULT_SCHEMA,
          version: DEFAULT_VERSION,
          meta,
          labelSet,
          tracks,
          frame,
          interpolate,
          showGhosts,
        }),
      );
    }, 300);
    return () => clearTimeout(t);
  }, [meta, labelSet, tracks, frame, interpolate, showGhosts, storagePrefix]);

  // observe timeline width
  useEffect(() => {
    if (!timelineWrapRef.current) return;
    const el = timelineWrapRef.current;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0].contentRect;
      setTimelineWidth(Math.max(300, cr.width - 24)); // padding 12*2
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // adjust side panel width to fill canvas height
  useEffect(() => {
    if (!meta || !workAreaRef.current) return;
    const el = workAreaRef.current;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const timelineH =
        timelineWrapRef.current?.getBoundingClientRect().height ?? 0;
      const totalW = rect.width;
      const availH = rect.height - timelineH;
      if (availH <= 0 || totalW <= 0) return;
      const desiredCanvasW = availH * (meta.width / meta.height);
      let newSide = totalW - desiredCanvasW;
      if (newSide < MIN_SIDE_WIDTH) newSide = MIN_SIDE_WIDTH;
      if (newSide > totalW) newSide = totalW;
      const canvasW = totalW - newSide;
      setSideWidth(newSide);
      setScale(canvasW / meta.width);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [meta]);

  /** ===== Image loading ===== */
  const getImage = useCallback(
    async (idx: number): Promise<ImageBitmap | null> => {
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
    },
    [meta, files, framesBaseUrl, localFiles],
  );

  // prefetch around current frame
  useEffect(() => {
    (async () => {
      const total = localFiles ? localFiles.length : files.length;
      if (!meta || total <= 0) return;
      const tasks: Promise<HTMLImageElement | null>[] = [];
      for (let d = -prefetchRadius; d <= prefetchRadius; d++) {
        const i = frame + d;
        if (i < 0 || i >= total) continue;
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
      const c = canvasRef.current;
      if (!c || !meta) return;
      const ctx = c.getContext("2d");
      if (!ctx) return;

      const bmpInCache = cacheRef.current.has(frame);
      const bmp = bmpInCache
        ? cacheRef.current.get(frame)
        : await getImage(frame);
      if (cancelled || !bmp) return;

      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0, c.width, c.height);

      const drawRect = (
        r: RectPX,
        color = "#00e5ff",
        alpha = 1,
        dashed = false,
      ) => {
        const x = r.x * scale,
          y = r.y * scale,
          w = r.w * scale,
          h = r.h * scale;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.setLineDash(dashed ? [6, 6] : []);
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.strokeRect(x, y, w, h);
        const hs = 6;
        ctx.fillStyle = color;
        const dots = [
          [x, y],
          [x + w, y],
          [x, y + h],
          [x + w, y + h],
          [x + w / 2, y],
          [x + w / 2, y + h],
          [x, y + h / 2],
          [x + w, y + h / 2],
        ];
        for (const [dx, dy] of dots)
          ctx.fillRect(dx - hs, dy - hs, hs * 2, hs * 2);
        ctx.restore();
      };

      // ghosts (previous/next frame preview)
      if (showGhosts && ghostAlpha > 0) {
        for (const t of tracks) {
          if (t.hidden) continue;
          const color = labelSet.colors[t.class_id] || "#66d9ef";
          const prev = rectAtFrame(t, frame - 1, interpolate);
          if (prev) drawRect(prev, color, ghostAlpha, true);
          const next = rectAtFrame(t, frame + 1, interpolate);
          if (next) drawRect(next, color, ghostAlpha, true);
        }
      }

      // current rects
      for (const t of tracks) {
        if (t.hidden) continue;
        const r = rectAtFrame(t, frame, interpolate);
        if (!r) continue;
        const color = labelSet.colors[t.class_id] || "#66d9ef";
        const isSel = selectedIds.has(t.track_id);
        drawRect(r, color, isSel ? 1 : 0.7, false);

        // tag
        ctx.save();
        const cls = labelSet.classes[t.class_id] ?? t.class_id;
        const tag = `${cls}${t.name ? ` (${t.name})` : ""}`;
        ctx.font = "12px monospace";
        const x = r.x * scale,
          y = r.y * scale,
          w = ctx.measureText(tag).width + 8;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.5;
        ctx.fillRect(x, y - 18, w, 18);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#fff";
        ctx.fillText(tag, x + 4, y - 5);
        ctx.restore();
      }
      if (dragRef.current.creating && draftRect) {
        const x = draftRect.x * scale,
          y = draftRect.y * scale,
          w = draftRect.w * scale,
          h = draftRect.h * scale;
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
    return () => {
      cancelled = true;
    };
  }, [
    frame,
    tracks,
    selectedIds,
    labelSet.classes,
    labelSet.colors,
    interpolate,
    showGhosts,
    ghostAlpha,
    meta,
    getImage,
    scale,
    draftRect,
  ]);

  /** ===== Keyboard ===== */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (recordingAction) {
        const s = eventToKeyString(e);
        if (s) {
          setKeymap((m) => ({
            ...m,
            [recordingAction]: normalizeKeyString(s),
          }));
          setRecordingAction(null);
        }
        e.preventDefault();
        return;
      }
      if (["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName ?? ""))
        return;

      const keyStr = normalizeKeyString(eventToKeyString(e) ?? "");
      const match = (action: string) =>
        keymap[action] && normalizeKeyString(keymap[action]) === keyStr;

      const total = localFiles ? localFiles.length : files.length;

      if (match("frame_prev")) {
        setFrame((f) => clamp(f - 1, 0, total - 1));
        e.preventDefault();
      } else if (match("frame_next")) {
        setFrame((f) => clamp(f + 1, 0, total - 1));
        e.preventDefault();
      } else if (match("frame_prev10"))
        setFrame((f) => clamp(f - 10, 0, total - 1));
      else if (match("frame_next10"))
        setFrame((f) => clamp(f + 10, 0, total - 1));
      else if (match("frame_prev100"))
        setFrame((f) => clamp(f - 100, 0, total - 1));
      else if (match("frame_next100"))
        setFrame((f) => clamp(f + 100, 0, total - 1));
      else if (match("toggle_play")) {
        setPlaying((p) => !p);
        e.preventDefault();
      } else if (match("kf_add")) addKeyframeAtCurrent();
      else if (match("kf_del")) deleteKeyframeAtCurrent();
      else if (match("kf_prev")) gotoPrevKeyframe();
      else if (match("kf_next")) gotoNextKeyframe();
      else if (match("toggle_interpolate")) setInterpolate((v) => !v);
      else if (match("toggle_ghosts")) setShowGhosts((v) => !v);
      else if (match("toggle_presence")) togglePresenceAtCurrent();
      else if (match("copy_tracks")) copySelectedTracks();
      else if (match("paste_tracks")) pasteTracks();
      else if (match("undo")) {
        undo();
        e.preventDefault();
      } else if (match("redo")) {
        redo();
        e.preventDefault();
      } else {
        if (/^\d$/.test(e.key) && e.key !== "0") {
          const idx = parseInt(e.key, 10) - 1;
          if (labelSet.classes[idx]) setCurClass(idx);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    keymap,
    files.length,
    localFiles,
    labelSet.classes,
    recordingAction,
    selectedIds,
    addKeyframeAtCurrent,
    deleteKeyframeAtCurrent,
    gotoPrevKeyframe,
    gotoNextKeyframe,
    togglePresenceAtCurrent,
    copySelectedTracks,
    pasteTracks,
    undo,
    redo,
  ]);

  /** ===== Playback ===== */
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const fps = meta?.fps ?? 30;
    const dur = 1000 / fps;
    const total = localFiles ? localFiles.length : files.length;
    const loop = () => {
      const now = performance.now();
      if (now - last >= dur) {
        setFrame((f) => (f + 1 < total ? f + 1 : 0));
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
  const [curClass, setCurClass] = useState(0);

  const onMouseDown = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (!meta) return;
    const { mx, my } = toImgCoords(ev);

    // hit-test visible rects (top-most)
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

      // Ctrl/Cmd 클릭으로 선택 토글
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

      // 선택된 트랙들의 현재 프레임 rect 스냅샷
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
    } else {
      // 새 트랙 생성 드래그 시작
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

    // 새 트랙 드래그 중
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

    // 기존 편집: origRects가 없으면 안전하게 종료
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

  /** ===== KF / Presence ops ===== */
  function addKeyframe(trackId: string, f: number) {
    const t = tracks.find((t) => t.track_id === trackId);
    if (!t) return;
    const idx = findKFIndexAtOrBefore(t.keyframes, f);
    let r = rectAtFrame(t, f, interpolate);
    if (!r && idx >= 0) r = rectFromKF(t.keyframes[idx]);
    if (!r) return;
    applyTracks(
      (ts) =>
        ts.map((tt) => {
          if (tt.track_id !== trackId) return tt;
          const kfs = [...tt.keyframes];
          const prevIdx = findKFIndexAtOrBefore(kfs, f);
          if (prevIdx >= 0 && kfs[prevIdx].absent) {
            if (kfs[prevIdx].frame === f) kfs[prevIdx] = { ...kfs[prevIdx], absent: false };
            else kfs.splice(prevIdx, 1);
          }
          const updated = { ...tt, keyframes: kfs };
          return ensureKFAt(updated, f, r!);
        }),
      true,
    );
  }
  function addKeyframeAtCurrent() {
    if (!oneSelected) return;
    addKeyframe(oneSelected.track_id, frame);
  }
  function deleteKeyframe(trackId: string, f: number) {
    applyTracks(
      (ts) =>
        ts.map((t) => {
          if (t.track_id !== trackId) return t;
          return { ...t, keyframes: t.keyframes.filter((k) => k.frame !== f) };
        }),
      true,
    );
  }
  function deleteKeyframeAtCurrent() {
    if (!oneSelected) return;
    applyTracks(
      (ts) =>
        ts.map((t) => {
          if (t.track_id !== oneSelected.track_id) return t;
          const kfs = t.keyframes.filter((k) => k.frame !== frame);
          return { ...t, keyframes: kfs };
        }),
      true,
    );
  }
  function gotoPrevKeyframe() {
    if (!oneSelected) return;
    const kfs = oneSelected.keyframes;
    const idx = findKFIndexAtOrBefore(kfs, frame - 1);
    const prev = idx >= 0 ? kfs[idx].frame : kfs[0].frame;
    setFrame(prev);
  }
  function gotoNextKeyframe() {
    if (!oneSelected) return;
    const kfs = oneSelected.keyframes;
    const idx = findKFIndexAtOrBefore(kfs, frame);
    // If no keyframe exists at or before the current frame (idx === -1),
    // jump to the first keyframe instead of wrapping to the last.
    // Otherwise move to the next keyframe, or stay on the last one if already there.
    const next =
      idx === -1
        ? kfs[0].frame
        : idx < kfs.length - 1
          ? kfs[idx + 1].frame
          : kfs[kfs.length - 1].frame;
    setFrame(next);
  }
  function togglePresenceAtCurrent() {
    if (!selectedTracks.length) return;
    applyTracks(
      (ts) =>
        ts.map((t) => {
          if (!selectedIds.has(t.track_id)) return t;
          const kfs = [...t.keyframes];
          const idx = findKFIndexAtOrBefore(kfs, frame);
          if (idx < 0) return t;
          const kf = kfs[idx];
          kfs[idx] = { ...kf, absent: !kf.absent };
          return { ...t, keyframes: kfs };
        }),
      true,
    );
  }

  /** ===== Export ===== */
  function exportJSON() {
    if (!meta) return;
    const total = localFiles ? localFiles.length : files.length;
    const out = {
      schema: DEFAULT_SCHEMA,
      version: DEFAULT_VERSION,
      meta: {
        width: meta.width,
        height: meta.height,
        fps: meta.fps ?? 30,
        count: total,
      },
      label_set: labelSet,
      files: localFiles ? localFiles.map((f) => f.name) : files,
      tracks: tracks.map((t) => ({
        track_id: t.track_id,
        class_id: t.class_id,
        name: t.name,
        keyframes: t.keyframes.map((k) => ({
          frame: k.frame,
          bbox_xywh: k.bbox_xywh,
          ...(k.absent ? { absent: true } : {}),
        })),
      })),
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "labels_v1.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportYOLO() {
    if (!meta) return;
    if (!("showDirectoryPicker" in window)) {
      alert("Chromium 계열 브라우저에서 사용하세요.");
      return;
    }
    const dir: FileSystemDirectoryHandle = await (
      window as unknown as {
        showDirectoryPicker: (opts: {
          id: string;
        }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker({ id: "yolo-export" });
    const total = localFiles ? localFiles.length : files.length;
    const names = localFiles ? localFiles.map((f) => f.name) : files;

    const perFrame: string[][] = Array.from({ length: total }, () => []);
    for (const t of tracks) {
      for (let f = 0; f < total; f++) {
        const r = rectAtFrame(t, f, interpolate);
        if (!r) continue;
        const cx = (r.x + r.w / 2) / meta.width;
        const cy = (r.y + r.h / 2) / meta.height;
        const ww = r.w / meta.width;
        const hh = r.h / meta.height;
        perFrame[f].push(
          `${t.class_id} ${cx.toFixed(6)} ${cy.toFixed(6)} ${ww.toFixed(6)} ${hh.toFixed(6)}`,
        );
      }
    }
    for (let i = 0; i < total; i++) {
      if (!perFrame[i].length) continue;
      const base = names[i].replace(/\.[^.]+$/, "");
      const handle = await dir.getFileHandle(`${base}.txt`, { create: true });
      const w = await handle.createWritable();
      await w.write(perFrame[i].join("\n") + "\n");
      await w.close();
    }
    alert("YOLO 내보내기 완료");
  }

  async function importFolder() {
    if (!("showDirectoryPicker" in window)) {
      alert("Chromium 계열 브라우저에서 사용하세요.");
      return;
    }
    const dir: FileSystemDirectoryHandle = await (
      window as unknown as {
        showDirectoryPicker: (opts: {
          id: string;
        }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker({ id: storagePrefix });
    await loadFromDir(dir);
    await saveDirHandle(storagePrefix, dir);
    setNeedsImport(false);
    onFolderImported?.(dir.name);
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
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto 1fr auto auto",
        height: "100%",
        background: "#0b0b0b",
        color: "#e7e7e7",
        fontFamily: "Inter, ui-monospace, Menlo, Consolas",
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          padding: "8px 12px",
          borderBottom: "1px solid #222",
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={() => setFrame((f) => clamp(f - 1, 0, totalFrames - 1))}
        >
          ←
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, totalFrames - 1)}
          value={frame}
          onChange={(e) => setFrame(parseInt(e.target.value))}
          style={{ flex: 1, minWidth: 180 }}
        />
        <button
          onClick={() => setFrame((f) => clamp(f + 1, 0, totalFrames - 1))}
        >
          →
        </button>
        <button onClick={() => setPlaying((p) => !p)}>
          {playing ? "Pause" : "Play"}
        </button>
        <span style={{ opacity: 0.85 }}>
          Frame {frame + 1}/{totalFrames || "—"}
        </span>

        <span style={{ marginLeft: 16 }}>
          Interp{" "}
          <input
            type="checkbox"
            checked={interpolate}
            onChange={(e) => setInterpolate(e.target.checked)}
          />
        </span>

        <button
          onClick={togglePresenceAtCurrent}
          disabled={!selectedTracks.length}
        >
          Toggle Presence (N)
        </button>

        <button style={{ marginLeft: "auto" }} onClick={importFolder}>
          Import Folder
        </button>
        {needsImport && (
          <span style={{ color: "#f66" }}>Load failed. Use Import Folder.</span>
        )}
        <button onClick={exportJSON}>Export JSON</button>
        <button onClick={exportYOLO}>Export YOLO</button>
        <button onClick={() => setKeyUIOpen(true)}>Shortcuts</button>
      </div>

      {/* Middle: Canvas + Right panel */}
      <div
        ref={workAreaRef}
        style={{
          display: "grid",
          gridTemplateColumns: `1fr ${sideWidth}px`,
          minHeight: 0,
        }}
      >
        {/* Canvas + Timeline */}
        <div
          style={{
            display: "grid",
            gridTemplateRows: "1fr auto",
            background: "#111",
            minWidth: 0,
          }}
        >
          <div
            ref={canvasWrapRef}
            style={{ display: "grid", placeItems: "center", width: "100%" }}
          >
            {!meta ? (
              <div style={{ padding: 20 }}>Loading index…</div>
            ) : (
              <canvas
                ref={canvasRef}
                style={{
                  border: "1px solid #333",
                  imageRendering: "pixelated",
                  cursor: handleCursor(
                    dragHandle !== "none" ? dragHandle : hoverHandle,
                    dragHandle !== "none",
                  ),
                }}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
              />
            )}
          </div>
          <div
            ref={timelineWrapRef}
            style={{ padding: "6px 12px", borderTop: "1px solid #222" }}
          >
            <Timeline
              total={totalFrames || 1}
              frame={frame}
              onSeek={scheduleSeek}
              tracks={tracks}
              labelSet={labelSet}
              onDeleteKeyframe={deleteKeyframe}
              onAddKeyframe={addKeyframe}
              width={timelineWidth}
            />
          </div>
        </div>

        {/* Right panel */}
        <div
          style={{
            borderLeft: "1px solid #222",
            padding: 8,
            overflow: "auto",
            minWidth: MIN_SIDE_WIDTH,
          }}
        >
          {/* View options */}
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={showGhosts}
                onChange={(e) => setShowGhosts(e.target.checked)}
              />
              <span>Show ghosts (prev/next)</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={interpolate}
                onChange={(e) => setInterpolate(e.target.checked)}
              />
              <span>Interpolate</span>
            </label>
          </div>
          {/* Label set */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Label Set</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select
                value={labelSet.name}
                onChange={(e) => {
                  const name = e.target.value;
                  const raw = localStorage.getItem("sequence_label_sets_v1");
                  if (!raw) return;
                  try {
                    const sets: LabelSet[] = JSON.parse(raw);
                    const s = sets.find((x) => x.name === name);
                    if (s)
                      setLabelSet({
                        name: s.name,
                        classes: [...s.classes],
                        colors:
                          s.colors ??
                          s.classes.map(
                            (_: unknown, i: number) =>
                              DEFAULT_COLORS[i % DEFAULT_COLORS.length],
                          ),
                      });
                  } catch (err) {
                    console.error(err);
                  }
                }}
              >
                <option value={labelSet.name}>{labelSet.name}</option>
                {availableSets
                  .filter((s) => s.name !== labelSet.name)
                  .map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
              </select>
              <button
                onClick={() => {
                  const name = prompt(
                    "Save label set as:",
                    labelSet.name || "Set",
                  );
                  if (name) {
                    const sets = [
                      ...availableSets.filter((s) => s.name !== name),
                      {
                        name,
                        classes: labelSet.classes,
                        colors: labelSet.colors,
                      },
                    ];
                    setAvailableSets(sets);
                    localStorage.setItem(
                      "sequence_label_sets_v1",
                      JSON.stringify(sets),
                    );
                    setLabelSet({ ...labelSet, name });
                  }
                }}
              >
                Save
              </button>
            </div>
            {/* Classes editor */}
            <div style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Classes</div>
              {labelSet.classes.map((c, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    gap: 6,
                    marginBottom: 4,
                    alignItems: "center",
                  }}
                >
                  <span style={{ width: 22, opacity: 0.8 }}>{i + 1}.</span>
                  <input
                    value={c}
                    onChange={(e) =>
                      setLabelSet((s) => ({
                        ...s,
                        classes: s.classes.map((x, idx) =>
                          idx === i ? e.target.value : x,
                        ),
                      }))
                    }
                  />
                  <input
                    type="color"
                    value={labelSet.colors[i]}
                    onChange={(e) => {
                      const val = e.target.value;
                      startTransition(() => {
                        setLabelSet((s) => ({
                          ...s,
                          colors: s.colors.map((col, idx) =>
                            idx === i ? val : col,
                          ),
                        }));
                      });
                    }}
                  />
                  <button
                    onClick={() =>
                      setLabelSet((s) => ({
                        ...s,
                        classes: s.classes.filter((_, idx) => idx !== i),
                        colors: s.colors.filter((_, idx) => idx !== i),
                      }))
                    }
                  >
                    -
                  </button>
                </div>
              ))}
              <button
                onClick={() =>
                  setLabelSet((s) => ({
                    ...s,
                    classes: [...s.classes, `Class${s.classes.length + 1}`],
                    colors: [
                      ...s.colors,
                      DEFAULT_COLORS[s.colors.length % DEFAULT_COLORS.length],
                    ],
                  }))
                }
              >
                + Add Class
              </button>
            </div>
          </div>

          {/* Tracks */}
          <div style={{ borderTop: "1px solid #222", paddingTop: 8 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div style={{ fontWeight: 600 }}>Tracks</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={copySelectedTracks}
                  disabled={!selectedTracks.length}
                >
                  Copy
                </button>
                <button
                  onClick={pasteTracks}
                  disabled={!clipboardRef.current?.length}
                >
                  Paste
                </button>
                <button
                  onClick={() => {
                    applyTracks(() => [], true);
                    setSelectedIds(new Set());
                  }}
                >
                  Clear
                </button>
              </div>
            </div>

            <TrackPanel
              labelSet={labelSet}
              tracks={tracks}
              selectedIds={selectedIds}
              setSelectedIds={setSelectedIds}
              setTracks={applyTracks}
            />
          </div>
        </div>
      </div>

      {/* Bottom help */}
      <div
        style={{
          padding: "6px 12px",
          borderTop: "1px solid #222",
          fontSize: 12,
          opacity: 0.85,
        }}
      >
        Frames: ←/→ ±1, Shift+←/Shift+→ ±10, Ctrl+←/Ctrl+→ ±100, Space Play ·
        KF: K add, Shift+K del, , prev, . next · Presence: N toggle ·
        View: I interpolate, G ghosts · Multi-move: Alt+드래그 · Copy/Paste: Ctrl+C / Ctrl+V · 1~9 pick class
      </div>

      {/* Shortcuts Modal */}
      <ShortcutModal
        open={keyUIOpen}
        keymap={keymap}
        setKeymap={(fn) => setKeymap(fn(keymap))}
        indexUrl={indexUrl}
        recordingAction={recordingAction}
        setRecordingAction={setRecordingAction}
        onClose={() => {
          setRecordingAction(null);
          setKeyUIOpen(false);
        }}
      />
    </div>
  );

  /** ===== Track copy/paste (클로저 아래서 참조되므로 컴포넌트 끝으로 이동) ===== */
  function copySelectedTracks() {
    if (!selectedTracks.length) return;
    clipboardRef.current = selectedTracks.map((t) =>
      JSON.parse(JSON.stringify(t)),
    );
  }
  function pasteTracks() {
    if (!clipboardRef.current?.length) return;
    const pasted = clipboardRef.current.map((t) => ({
      ...t,
      track_id: `t_${uuid()}`,
      name: (t.name ?? t.track_id) + " (copy)",
    }));
    applyTracks((ts) => [...ts, ...pasted], true);
    setSelectedIds(new Set(pasted.map((t) => t.track_id)));
  }
};

const clipboardRef: { current: Track[] | null } = { current: null };

export default SequenceLabeler;
