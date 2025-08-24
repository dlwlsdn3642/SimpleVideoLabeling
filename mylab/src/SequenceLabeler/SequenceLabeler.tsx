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
import VideoSource from "../lib/VideoSource";
import { useHistory } from "../modules/model/history";
import type { TracksState } from "../modules/model/tracks";
import { ShortcutModal } from "../components";
import styles from "./SequenceLabeler.module.css";
import SLTopBar from "./SLTopBar";
import SLTimelineSection from "./SLTimelineSection";
import SLRightPanel from "./SLRightPanel";
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
import {
  loadDirHandle,
  saveDirHandle,
  loadFileHandle,
  saveFileHandle,
} from "../utils/handles";
import { TranstClient, blobToBase64 } from "../lib/transtClient";

/* Workspace (Viewport, RightPanel, Timeline) with TopBar */

type DirHandleWithPerm = FileSystemDirectoryHandle & {
  queryPermission?: (opts: {
    mode: "read" | "readwrite";
  }) => Promise<PermissionState>;
};

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
  leftTopExtra?: React.ReactNode;
}> = ({
  framesBaseUrl,
  indexUrl,
  taskId,
  initialLabelSetName = "Default",
  defaultClasses,
  prefetchRadius = 8,
  ghostAlpha = 0.35,
  onFolderImported,
  leftTopExtra,
}) => {
  // media
  const storagePrefix = taskId ?? indexUrl;
  const [meta, setMeta] = useState<IndexMeta | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [localFiles, setLocalFiles] = useState<LocalFile[] | null>(null);
  const [frame, setFrame] = useState(0);
  const [scale, setScale] = useState(1);
  const viewportRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const offscreenTransferredRef = useRef(false);
  const [workerActive, setWorkerActive] = useState(false);
  // Disable OffscreenCanvas path to avoid transfer race when using 2D drawing + video worker
  const canUseOffscreen = false;
  const viewportWrapRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const cacheRef = useRef(new LRUFrames(Math.max(96, prefetchRadius * 10)));
  const videoRef = useRef<VideoSource | null>(null);
  const videoWorkerRef = useRef<Worker | null>(null);
  // Latest bitmap received from the video worker (may not match current f)
  const latestVideoFrameRef = useRef<{ idx: number; bmp: ImageBitmap } | null>(
    null,
  );
  const videoFileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const pendingVideoSeekRef = useRef<number | null>(null);
  const videoSeekScheduledRef = useRef<boolean>(false);

  const requestVideoFrame = useCallback((idx: number, exact = false) => {
    pendingVideoSeekRef.current = idx;
    if (videoSeekScheduledRef.current) return;
    videoSeekScheduledRef.current = true;
    requestAnimationFrame(() => {
      if (videoWorkerRef.current && pendingVideoSeekRef.current !== null) {
        try {
          videoWorkerRef.current.postMessage({
            type: "seekFrame",
            index: pendingVideoSeekRef.current,
            exact,
          });
        } catch {}
      }
      videoSeekScheduledRef.current = false;
    });
  }, []);

  const [playing, setPlaying] = useState(false);
  const [tracking, setTracking] = useState(false);
  const clientRef = useRef<TranstClient | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<{ active: boolean; reason?: string }>({
    active: false,
  });
  // Remember last successfully drawn bitmap to avoid blanks
  const lastDrawnRef = useRef<{ frame: number; bmp: ImageBitmap | null }>({
    frame: -1,
    bmp: null,
  });

  // Dedicated render loop (decoupled from React re-renders) capped at target FPS
  const [targetFPS, setTargetFPS] = useState<number>(() => {
    const key = `${storagePrefix}::target_fps`;
    const raw =
      typeof window !== "undefined" ? localStorage.getItem(key) : null;
    const v = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(v) && v > 0 ? v : 30;
  });
  const rafIdRef = useRef<number | null>(null);
  const lastTickRef = useRef(0);
  const currentFrameRef = useRef(0);
  useEffect(() => {
    currentFrameRef.current = frame;
  });
  // Throttle decode requests independently from render; keeps pipeline stable for large sequences
  const lastDecodeReqRef = useRef(0);
  const decodeIntervalMsRef = useRef(1000 / 30); // aim ~30 decode ops per second
  const decodeScaleHintRef = useRef(1);
  const upgradeInFlightRef = useRef(new Set<number>());
  const videoErrorRef = useRef<string | null>(null);
  // Track fast scrubbing activity to modulate prefetch/upgrade behavior
  const scrubActiveRef = useRef(false);
  const scrubTimerRef = useRef<number | null>(null);
  const finalExactTimerRef = useRef<number | null>(null);

  const clearViewport = useCallback(() => {
    const c = viewportRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.save();
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.restore();
  }, []);

  // Keep decode cadence tied to targetFPS
  useEffect(() => {
    decodeIntervalMsRef.current = 1000 / targetFPS;
  }, [targetFPS]);

  // Persist targetFPS selection
  useEffect(() => {
    try {
      localStorage.setItem(`${storagePrefix}::target_fps`, String(targetFPS));
    } catch {
      /* ignore */
    }
  }, [targetFPS, storagePrefix]);

  // Initialize worker renderer if supported
  useEffect(() => {
    if (!canUseOffscreen) return;
    if (!meta) return; // need dimensions
    if (videoRef.current || videoWorkerRef.current) return; // video path uses dedicated worker/in-thread
    const el = viewportRef.current;
    if (!el) return;
    if (workerRef.current) return; // already initialized
    try {
      // Prepare OffscreenCanvas and worker
      // @ts-ignore - transferControlToOffscreen exists when supported
      const offscreen: OffscreenCanvas = el.transferControlToOffscreen();
      offscreenTransferredRef.current = true;
      const worker = new Worker(
        new URL("../workers/frameWorker.ts", import.meta.url),
        { type: "module" },
      );
      workerRef.current = worker;
      setWorkerActive(true);
      const W = Math.round(meta.width * scale);
      const H = Math.round(meta.height * scale);
      worker.postMessage(
        {
          type: "init",
          canvas: offscreen,
          meta,
          scale,
          fps: targetFPS,
          width: W,
          height: H,
        },
        [offscreen as unknown as Transferable],
      );
      // Set source
      if (localFiles) {
        worker.postMessage({
          type: "setLocalSource",
          count: localFiles.length,
        });
        // Handle blob requests from worker
        worker.onmessage = async (e: MessageEvent) => {
          const data: any = e.data;
          if (data?.type === "needBlob") {
            try {
              const idx = data.index as number;
              const file = await localFiles[idx].handle.getFile();
              worker.postMessage({
                type: "provideBlob",
                index: idx,
                blob: file,
              });
            } catch {
              worker.postMessage({
                type: "provideBlob",
                index: data.index,
                blob: null,
              });
            }
          }
        };
      } else {
        worker.postMessage({
          type: "setRemoteSource",
          baseUrl: framesBaseUrl,
          files,
        });
      }
    } catch (err) {
      console.warn(
        "Failed to init Offscreen worker, falling back to main thread",
        err,
      );
      setWorkerActive(false);
    }
  }, [
    canUseOffscreen,
    meta,
    scale,
    targetFPS,
    framesBaseUrl,
    files,
    localFiles,
  ]);

  // Sync worker with dynamic state
  useEffect(() => {
    if (!workerActive || !workerRef.current) return;
    const worker = workerRef.current;
    worker.postMessage({ type: "setFPS", fps: targetFPS });
  }, [workerActive, targetFPS]);
  useEffect(() => {
    if (!workerActive || !workerRef.current || !meta) return;
    const worker = workerRef.current;
    worker.postMessage({ type: "setMeta", meta });
  }, [workerActive, meta]);
  useEffect(() => {
    if (!workerActive || !workerRef.current || !meta) return;
    const worker = workerRef.current;
    const W = Math.round(meta.width * scale);
    const H = Math.round(meta.height * scale);
    worker.postMessage({ type: "setScale", scale });
    worker.postMessage({ type: "resize", width: W, height: H });
  }, [workerActive, scale, meta]);
  useEffect(() => {
    if (!workerActive || !workerRef.current) return;
    const worker = workerRef.current;
    worker.postMessage({ type: "setFrame", frame });
  }, [workerActive, frame]);

  // Keep worker source up to date when switching between remote and local
  useEffect(() => {
    if (!workerActive || !workerRef.current) return;
    const worker = workerRef.current;
    if (localFiles)
      worker.postMessage({ type: "setLocalSource", count: localFiles.length });
    else
      worker.postMessage({
        type: "setRemoteSource",
        baseUrl: framesBaseUrl,
        files,
      });
  }, [workerActive, localFiles, framesBaseUrl, files]);

  // Cleanup worker on unmount
  useEffect(() => {
    return () => {
      try {
        workerRef.current?.terminate();
      } catch {}
      workerRef.current = null;
    };
  }, []);

  // labels
  const [labelSet, setLabelSet] = useState<LabelSet>({
    name: initialLabelSetName,
    classes: defaultClasses,
    colors: defaultClasses.map(
      (_, i) => DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    ),
  });
  const [availableSets, setAvailableSets] = useState<LabelSet[]>([]);
  const history = useHistory<TracksState>([]);
  const tracks = history.present;
  const { undo, redo } = history;
  const [hiddenClasses, setHiddenClasses] = useState<Set<number>>(new Set());
  const applyTracks = useCallback(
    (updater: (ts: TracksState) => TracksState, record = false) => {
      history.dispatch({
        type: "APPLY_TRACKS",
        payload: updater(history.present),
        meta: { record },
      });
    },
    [history],
  );
  const [interpolate, setInterpolate] = useState(true);
  const [showGhosts, setShowGhosts] = useState(true);

  // selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectedTracks = useMemo(
    () => tracks.filter((t) => selectedIds.has(t.track_id)),
    [tracks, selectedIds],
  );
  const oneSelected = selectedTracks[0] ?? null;

  // Sync dynamic overlay/draw inputs to worker
  useEffect(() => {
    if (!workerActive || !workerRef.current) return;
    const worker = workerRef.current;
    worker.postMessage({
      type: "updateState",
      tracks,
      selectedIds: Array.from(selectedIds),
      labelSet,
      interpolate,
      showGhosts,
      ghostAlpha,
    });
  }, [
    workerActive,
    tracks,
    selectedIds,
    labelSet,
    interpolate,
    showGhosts,
    ghostAlpha,
  ]);

  // editing
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
  const [keymap, setKeymap] = useState<KeyMap>(() => {
    const raw = localStorage.getItem(`${storagePrefix}::keymap_v2`);
    return raw ? { ...DEFAULT_KEYMAP, ...JSON.parse(raw) } : DEFAULT_KEYMAP;
  });
  const [keyUIOpen, setKeyUIOpen] = useState(false);
  const [recordingAction, setRecordingAction] = useState<string | null>(null);

  // Create a tracker session only when server is reachable; avoid noisy logs when offline
  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 400);
        const r = await fetch("http://localhost:7000/health", {
          signal: ctrl.signal,
        }).catch(() => null);
        clearTimeout(t);
        if (!r || !r.ok) return; // server not available; skip
        if (!clientRef.current) clientRef.current = new TranstClient();
        if (!sessionIdRef.current && !canceled) {
          const resp = await clientRef.current
            .createSession()
            .catch(() => null);
          if (resp && !canceled) sessionIdRef.current = resp.session_id;
        }
      } catch {
        // silent when offline
      }
    })();
    return () => {
      canceled = true;
    };
  }, []);

  // layout refs for timeline area
  const timelineViewRef = useRef<HTMLDivElement | null>(null);
  const timelineTopBarRef = useRef<HTMLDivElement | null>(null);
  const timelineResizerRef = useRef<HTMLDivElement | null>(null);
  const [timelineWidth, setTimelineWidth] = useState<number>(800);
  const [timelineHeight, setTimelineHeight] = useState<number | null>(null);
  const [needsImport, setNeedsImport] = useState(false);
  const resizeRafRef = useRef<number | null>(null);
  const resizeCurrHRef = useRef<number | null>(null);

  const loadFromDir = useCallback(
    async (dir: FileSystemDirectoryHandle) => {
      const entries: LocalFile[] = [];
      for await (const entry of (
        dir as unknown as { values(): AsyncIterable<FileSystemHandle> }
      ).values()) {
        if (entry.kind === "file") {
          const name = String(entry.name);
          if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) continue;
          const file = await (entry as FileSystemFileHandle).getFile();
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
      lastDrawnRef.current = { frame: -1, bmp: null };
      clearViewport();
      setMeta(m);
      setLocalFiles(entries);
      setFiles([]);
      cacheRef.current.clear();
      setFrame(0);
    },
    [clearViewport],
  );

  const loadFromVideoFile = useCallback(
    async (fileHandle: FileSystemFileHandle) => {
      try {
        videoErrorRef.current = null;
        const hasMP4 = typeof window !== "undefined" && (window as any).MP4Box;
        const hasWC = typeof window !== "undefined" && "VideoDecoder" in window;
        if (!hasMP4 || !hasWC) {
          alert("This video feature requires MP4Box and WebCodecs.");
          return;
        }

        const file = await fileHandle.getFile();
        videoFileHandleRef.current = fileHandle;

        // Terminate any existing workers
        try {
          workerRef.current?.terminate();
        } catch {}
        workerRef.current = null;
        setWorkerActive(false);
        try {
          videoWorkerRef.current?.terminate();
        } catch {}

        // Start the new video worker
        const vw = new Worker(
          new URL("../workers/videoWorker.ts", import.meta.url),
          { type: "module" },
        );
        videoWorkerRef.current = vw;

        // Wire up the message handler
        vw.onmessage = async (e: MessageEvent) => {
          const m: any = e.data;
          if (!m) return;

          switch (m.type) {
            case "hello":
              // Worker is ready, send init message
              vw.postMessage({
                type: "init",
                fileSize: file.size,
                initBytes: Math.min(4 * 1024 * 1024, file.size),
              });
              break;
            case "need":
              // Worker needs a specific byte range
              try {
                const { start, end } = m as { start: number; end: number };
                const blob = file.slice(start, end + 1);
                const buf = await blob.arrayBuffer();
                // Send it back as a transferable object
                vw.postMessage({ type: "bytes", start, end, buf }, [buf]);
              } catch (err) {
                videoErrorRef.current = "File read error";
                console.error("video bytes supply failed", err);
              }
              break;
            case "ready":
              // Video metadata is parsed and decoder is configured
              console.log("[videoWorker] ready", m);
              const { width, height, frames, fps } = m;
              lastDrawnRef.current = { frame: -1, bmp: null };
              clearViewport();
              setMeta({ width, height, fps, count: frames, files: [] });
              setLocalFiles(null);
              setFiles([]);
              cacheRef.current.clear();
              setFrame(0);
              // Automatically request the first frame
              requestVideoFrame(0);
              break;
            case "frame": {
              const { frameIdx, bitmap } = m as {
                frameIdx: number;
                bitmap: ImageBitmap;
              };
              // 언제나 캐시엔 넣는다 (정밀 탐색이 캐시에서 곧 꺼내 그릴 수 있게)
              cacheRef.current.set(frameIdx, bitmap);
              // 프리뷰는 스크럽(드래그) 중에만 허용. 단일 스텝에선 금지.
              if (
                scrubActiveRef.current ||
                frameIdx === currentFrameRef.current
              ) {
                latestVideoFrameRef.current = { idx: frameIdx, bmp: bitmap };
              }
              break;
            }
            case "fatal":
              videoErrorRef.current = String(m.error || "Video worker error");

              console.error("[videoWorker] fatal", m.error);
              break;
            case "log":
              console.log("[videoWorker] log", m.msg);
              break;
          }
        };

        // Update UI state
        lastDrawnRef.current = { frame: -1, bmp: null };
        clearViewport();
        try {
          await saveFileHandle(`${storagePrefix}::video_file`, fileHandle);
        } catch {}
      } catch (err) {
        alert("Failed to load video file.");
        console.error(err);
      }
    },
    [storagePrefix, clearViewport],
  );

  // On task/storage change, reset media state and canvas to avoid leaking previous content
  useEffect(() => {
    // Stop worker and video
    try {
      workerRef.current?.terminate();
    } catch {}
    workerRef.current = null;
    setWorkerActive(false);
    videoRef.current?.dispose();
    videoRef.current = null;
    try {
      videoWorkerRef.current?.terminate();
    } catch {}
    videoWorkerRef.current = null;
    videoFileHandleRef.current = null;

    // Clear caches and last drawn
    cacheRef.current.clear();
    lastDrawnRef.current = { frame: -1, bmp: null };
    clearViewport();
    // Reset media state
    setMeta(null);
    setFiles([]);
    setLocalFiles(null);
    setFrame(0);
    setPlaying(false);
    setNeedsImport(false);
    videoErrorRef.current = null;
  }, [storagePrefix, clearViewport]);

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
        if (s.tracks) history.reset(s.tracks);
        if (typeof s.frame === "number") setFrame(s.frame);
        if (typeof s.interpolate === "boolean") setInterpolate(s.interpolate);
        if (typeof s.showGhosts === "boolean") setShowGhosts(s.showGhosts);
        return;
      } catch (err) {
        console.error(err);
      }
    }
    // No autosave for this task: reset to defaults to avoid leaking previous state
    setLabelSet({
      name: initialLabelSetName,
      classes: defaultClasses,
      colors: defaultClasses.map(
        (_, i) => DEFAULT_COLORS[i % DEFAULT_COLORS.length],
      ),
    });
    history.reset([]);
    setSelectedIds(new Set());
    setFrame(0);
    setInterpolate(true);
    setShowGhosts(true);
    cacheRef.current.clear();
  }, [storagePrefix, initialLabelSetName, defaultClasses]);

  useEffect(() => {
    let aborted = false;
    if (localFiles || videoRef.current) return;
    (async () => {
      try {
        const handle = await loadDirHandle(storagePrefix);
        if (
          handle &&
          (await (handle as DirHandleWithPerm).queryPermission?.({
            mode: "read",
          })) === "granted"
        ) {
          await loadFromDir(handle);
          setNeedsImport(false);
          onFolderImported?.(handle.name);
          return;
        }
      } catch {
        /* ignore */
      }
      // Try previously saved video file handle (only when MP4Box + WebCodecs available)
      try {
        const hasMP4 = typeof window !== "undefined" && (window as any).MP4Box;
        const hasWC = typeof window !== "undefined" && "VideoDecoder" in window;
        if (hasMP4 && hasWC) {
          const vfh = await loadFileHandle(`${storagePrefix}::video_file`);
          if (vfh) {
            await loadFromVideoFile(vfh);
            setNeedsImport(false);
            return;
          }
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

  // load saved timeline height
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`${storagePrefix}::timeline_h`);
      if (raw) {
        const v = parseInt(raw, 10);
        if (!Number.isNaN(v)) setTimelineHeight(v);
      }
    } catch {
      /* ignore */
    }
  }, [storagePrefix]);
  useEffect(() => {
    if (timelineHeight == null) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          `${storagePrefix}::timeline_h`,
          String(timelineHeight),
        );
      } catch {
        /* ignore */
      }
    }, 200);
    return () => clearTimeout(t);
  }, [timelineHeight, storagePrefix]);

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
          interpolate,
          showGhosts,
        }),
      );
    }, 300);
    return () => clearTimeout(t);
  }, [meta, labelSet, tracks, interpolate, showGhosts, storagePrefix]);

  // Observe layout changes and batch state updates
  useEffect(() => {
    if (!timelineViewRef.current || !viewportWrapRef.current) return;
    const timelineEl = timelineViewRef.current;
    const viewportEl = viewportWrapRef.current;
    let rafId: number | null = null;
    let timelineW = 0;
    let vpW = 0;
    let vpH = 0;
    let lastTimelineW = -1;
    let lastScale = -1;
    const apply = () => {
      rafId = null;
      const nextTimelineW = Math.max(300, timelineW - 24); // padding 12*2
      if (nextTimelineW !== lastTimelineW) {
        lastTimelineW = nextTimelineW;
        setTimelineWidth(nextTimelineW);
      }
      if (meta) {
        const nextScale = Math.min(vpW / meta.width, vpH / meta.height);
        if (nextScale !== lastScale) {
          lastScale = nextScale;
          setScale(nextScale);
        }
      }
    };
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        if (e.target === timelineEl) {
          timelineW = e.contentRect.width;
        } else if (e.target === viewportEl) {
          const cr = e.contentRect;
          vpW = cr.width;
          vpH = cr.height;
        }
      }
      if (rafId == null) rafId = requestAnimationFrame(apply);
    });
    ro.observe(timelineEl);
    ro.observe(viewportEl);
    return () => {
      ro.disconnect();
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [meta]);

  /** ===== Image loading ===== */
  // Deduplicate in-flight image loads to improve fast seeking responsiveness
  const inFlightRef = useRef(new Map<number, Promise<ImageBitmap | null>>());
  const getImage = useCallback(
    async (idx: number, hintOverride?: number): Promise<ImageBitmap | null> => {
      if (workerActive) return null; // handled by worker path
      if (!meta) return null;
      const usingVideo = !!videoRef.current || !!videoWorkerRef.current;
      const total = usingVideo
        ? meta.count
        : localFiles
          ? localFiles.length
          : files.length;
      if (idx < 0 || idx >= total) return null;

      const cached = cacheRef.current.get(idx);
      if (cached) return cached;

      const existing = inFlightRef.current.get(idx);
      if (existing) return existing;

      const p = (async () => {
        try {
          // Decode to the current canvas size to reduce work on large inputs
          const c = viewportRef.current;
          const baseW =
            c?.width ?? Math.round((meta?.width ?? 0) * (scale || 1));
          const baseH =
            c?.height ?? Math.round((meta?.height ?? 0) * (scale || 1));
          const hint = (hintOverride ?? decodeScaleHintRef.current) || 1;
          const targetW = Math.max(1, Math.round(baseW * hint));
          const targetH = Math.max(1, Math.round(baseH * hint));
          if (usingVideo && videoWorkerRef.current) {
            // Request via worker; the worker will post a 'frame' message when done.
            // We don't wait for it here, the drawing loop will pick it up from the cache on the next tick.
            requestVideoFrame(idx);
            return null; // Return null immediately, drawing will use cache or last drawn frame.
          } else if (localFiles) {
            const file = await localFiles[idx].handle.getFile();
            const bmp = await createImageBitmap(file, {
              resizeWidth: Math.max(1, targetW),
              resizeHeight: Math.max(1, targetH),
              resizeQuality: "low",
            } as any);
            cacheRef.current.set(idx, bmp);
            return bmp;
          } else {
            const url = `${framesBaseUrl}/${files[idx]}`;
            const res = await fetch(url, { cache: "force-cache" });
            if (!res.ok) throw new Error(`image fetch ${res.status}`);
            const blob = await res.blob();
            const bmp = await createImageBitmap(blob, {
              resizeWidth: Math.max(1, targetW),
              resizeHeight: Math.max(1, targetH),
              resizeQuality: "low",
            } as any);
            cacheRef.current.set(idx, bmp);
            return bmp;
          }
        } catch {
          if (usingVideo) {
            videoErrorRef.current = "Video decode error";
          }
          return null;
        } finally {
          inFlightRef.current.delete(idx);
        }
      })();
      inFlightRef.current.set(idx, p);
      return p;
    },
    [
      meta,
      files,
      framesBaseUrl,
      localFiles,
      scale,
      workerActive,
      requestVideoFrame,
    ],
  );

  /** ===== Canvas size: update only when meta/scale changes (prevents flicker) ===== */
  useEffect(() => {
    const c = viewportRef.current;
    if (!c || !meta) return;
    if (workerActive || offscreenTransferredRef.current) return; // Offscreen worker owns canvas size
    const W = Math.round(meta.width * scale);
    const H = Math.round(meta.height * scale);
    if (c.width !== W) c.width = W;
    if (c.height !== H) c.height = H;
  }, [meta, scale, workerActive]);

  /** ===== Drawing (persistent RAF loop, ~60 FPS) ===== */
  const stateRef = useRef({
    frame: 0,
    tracks: [] as Track[],
    selectedIds: new Set<string>(),
    labelSet: { classes: [] as string[], colors: [] as string[] } as LabelSet,
    interpolate: true,
    showGhosts: true,
    ghostAlpha: 0.35,
    meta: null as IndexMeta | null,
    scale: 1,
    draftRect: null as RectPX | null,
  });
  // Track if overlays were last drawn for which logical frame
  const lastOverlayFrameRef = useRef<number | null>(null);
  // Track whether overlay needs redraw (tracks, selection, labels, draft, scale changes)
  const overlayDirtyRef = useRef(true);
  useEffect(() => {
    overlayDirtyRef.current = true;
  }, [tracks]);
  useEffect(() => {
    overlayDirtyRef.current = true;
  }, [selectedIds]);
  useEffect(() => {
    overlayDirtyRef.current = true;
  }, [labelSet.classes, labelSet.colors]);
  useEffect(() => {
    overlayDirtyRef.current = true;
  }, [interpolate, showGhosts, ghostAlpha]);
  useEffect(() => {
    overlayDirtyRef.current = true;
  }, [draftRect]);
  useEffect(() => {
    overlayDirtyRef.current = true;
  }, [scale]);
  // keep draw state fresh
  useEffect(() => {
    stateRef.current.frame = frame;
  });
  useEffect(() => {
    stateRef.current.tracks = tracks;
  }, [tracks]);
  useEffect(() => {
    stateRef.current.selectedIds = selectedIds;
  }, [selectedIds]);
  useEffect(() => {
    stateRef.current.labelSet = labelSet;
  }, [labelSet.classes, labelSet.colors]);
  useEffect(() => {
    stateRef.current.interpolate = interpolate;
  }, [interpolate]);
  useEffect(() => {
    stateRef.current.showGhosts = showGhosts;
  }, [showGhosts]);
  useEffect(() => {
    stateRef.current.ghostAlpha = ghostAlpha;
  }, [ghostAlpha]);
  useEffect(() => {
    stateRef.current.meta = meta;
  }, [meta]);
  useEffect(() => {
    stateRef.current.scale = scale;
  }, [scale]);
  useEffect(() => {
    stateRef.current.draftRect = draftRect;
  }, [draftRect]);

  useEffect(() => {
    const tick = async (t: number) => {
      rafIdRef.current = requestAnimationFrame(tick);

      const last = lastTickRef.current;
      const minInterval = 1000 / targetFPS;
      if (t - last < minInterval) return;

      lastTickRef.current = t;

      const {
        frame: f,
        tracks: ts,
        selectedIds: sel,
        labelSet: ls,
        interpolate: itp,
        showGhosts: ghosts,
        ghostAlpha: gAlpha,
        meta: m,
        scale: sc,
        draftRect: dr,
      } = stateRef.current;
      const c = viewportRef.current;
      if (!c || !m) return;

      const ctx = c.getContext("2d");
      if (!ctx) return;

      const total = m.count;
      const usingVideo = !!videoWorkerRef.current;
      // Try exact requested frame first; if not present, fall back to latest worker frame
      let drawBmp: ImageBitmap | null = cacheRef.current.get(f) ?? null;
      let drawIndex = f;
      const delta = Math.abs((lastDrawnRef.current.frame ?? 0) - f);
      const stride = delta > 120 ? 8 : delta > 60 ? 4 : delta > 20 ? 2 : 1;
      decodeScaleHintRef.current = stride >= 8 ? 0.25 : stride >= 4 ? 0.5 : 1;

      if (!drawBmp) {
        // Request the exact frame if not in cache (image/local only). For video, rely on scheduleSeek messages.
        if (
          !usingVideo &&
          t - lastDecodeReqRef.current >= decodeIntervalMsRef.current
        ) {
          lastDecodeReqRef.current = t;
          void getImage(f);
        }
        // Prefer the latest worker-delivered bitmap as a live preview
        if (!drawBmp && scrubActiveRef.current && latestVideoFrameRef.current) {
          drawBmp = latestVideoFrameRef.current.bmp;
          drawIndex = latestVideoFrameRef.current.idx;
        }
        // Use the last successfully drawn frame as a final fallback
        if (!drawBmp && lastDrawnRef.current.bmp) {
          drawBmp = lastDrawnRef.current.bmp;
          drawIndex = lastDrawnRef.current.frame;
        }
      }

      // Always draw at the cadence to keep UI responsive during scrubs

      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#111";
      ctx.fillRect(0, 0, c.width, c.height);

      if (drawBmp) {
        try {
          ctx.drawImage(drawBmp, 0, 0, c.width, c.height);
        } catch (e: any) {
          // If the image was detached/closed, drop it from cache and skip this frame
          if (
            String(e?.name || e).includes("InvalidStateError") ||
            String(e).includes("detached")
          ) {
            if (
              cacheRef.current.has(drawIndex) &&
              cacheRef.current.get(drawIndex) === drawBmp
            ) {
              cacheRef.current.delete(drawIndex);
            }
            if (lastDrawnRef.current.bmp === drawBmp) {
              lastDrawnRef.current = { frame: -1, bmp: null };
            }
            return;
          }
          throw e;
        }
        if (drawIndex !== lastDrawnRef.current.frame) {
          lastDrawnRef.current = { frame: drawIndex, bmp: drawBmp };
        }

        const drawRect = (
          r: RectPX,
          color = "#00e5ff",
          alpha = 1,
          dashed = false,
        ) => {
          const x = r.x * sc,
            y = r.y * sc,
            w = r.w * sc,
            h = r.h * sc;
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
          ] as const;
          for (const [dx, dy] of dots)
            ctx.fillRect(dx - hs, dy - hs, hs * 2, hs * 2);
          ctx.restore();
        };

        if (ghosts && gAlpha > 0) {
          for (const tck of ts) {
            if (tck.hidden) continue;
            const color = ls.colors[tck.class_id] || "#66d9ef";
            const prev = rectAtFrame(tck, f - 1, itp);
            if (prev) drawRect(prev, color, gAlpha, true);
            const next = rectAtFrame(tck, f + 1, itp);
            if (next) drawRect(next, color, gAlpha, true);
          }
        }

        for (const tck of ts) {
          if (tck.hidden) continue;
          const r = rectAtFrame(tck, f, itp);
          if (!r) continue;
          const color = ls.colors[tck.class_id] || "#66d9ef";
          const isSel = sel.has(tck.track_id);
          drawRect(r, color, isSel ? 1 : 0.7, false);
          ctx.save();
          const cls = ls.classes[tck.class_id] ?? tck.class_id;
          const tag = `${cls}${tck.name ? ` (${tck.name})` : ""}`;
          ctx.font = "12px monospace";
          const x = r.x * sc,
            y = r.y * sc,
            w = ctx.measureText(tag).width + 8;
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.5;
          ctx.fillRect(x, y - 18, w, 18);
          ctx.globalAlpha = 1;
          ctx.fillStyle = "#fff";
          ctx.fillText(tag, x + 4, y - 5);
          ctx.restore();
        }
        if (dragRef.current.creating && dr) {
          const x = dr.x * sc,
            y = dr.y * sc,
            w = dr.w * sc,
            h = dr.h * sc;
          ctx.save();
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = "#fff";
          ctx.strokeRect(x, y, w, h);
          const label = `${Math.round(dr.w)}×${Math.round(dr.h)}`;
          ctx.font = "12px monospace";
          const tw = ctx.measureText(label).width + 6;
          const th = 16;
          ctx.fillStyle = "rgba(0,0,0,0.6)";
          ctx.fillRect(x + w - tw, y + h + 4, tw, th);
          ctx.fillStyle = "#fff";
          ctx.fillText(label, x + w - tw + 3, y + h + 16);
          ctx.restore();
        }

        // Prefetch logic integrated into the render loop (skip during fast scrubs and for video)
        if (
          !usingVideo &&
          !scrubActiveRef.current &&
          t - lastDecodeReqRef.current >= decodeIntervalMsRef.current
        ) {
          for (let d = 1; d <= prefetchRadius; d++) {
            const after = f + d;
            if (
              after < total &&
              !cacheRef.current.has(after) &&
              !inFlightRef.current.has(after)
            ) {
              lastDecodeReqRef.current = t;
              void getImage(after);
              break;
            }
            const before = f - d;
            if (
              before >= 0 &&
              !cacheRef.current.has(before) &&
              !inFlightRef.current.has(before)
            ) {
              lastDecodeReqRef.current = t;
              void getImage(before);
              break;
            }
          }
        }

        // Upgrade low-res preview to full-res (avoid during scrubs). For video, rely on exact seek instead of upgrades here.
        if (
          !usingVideo &&
          !scrubActiveRef.current &&
          stride === 1 &&
          drawBmp &&
          drawBmp.width < c.width &&
          !upgradeInFlightRef.current.has(drawIndex)
        ) {
          if (t - lastDecodeReqRef.current >= decodeIntervalMsRef.current) {
            lastDecodeReqRef.current = t;
            upgradeInFlightRef.current.add(drawIndex);
            decodeScaleHintRef.current = 1;
            getImage(drawIndex, 1).then(() => {
              upgradeInFlightRef.current.delete(drawIndex);
            });
          }
        }
      } else {
        // Draw placeholder content if no image is available
        if (videoWorkerRef.current && videoErrorRef.current) {
          ctx.fillStyle = "#300";
          ctx.fillRect(0, 0, c.width, 36);
          ctx.fillStyle = "#f66";
          ctx.font = "14px system-ui, sans-serif";
          ctx.fillText(videoErrorRef.current, 8, 22);
        } else {
          ctx.strokeStyle = "#333";
          ctx.lineWidth = 1;
          for (let gx = 0; gx < c.width; gx += 32) {
            ctx.beginPath();
            ctx.moveTo(gx, 0);
            ctx.lineTo(gx, c.height);
            ctx.stroke();
          }
          for (let gy = 0; gy < c.height; gy += 32) {
            ctx.beginPath();
            ctx.moveTo(0, gy);
            ctx.lineTo(c.width, gy);
            ctx.stroke();
          }
        }
      }

      // Overlays drawn — mark clean and remember which logical frame overlays represent
      overlayDirtyRef.current = false;
      lastOverlayFrameRef.current = f;
    };

    rafIdRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    };
  }, [targetFPS, getImage, prefetchRadius]);

  /** ===== Keyboard ===== */
  // (moved near the end, after all handlers are declared)

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

  useEffect(() => {
    if (!videoWorkerRef.current) return;
    requestVideoFrame(frame, true);
  }, [frame, requestVideoFrame]);

  const onImportVideo = useCallback(async () => {
    try {
      const hasMP4 = typeof window !== "undefined" && (window as any).MP4Box;
      const hasWC = typeof window !== "undefined" && "VideoDecoder" in window;
      if (!hasMP4 || !hasWC) {
        alert("비디오 임포트는 MP4Box + WebCodecs가 필요합니다.");
        return;
      }
      if ("showOpenFilePicker" in window) {
        const [h] = await (window as any).showOpenFilePicker({
          multiple: false,
          types: [{ description: "Video", accept: { "video/mp4": [".mp4"] } }],
        });
        if (h) {
          await loadFromVideoFile(h as FileSystemFileHandle);
          setNeedsImport(false);
          return;
        }
      }
    } catch {
      /* ignore and fallback */
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/mp4";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const handleLike: FileSystemFileHandle = {
        kind: "file",
        name: f.name,
        getFile: async () => f,
        // @ts-ignore
        isSameEntry: async () => false,
      } as any;
      await loadFromVideoFile(handleLike);
      setNeedsImport(false);
    };
    input.click();
  }, [loadFromVideoFile]);

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
    } else if (ev.shiftKey) {
      // 새 트랙 생성 드래그 시작 (Shift+드래그)
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
      // 빈 공간 클릭: 생성하지 않음 (선택 유지)
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
      history.dispatch({
        type: "APPLY_TRACKS",
        payload: history.present,
        meta: { record: true },
      });
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
  const addKeyframe = useCallback(
    (trackId: string, f: number) => {
      const t = tracks.find((t) => t.track_id === trackId);
      if (!t) return;
      const idx = findKFIndexAtOrBefore(t.keyframes, f);
      let r = rectAtFrame(t, f, interpolate);
      if (!r) {
        // Prefer previous rect if exists, otherwise use next rect.
        if (idx >= 0) r = rectFromKF(t.keyframes[idx]);
        if (!r) {
          const next = t.keyframes.find((k) => k.frame >= f);
          if (next) r = rectFromKF(next);
        }
      }
      if (!r) return;
      applyTracks(
        (ts) =>
          ts.map((tt) => {
            if (tt.track_id !== trackId) return tt;
            const kfs = [...tt.keyframes];
            const prevIdx = findKFIndexAtOrBefore(kfs, f);
            if (prevIdx >= 0 && kfs[prevIdx].absent) {
              if (kfs[prevIdx].frame === f)
                kfs[prevIdx] = { ...kfs[prevIdx], absent: false };
              else kfs.splice(prevIdx, 1);
            }
            const updated = { ...tt, keyframes: kfs };
            return ensureKFAt(updated, f, r!);
          }),
        true,
      );
    },
    [tracks, interpolate, applyTracks],
  );

  const addKeyframeAtCurrent = useCallback(() => {
    if (!oneSelected) return;
    addKeyframe(oneSelected.track_id, frame);
  }, [oneSelected, frame, addKeyframe]);

  const deleteKeyframe = useCallback(
    (trackId: string, f: number) => {
      applyTracks(
        (ts) =>
          ts.map((t) => {
            if (t.track_id !== trackId) return t;
            return {
              ...t,
              keyframes: t.keyframes.filter((k) => k.frame !== f),
            };
          }),
        true,
      );
    },
    [applyTracks],
  );

  const deleteKeyframeAtCurrent = useCallback(() => {
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
  }, [oneSelected, frame, applyTracks]);
  const gotoPrevKeyframe = useCallback(() => {
    if (!oneSelected) return;
    const kfs = oneSelected.keyframes;
    const idx = findKFIndexAtOrBefore(kfs, frame - 1);
    const prev = idx >= 0 ? kfs[idx].frame : kfs[0].frame;
    setFrame(prev);
  }, [oneSelected, frame]);

  const gotoNextKeyframe = useCallback(() => {
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
  }, [oneSelected, frame]);

  const togglePresenceAtCurrent = useCallback(() => {
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
  }, [selectedTracks, selectedIds, frame, applyTracks]);

  /** ===== Transt Tracking integration ===== */
  async function getFrameBlobAt(idx: number): Promise<Blob | null> {
    try {
      if (localFiles) {
        const file = await localFiles[idx].handle.getFile();
        return file;
      } else {
        const url = `${framesBaseUrl}/${files[idx]}`;
        const res = await fetch(url, { cache: "force-cache" });
        if (!res.ok) return null;
        return await res.blob();
      }
    } catch {
      return null;
    }
  }

  function isBBoxRelative(b: [number, number, number, number]): boolean {
    const mx = Math.max(
      Math.abs(b[0]),
      Math.abs(b[1]),
      Math.abs(b[2]),
      Math.abs(b[3]),
    );
    return mx <= 1.5; // tolerate tiny float error
  }

  async function ensureSession(): Promise<string> {
    if (!clientRef.current) clientRef.current = new TranstClient();
    if (sessionIdRef.current) return sessionIdRef.current;
    const resp = await clientRef.current.createSession();
    sessionIdRef.current = resp.session_id;
    return resp.session_id;
  }

  function attachAbortListeners() {
    abortRef.current = { active: false };
    const onAbort = () => {
      abortRef.current.active = true;
    };
    const onKey = (e: KeyboardEvent) => {
      // Any navigation or play key cancels
      const keys = new Set([
        "ArrowLeft",
        "ArrowRight",
        "Shift",
        " ",
        "Space",
        "Home",
        "End",
        "PageUp",
        "PageDown",
      ]);
      if (keys.has(e.key)) abortRef.current.active = true;
    };
    window.addEventListener("mousedown", onAbort, { once: false });
    window.addEventListener("wheel", onAbort, { once: false });
    window.addEventListener("keydown", onKey, { once: false });
    return () => {
      window.removeEventListener("mousedown", onAbort);
      window.removeEventListener("wheel", onAbort);
      window.removeEventListener("keydown", onKey);
    };
  }

  async function startTracking(trackOverride?: Track) {
    if (tracking) return;
    if (!meta) return;
    const sel =
      trackOverride ?? tracks.find((t) => selectedIds.has(t.track_id));
    if (!sel || sel.hidden) return;
    const curRect = rectAtFrame(sel, frame, interpolate);
    if (!curRect) return; // no rect or presence hidden

    setPlaying(false);
    setTracking(true);
    const detach = attachAbortListeners();
    try {
      // If no keyframe exactly at current frame, add one
      const hasKFHere = sel.keyframes.some(
        (k) => k.frame === frame && !k.absent,
      );
      if (!hasKFHere) {
        addKeyframe(sel.track_id, frame);
      }

      // Prepare init payload
      const sId = await ensureSession();
      const blob0 = await getFrameBlobAt(frame);
      if (!blob0) throw new Error("frame blob unavailable");
      const img_b64_0 = await blobToBase64(blob0);
      const bbox0: [number, number, number, number] = [
        curRect.x,
        curRect.y,
        curRect.w,
        curRect.h,
      ];
      if (!clientRef.current) clientRef.current = new TranstClient();
      const initResp = await clientRef.current.init(
        sId,
        img_b64_0,
        bbox0,
        sel.transt_target_id,
      );

      // Persist target_id on track
      const targetId = initResp.target_id;
      applyTracks(
        (ts) =>
          ts.map((t) =>
            t.track_id === sel.track_id
              ? { ...t, transt_target_id: targetId }
              : t,
          ),
        true,
      );

      // Iterate forward and update until last frame or abort
      for (
        let f = frame + 1;
        f < (localFiles ? localFiles.length : files.length);
        f++
      ) {
        if (abortRef.current.active) break;
        const blob = await getFrameBlobAt(f);
        if (!blob) break;
        const b64 = await blobToBase64(blob);
        const up = await clientRef.current.update(sId, targetId, b64);
        let [x, y, w, h] = up.bbox_xywh as [number, number, number, number];
        if (isBBoxRelative(up.bbox_xywh)) {
          x *= meta.width;
          y *= meta.height;
          w *= meta.width;
          h *= meta.height;
        }
        // Clamp
        const rx = clamp(x, 0, Math.max(0, meta.width - 1));
        const ry = clamp(y, 0, Math.max(0, meta.height - 1));
        const rw = clamp(w, 1, meta.width - rx);
        const rh = clamp(h, 1, meta.height - ry);
        // Save keyframe
        applyTracks(
          (ts) =>
            ts.map((t) =>
              t.track_id === sel.track_id
                ? ensureKFAt(t, f, { x: rx, y: ry, w: rw, h: rh })
                : t,
            ),
          true,
        );
        setFrame(f);
      }

      // Always drop target when finished
      try {
        await clientRef.current.dropTarget(sId, initResp.target_id);
      } catch {}
    } catch (err) {
      console.error("tracking failed", err);
      try {
        if (
          clientRef.current &&
          sessionIdRef.current &&
          tracks.find((t) => selectedIds.has(t.track_id))?.transt_target_id
        ) {
          await clientRef.current.dropTarget(
            sessionIdRef.current,
            tracks.find((t) => selectedIds.has(t.track_id))!.transt_target_id!,
          );
        }
      } catch {}
    } finally {
      detach();
      setTracking(false);
      abortRef.current.active = false;
    }
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

  /** ===== Coalesced seek for timeline (60Hz) ===== */
  const seekIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seekTargetFrameRef = useRef<number | null>(null);

  const scheduleSeek = useCallback((f: number) => {
    const frame = Math.round(f);
    seekTargetFrameRef.current = frame;

    // If the interval isn't running, start it.
    if (!seekIntervalRef.current) {
      // Also, for responsiveness, apply the very first seek immediately.
      scrubActiveRef.current = true;
      setFrame(frame);
      // If using video worker, immediately request the target frame to minimize lag
      if (videoWorkerRef.current) {
        try {
          videoWorkerRef.current.postMessage({
            type: "seekFrame",
            index: frame,
          });
        } catch {}
      }

      seekIntervalRef.current = setInterval(() => {
        const target = seekTargetFrameRef.current;
        if (target !== null) {
          // A new target has been set since the last interval tick.
          // Apply it and clear it.
          setFrame(target);
          seekTargetFrameRef.current = null;
        } else {
          // No new target was set in the last interval.
          // The user has likely stopped dragging. Stop the interval.
          // Send a final precise seek to ensure exact frame upgrade
          try {
            if (videoWorkerRef.current) {
              videoWorkerRef.current.postMessage({
                type: "seekFrame",
                index: currentFrameRef.current,
                exact: true,
              });
            }
          } catch {}
          if (seekIntervalRef.current) clearInterval(seekIntervalRef.current);
          seekIntervalRef.current = null;
          scrubActiveRef.current = false; // ★ 프리뷰 비활성
        }
      }, 1000 / 60); // ~60Hz
    }
  }, []);

  const totalFrames =
    meta?.count ?? (localFiles ? localFiles.length : files.length);

  // Manual save to localStorage to guarantee persistence on demand
  const saveNow = useCallback(() => {
    try {
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
      // Optional lightweight feedback
      // eslint-disable-next-line no-alert
      alert("Saved");
    } catch (err) {
      console.error(err);
      // eslint-disable-next-line no-alert
      alert("Save failed");
    }
  }, [storagePrefix, meta, labelSet, tracks, frame, interpolate, showGhosts]);

  const clipboardRef = useRef<Track[] | null>(null);

  const copySelectedTracks = useCallback(() => {
    if (!selectedTracks.length) return;
    clipboardRef.current = selectedTracks.map((t) =>
      JSON.parse(JSON.stringify(t)),
    );
  }, [selectedTracks]);

  const pasteTracks = useCallback(() => {
    if (!clipboardRef.current?.length) return;
    const pasted = clipboardRef.current.map((t) => ({
      ...t,
      track_id: `t_${uuid()}`,
      name: (t.name ?? t.track_id) + " (copy)",
    }));
    applyTracks((ts) => [...ts, ...pasted], true);
    setSelectedIds(new Set(pasted.map((t) => t.track_id)));
  }, [applyTracks]);

  // Track Shift pressed state for cursor affordance
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);
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

  return (
    <div className={styles.container}>
      <SLTopBar
        leftTopExtra={leftTopExtra}
        frame={frame}
        totalFrames={totalFrames}
        playing={playing}
        onPrevFrame={() => setFrame((f) => clamp(f - 1, 0, totalFrames - 1))}
        onNextFrame={() => setFrame((f) => clamp(f + 1, 0, totalFrames - 1))}
        onSeek={(val) => scheduleSeek(val)}
        onTogglePlay={() => setPlaying((p) => !p)}
        onTogglePresence={togglePresenceAtCurrent}
        canTogglePresence={!!selectedTracks.length}
        onImportFolder={importFolder}
        onImportVideo={onImportVideo}
        needsImport={needsImport}
        onSave={saveNow}
        onExportJSON={exportJSON}
        onExportYOLO={exportYOLO}
        onOpenShortcuts={() => setKeyUIOpen(true)}
        fps={targetFPS}
        onChangeFPS={(v) => setTargetFPS(v)}
      />

      {/* Viewport + RightPanel */}
      {/* Workspace */}
      <div
        ref={workspaceRef}
        className={styles.workspace}
        data-testid="Workspace"
      >
        {/* Viewport + Timeline */}
        <div className={styles.canvasColumn}>
          {/* Viewport */}
          <div ref={viewportWrapRef} className={styles.viewportWrap}>
            {!meta ? (
              <div style={{ padding: 20 }}>Loading index…</div>
            ) : (
              <canvas
                ref={viewportRef}
                data-testid="Viewport"
                className={styles.viewport}
                style={{
                  aspectRatio: meta
                    ? `${meta!.width} / ${meta!.height}`
                    : undefined,
                  cursor:
                    dragHandle !== "none"
                      ? handleCursor(dragHandle, true)
                      : hoverHandle !== "none"
                        ? handleCursor(hoverHandle, false)
                        : shiftHeld
                          ? "crosshair"
                          : "default",
                }}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
              />
            )}
          </div>
          <SLTimelineSection
            timelineTopBarRef={timelineTopBarRef}
            timelineViewRef={timelineViewRef}
            timelineResizerRef={timelineResizerRef}
            timelineHeight={timelineHeight}
            frame={frame}
            totalFrames={totalFrames}
            onPrevFrame={() =>
              setFrame((f) => clamp(f - 1, 0, totalFrames - 1))
            }
            onNextFrame={() =>
              setFrame((f) => clamp(f + 1, 0, totalFrames - 1))
            }
            onAddKeyframeAtCurrent={addKeyframeAtCurrent}
            oneSelected={!!oneSelected}
            timelineWidth={timelineWidth}
            scheduleSeek={scheduleSeek}
            tracks={tracks}
            labelSet={labelSet}
            selectedIds={selectedIds}
            onSelectTrack={(tid, additive) => {
              setSelectedIds((prev) => {
                if (additive) {
                  const n = new Set(prev);
                  if (n.has(tid)) n.delete(tid);
                  else n.add(tid);
                  return n;
                }
                return new Set([tid]);
              });
            }}
            onDeleteKeyframe={deleteKeyframe}
            onAddKeyframe={addKeyframe}
            hiddenClasses={hiddenClasses}
            rowHeight={16}
            onStartResize={(ev) => {
              ev.preventDefault();
              const startY = ev.clientY;
              const startH =
                timelineViewRef.current?.getBoundingClientRect().height ??
                timelineHeight ??
                200;
              const workspaceRect =
                workspaceRef.current?.getBoundingClientRect();
              const topBarH =
                timelineTopBarRef.current?.getBoundingClientRect().height ?? 0;
              const totalH = workspaceRect?.height ?? 0;
              const minH = 80;
              const maxH = Math.max(
                minH,
                Math.min(totalH - topBarH - 120, 600),
              );
              const onMove = (e: MouseEvent) => {
                const dy = e.clientY - startY;
                // Resizer is above the timeline: moving down should reduce height
                const next = Math.max(minH, Math.min(startH - dy, maxH));
                resizeCurrHRef.current = next;
                if (resizeRafRef.current)
                  cancelAnimationFrame(resizeRafRef.current);
                resizeRafRef.current = requestAnimationFrame(() => {
                  if (timelineViewRef.current) {
                    timelineViewRef.current.style.height = `${next}px`;
                  }
                });
              };
              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
                if (resizeRafRef.current)
                  cancelAnimationFrame(resizeRafRef.current);
                if (resizeCurrHRef.current != null)
                  setTimelineHeight(resizeCurrHRef.current);
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
          />
        </div>

        {/* RightPanel */}
        <SLRightPanel
          labelSet={labelSet}
          setLabelSet={(fn) => startTransition(() => setLabelSet(fn(labelSet)))}
          availableSets={availableSets}
          setAvailableSets={setAvailableSets}
          tracks={tracks}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          applyTracks={applyTracks}
          hiddenClasses={hiddenClasses}
          setHiddenClasses={(fn) => setHiddenClasses(fn(hiddenClasses))}
          showGhosts={showGhosts}
          setShowGhosts={setShowGhosts}
          interpolate={interpolate}
          setInterpolate={setInterpolate}
          onCopySelectedTracks={copySelectedTracks}
          onPasteTracks={pasteTracks}
          canPaste={!!clipboardRef.current?.length}
          onTrack={(t) => startTracking(t)}
          canTrackAtFrame={(t) => {
            if (!meta) return false;
            const r = rectAtFrame(t, frame, interpolate);
            return !!r && !t.hidden && !tracking;
          }}
        />
      </div>

      {/* Bottom help removed (relocated into right panel) */}

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
};

export default SequenceLabeler;
