import { useCallback, useRef, useState } from "react";
import type { IndexMeta, Track } from "../../types";
import { TranstClient, blobToBase64 } from "../../lib/transtClient";
import { ensureKFAt } from "../../utils/tracks";
import { clamp, rectAtFrame } from "../../utils/geom";

type Params = {
  meta: IndexMeta | null;
  frame: number;
  files: string[];
  localFiles: { name: string; handle: FileSystemFileHandle }[] | null;
  tracks: Track[];
  selectedIds: Set<string>;
  interpolate: boolean;
  applyTracks: (updater: (ts: Track[]) => Track[], record?: boolean) => void;
  setFrame: (f: number) => void;
};

export function useTranstTracking({ meta, frame, files, localFiles, tracks, selectedIds, interpolate, applyTracks, setFrame }: Params) {
  const [tracking, setTracking] = useState(false);
  const clientRef = useRef<TranstClient | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<{ active: boolean; reason?: string }>({ active: false });

  const getFrameBlobAt = useCallback(async (idx: number): Promise<Blob | null> => {
    try {
      if (localFiles) {
        const file = await localFiles[idx].handle.getFile();
        return file;
      } else {
        const url = `${location.origin}/${files[idx]}`; // framesBaseUrl must be absolute in caller for remote
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) return null;
        return await res.blob();
      }
    } catch {
      return null;
    }
  }, [files, localFiles]);

  const ensureSession = useCallback(async () => {
    if (!clientRef.current) clientRef.current = new TranstClient();
    if (sessionIdRef.current) return sessionIdRef.current;
    const resp = await clientRef.current.createSession();
    sessionIdRef.current = resp.session_id;
    return resp.session_id;
  }, []);

  const attachAbortListeners = useCallback(() => {
    abortRef.current = { active: false };
    const onAbort = () => { abortRef.current.active = true; };
    const onKey = (e: KeyboardEvent) => {
      const keys = new Set(['ArrowLeft', 'ArrowRight', 'Shift', ' ', 'Space', 'Home', 'End', 'PageUp', 'PageDown']);
      if (keys.has(e.key)) abortRef.current.active = true;
    };
    window.addEventListener('mousedown', onAbort);
    window.addEventListener('wheel', onAbort);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onAbort);
      window.removeEventListener('wheel', onAbort);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const startTracking = useCallback(async (trackOverride?: Track) => {
    if (tracking || !meta) return;
    const sel = trackOverride ?? tracks.find((t) => selectedIds.has(t.track_id));
    if (!sel || sel.hidden) return;
    const curRect = rectAtFrame(sel, frame, interpolate);
    if (!curRect) return;

    setTracking(true);
    const detach = attachAbortListeners();
    try {
      const hasKFHere = sel.keyframes.some((k) => k.frame === frame && !k.absent);
      if (!hasKFHere) {
        applyTracks((ts) => ts.map((t) => t.track_id === sel.track_id ? ensureKFAt(t, frame, curRect) : t), true);
      }
      const sId = await ensureSession();
      const blob0 = await getFrameBlobAt(frame);
      if (!blob0) throw new Error('frame blob unavailable');
      const img_b64_0 = await blobToBase64(blob0);
      const bbox0: [number, number, number, number] = [curRect.x, curRect.y, curRect.w, curRect.h];
      if (!clientRef.current) clientRef.current = new TranstClient();
      const initResp = await clientRef.current.init(sId, img_b64_0, bbox0, sel.transt_target_id);

      const targetId = initResp.target_id;
      applyTracks((ts) => ts.map((t) => t.track_id === sel.track_id ? { ...t, transt_target_id: targetId } : t), true);

      const last = localFiles ? localFiles.length : files.length;
      for (let f = frame + 1; f < last; f++) {
        if (abortRef.current.active) break;
        const blob = await getFrameBlobAt(f);
        if (!blob) break;
        const b64 = await blobToBase64(blob);
        const up = await clientRef.current.update(sId, targetId, b64);
        let [x, y, w, h] = up.bbox_xywh as [number, number, number, number];
        const rel = Math.max(Math.abs(x), Math.abs(y), Math.abs(w), Math.abs(h)) <= 1.5;
        if (rel) { x *= meta.width; y *= meta.height; w *= meta.width; h *= meta.height; }
        const rx = clamp(x, 0, Math.max(0, meta.width - 1));
        const ry = clamp(y, 0, Math.max(0, meta.height - 1));
        const rw = clamp(w, 1, meta.width - rx);
        const rh = clamp(h, 1, meta.height - ry);
        applyTracks((ts) => ts.map((t) => t.track_id === sel.track_id ? ensureKFAt(t, f, { x: rx, y: ry, w: rw, h: rh }) : t), true);
        setFrame(f);
      }
      try { await clientRef.current.dropTarget(sId, targetId); } catch { /* noop */ }
    } catch (err) {
      console.error('tracking failed', err);
      try {
        if (clientRef.current && sessionIdRef.current && (tracks.find(t => selectedIds.has(t.track_id))?.transt_target_id)) {
          await clientRef.current.dropTarget(sessionIdRef.current, tracks.find(t => selectedIds.has(t.track_id))!.transt_target_id!);
        }
      } catch { /* noop */ }
    } finally {
      detach();
      setTracking(false);
      abortRef.current.active = false;
    }
  }, [tracking, meta, tracks, selectedIds, frame, interpolate, applyTracks, setFrame, ensureSession, getFrameBlobAt, attachAbortListeners]);

  const canTrackAtFrame = useCallback((t: Track) => {
    if (!meta) return false;
    const r = rectAtFrame(t, frame, interpolate);
    return !!r && !t.hidden && !tracking;
  }, [meta, frame, interpolate, tracking]);

  return { tracking, startTracking, canTrackAtFrame };
}

