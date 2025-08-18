import type React from "react";
import styles from "./SequenceLabeler.module.css";
import { shouldInjectError } from "../utils/debug";

/* TopBar */

type Props = {
  leftTopExtra?: React.ReactNode;
  frame: number;
  totalFrames: number;
  playing: boolean;
  onPrevFrame: () => void;
  onNextFrame: () => void;
  onSeek: (value: number) => void;
  onTogglePlay: () => void;
  onTogglePresence: () => void;
  canTogglePresence: boolean;
  onImportFolder: () => void;
  needsImport: boolean;
  onSave: () => void;
  onExportJSON: () => void;
  onExportYOLO: () => void;
  onOpenShortcuts: () => void;
  fps: number;
  onChangeFPS: (fps: number) => void;
};

const SLTopBar: React.FC<Props> = ({
  leftTopExtra,
  frame,
  totalFrames,
  playing,
  onPrevFrame,
  onNextFrame,
  onSeek,
  onTogglePlay,
  onTogglePresence,
  canTogglePresence,
  onImportFolder,
  needsImport,
  onSave,
  onExportJSON,
  onExportYOLO,
  onOpenShortcuts,
  fps,
  onChangeFPS,
}) => {
  if (shouldInjectError('SLTopBar')) {
    throw new Error('Injected error: SLTopBar');
  }
  return (
    <div className={styles.topBar} data-testid="TopBar">
      {leftTopExtra ? (
        <div style={{ marginRight: 8, display: "flex", alignItems: "center" }}>{leftTopExtra}</div>
      ) : null}
      <button onClick={onPrevFrame} aria-label="Previous frame">←</button>
      <input
        type="range"
        min={0}
        max={Math.max(0, totalFrames - 1)}
        value={frame}
        onChange={(e) => onSeek(parseInt(e.target.value))}
        className={styles.seekRange}
      />
      <button onClick={onNextFrame} aria-label="Next frame">→</button>
      <button onClick={onTogglePlay} aria-label={playing ? "Pause" : "Play"}>
        {playing ? "Pause" : "Play"}
      </button>
      <span style={{ opacity: 0.85 }}>Frame {frame + 1}/{totalFrames || "—"}</span>

      <label style={{ marginLeft: 12 }}>
        FPS
        <select
          aria-label="Target FPS"
          value={fps}
          onChange={(e) => onChangeFPS(parseInt(e.target.value, 10))}
          style={{ marginLeft: 6 }}
        >
          <option value={30}>30</option>
          <option value={45}>45</option>
          <option value={60}>60</option>
        </select>
      </label>

      <button onClick={onTogglePresence} disabled={!canTogglePresence}>Toggle Presence (N)</button>

      <button style={{ marginLeft: "auto" }} onClick={onImportFolder}>Import Folder</button>
      {needsImport && (
        <span style={{ color: "#f66" }}>Load failed. Use Import Folder.</span>
      )}
      <button onClick={onSave}>Save</button>
      <button onClick={onExportJSON}>Export JSON</button>
      <button onClick={onExportYOLO}>Export YOLO</button>
      <button onClick={onOpenShortcuts}>Shortcuts</button>
    </div>
  );
};

export default SLTopBar;
