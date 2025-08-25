import { useCallback, useEffect, useRef, useState } from "react";
import type { IndexMeta, LocalFile } from "../../types";
import { loadDirHandle, saveDirHandle, loadFileHandle, saveFileHandle } from "../../utils/handles";

type DirHandleWithPerm = FileSystemDirectoryHandle & {
  queryPermission?: (opts: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
};

type Params = {
  framesBaseUrl: string;
  indexUrl: string;
  storagePrefix: string;
  onResetMedia: () => void; // clears canvas/cache/last-drawn in caller
  onFolderImported?: (name: string) => void;
  latestVideoFrameRef: React.MutableRefObject<{ idx: number; bmp: ImageBitmap } | null>;
  videoErrorRef: React.MutableRefObject<string | null>;
};

export function useMediaSource({ framesBaseUrl: _framesBaseUrl, indexUrl, storagePrefix, onResetMedia, onFolderImported, latestVideoFrameRef, videoErrorRef }: Params) {
  const [meta, setMeta] = useState<IndexMeta | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [localFiles, setLocalFiles] = useState<LocalFile[] | null>(null);
  const [needsImport, setNeedsImport] = useState(false);

  const videoWorkerRef = useRef<Worker | null>(null);
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
          videoWorkerRef.current.postMessage({ type: 'seekFrame', index: pendingVideoSeekRef.current, exact });
        } catch { /* noop */ }
      }
      videoSeekScheduledRef.current = false;
    });
  }, []);

  const clearWorkers = useCallback(() => {
    try { videoWorkerRef.current?.terminate(); } catch { /* noop */ }
    videoWorkerRef.current = null;
    videoFileHandleRef.current = null;
  }, []);

  const loadFromDir = useCallback(async (dir: FileSystemDirectoryHandle) => {
    const entries: LocalFile[] = [];
    for await (const entry of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
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
      const pa = a.name.replace(/\D+/g, "");
      const pb = b.name.replace(/\D+/g, "");
      const na = pa ? parseInt(pa, 10) : NaN;
      const nb = pb ? parseInt(pb, 10) : NaN;
      if (Number.isNaN(na) && Number.isNaN(nb)) return a.name.localeCompare(b.name);
      if (Number.isNaN(na)) return 1;
      if (Number.isNaN(nb)) return -1;
      return na - nb;
    });

    const first = await entries[0].handle.getFile();
    const bmp = await createImageBitmap(first);
    const m: IndexMeta = { width: bmp.width, height: bmp.height, fps: 30, count: entries.length, files: entries.map((e) => e.name) };
    onResetMedia();
    setMeta(m);
    setLocalFiles(entries);
    setFiles([]);
  }, [onResetMedia]);

  const loadFromVideoFile = useCallback(async (fileHandle: FileSystemFileHandle) => {
    try {
      videoErrorRef.current = null;
      const hasMP4 = typeof window !== 'undefined' && (window as any).MP4Box;
      const hasWC = typeof window !== 'undefined' && 'VideoDecoder' in window;
      if (!hasMP4 || !hasWC) {
        alert('This video feature requires MP4Box and WebCodecs.');
        return;
      }
      const file = await fileHandle.getFile();
      videoFileHandleRef.current = fileHandle;
      clearWorkers();
      const vw = new Worker(new URL('../../workers/videoWorker.ts', import.meta.url), { type: 'module' });
      videoWorkerRef.current = vw;
      vw.onmessage = async (e: MessageEvent) => {
        const m: any = e.data;
        if (!m) return;
        switch (m.type) {
          case 'hello':
            vw.postMessage({ type: 'init', fileSize: file.size, initBytes: Math.min(4 * 1024 * 1024, file.size) });
            break;
          case 'need':
            try {
              const { start, end } = m as { start: number; end: number };
              const blob = file.slice(start, end + 1);
              const buf = await blob.arrayBuffer();
              vw.postMessage({ type: 'bytes', start, end, buf }, [buf]);
            } catch (err) {
              videoErrorRef.current = 'File read error';
              console.error('video bytes supply failed', err);
            }
            break;
          case 'ready': {
            const { width, height, frames, fps } = m;
            onResetMedia();
            setMeta({ width, height, fps, count: frames, files: [] });
            setLocalFiles(null);
            setFiles([]);
            requestVideoFrame(0);
            break;
          }
          case 'frame': {
            const { frameIdx, bitmap } = m as { frameIdx: number; bitmap: ImageBitmap };
            latestVideoFrameRef.current = { idx: frameIdx, bmp: bitmap };
            break;
          }
          case 'fatal':
            videoErrorRef.current = String(m.error || 'Video worker error');
            console.error('[videoWorker] fatal', m.error);
            break;
          case 'log':
            console.log('[videoWorker] log', m.msg);
            break;
        }
      };
      await saveFileHandle(`${storagePrefix}::video_file`, fileHandle);
    } catch (err) {
      alert('Failed to load video file.');
      console.error(err);
    }
  }, [onResetMedia, requestVideoFrame, storagePrefix, videoErrorRef, clearWorkers, latestVideoFrameRef]);

  const onImportVideo = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/mp4,video/*';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const handleLike: FileSystemFileHandle = { kind: 'file', name: f.name, getFile: async () => f } as any;
      await loadFromVideoFile(handleLike);
      setNeedsImport(false);
    };
    input.click();
  }, [loadFromVideoFile]);

  const importFolder = useCallback(async () => {
    if (!("showDirectoryPicker" in window)) {
      alert("Chromium 계열 브라우저에서 사용하세요.");
      return;
    }
    const dir: FileSystemDirectoryHandle = await (window as unknown as { showDirectoryPicker: (opts: { id: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: storagePrefix });
    await loadFromDir(dir);
    await saveDirHandle(storagePrefix, dir);
    setNeedsImport(false);
    onFolderImported?.(dir.name);
  }, [storagePrefix, loadFromDir, onFolderImported]);

  // Reset media when storagePrefix changes
  useEffect(() => {
    clearWorkers();
    onResetMedia();
    setMeta(null);
    setFiles([]);
    setLocalFiles(null);
    setNeedsImport(false);
    videoErrorRef.current = null;
  }, [storagePrefix]);

  // Initial load: restore handles or fetch index
  useEffect(() => {
    let aborted = false;
    (async () => {
      try {
        const handle = await loadDirHandle(storagePrefix);
        if (handle && (await (handle as DirHandleWithPerm).queryPermission?.({ mode: "read" })) === "granted") {
          await loadFromDir(handle);
          setNeedsImport(false);
          onFolderImported?.(handle.name);
          return;
        }
      } catch { /* ignore */ }
      try {
        const hasMP4 = typeof window !== 'undefined' && (window as any).MP4Box;
        const hasWC = typeof window !== 'undefined' && 'VideoDecoder' in window;
        if (hasMP4 && hasWC) {
          const vfh = await loadFileHandle(`${storagePrefix}::video_file`);
          if (vfh) {
            await loadFromVideoFile(vfh);
            setNeedsImport(false);
            return;
          }
        }
      } catch { /* ignore */ }
      try {
        const r = await fetch(indexUrl);
        if (!r.ok) throw new Error(`index fetch ${r.status}`);
        const raw = await r.text();
        let m: IndexMeta;
        try { m = JSON.parse(raw) as IndexMeta; }
        catch (err) {
          console.warn("index meta parse error", err, { contentType: r.headers.get("content-type"), bodyPreview: raw.slice(0, 200) });
          setNeedsImport(true);
          return;
        }
        if (aborted) return;
        setMeta(m);
        if (m.files?.length) setFiles(m.files);
        else {
          const padW = m.zeroPad ?? Math.max(6, String(Math.max(0, m.count - 1)).length);
          const gen = Array.from({ length: m.count }, (_, i) => `${String(i).padStart(padW, '0')}.jpg`);
          setFiles(gen);
        }
      } catch { setNeedsImport(true); }
    })();
    return () => { aborted = true; };
  }, [storagePrefix, indexUrl, loadFromDir, loadFromVideoFile, onFolderImported]);

  return { meta, files, localFiles, needsImport, setNeedsImport, videoWorkerRef, requestVideoFrame, loadFromDir, importFolder, onImportVideo } as const;
}
