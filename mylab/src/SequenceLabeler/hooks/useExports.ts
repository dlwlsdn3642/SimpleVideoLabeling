import { useCallback } from "react";
import type { IndexMeta, LabelSet, Track } from "../../types";
import { DEFAULT_SCHEMA, DEFAULT_VERSION } from "../../constants";

type Params = {
  storagePrefix: string;
  meta: IndexMeta | null;
  files: string[];
  localFiles: { name: string }[] | null;
  labelSet: LabelSet;
  tracks: Track[];
  frame: number;
  interpolate: boolean;
};

export function useExports({ storagePrefix, meta, files, localFiles, labelSet, tracks, frame, interpolate }: Params) {
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
          showGhosts: true, // kept for compatibility; UI drives this elsewhere
        })
      );
      alert("Saved");
    } catch (err) {
      console.error(err);
      alert("Save failed");
    }
  }, [storagePrefix, meta, labelSet, tracks, frame, interpolate]);

  const exportJSON = useCallback(() => {
    if (!meta) return;
    const total = localFiles ? localFiles.length : files.length;
    const out = {
      schema: DEFAULT_SCHEMA,
      version: DEFAULT_VERSION,
      meta: { width: meta.width, height: meta.height, fps: meta.fps ?? 30, count: total },
      label_set: labelSet,
      files: localFiles ? localFiles.map((f) => f.name) : files,
      tracks: tracks.map((t) => ({
        track_id: t.track_id,
        class_id: t.class_id,
        name: t.name,
        keyframes: t.keyframes.map((k) => ({ frame: k.frame, bbox_xywh: k.bbox_xywh, ...(k.absent ? { absent: true } : {}) })),
      })),
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "labels_v1.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [meta, localFiles, files, labelSet, tracks]);

  const exportYOLO = useCallback(async () => {
    if (!meta) return;
    if (!("showDirectoryPicker" in window)) {
      alert("Chromium 계열 브라우저에서 사용하세요.");
      return;
    }
    const dir: FileSystemDirectoryHandle = await (window as unknown as { showDirectoryPicker: (opts: { id: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: "yolo-export" });
    const total = localFiles ? localFiles.length : files.length;
    const names = localFiles ? localFiles.map((f) => f.name) : files;
    const perFrame: string[][] = Array.from({ length: total }, () => []);
    for (const t of tracks) {
      for (let f = 0; f < total; f++) {
        const k = t.keyframes.find((k) => k.frame === f && !k.absent);
        if (!k) continue;
        const [x, y, w, h] = k.bbox_xywh;
        const cx = (x + w / 2) / meta.width;
        const cy = (y + h / 2) / meta.height;
        const ww = w / meta.width;
        const hh = h / meta.height;
        perFrame[f].push(`${t.class_id} ${cx.toFixed(6)} ${cy.toFixed(6)} ${ww.toFixed(6)} ${hh.toFixed(6)}`);
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
  }, [meta, localFiles, files, tracks]);

  return { saveNow, exportJSON, exportYOLO };
}

