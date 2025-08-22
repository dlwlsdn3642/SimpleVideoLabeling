import type React from "react";
import styles from "./SequenceLabeler.module.css";
import type { LabelSet, Track } from "../types";
import { TrackPanel } from "../components";
import { shouldInjectError } from "../utils/debug";

/* RightPanel */

type Props = {
  labelSet: LabelSet;
  setLabelSet: (updater: (s: LabelSet) => LabelSet) => void;
  availableSets: LabelSet[];
  setAvailableSets: (sets: LabelSet[]) => void;
  tracks: Track[];
  selectedIds: Set<string>;
  setSelectedIds: (s: Set<string>) => void;
  applyTracks: (updater: (ts: Track[]) => Track[], record?: boolean) => void;
  hiddenClasses: Set<number>;
  setHiddenClasses: (updater: (prev: Set<number>) => Set<number>) => void;
  showGhosts: boolean;
  setShowGhosts: (v: boolean) => void;
  interpolate: boolean;
  setInterpolate: (v: boolean) => void;
  onCopySelectedTracks: () => void;
  onPasteTracks: () => void;
  canPaste: boolean;
  onTrack?: (t: Track) => void;
};

const SLRightPanel: React.FC<Props> = ({
  labelSet,
  setLabelSet,
  availableSets,
  setAvailableSets,
  tracks,
  selectedIds,
  setSelectedIds,
  applyTracks,
  hiddenClasses,
  setHiddenClasses,
  showGhosts,
  setShowGhosts,
  interpolate,
  setInterpolate,
  onCopySelectedTracks,
  onPasteTracks,
  canPaste,
  onTrack,
}) => {
  if (shouldInjectError('SLRightPanel')) {
    throw new Error('Injected error: SLRightPanel');
  }
  return (
    <div className={styles.rightPanel} data-testid="RightPanel">
      {/* View options */}
      <div className={styles.viewOptions}>
        <label className={styles.inlineLabel}>
          <input
            type="checkbox"
            checked={showGhosts}
            onChange={(e) => setShowGhosts(e.target.checked)}
          />
          <span>Show ghosts (prev/next)</span>
        </label>
        <label className={styles.inlineLabel}>
          <input
            type="checkbox"
            checked={interpolate}
            onChange={(e) => setInterpolate(e.target.checked)}
          />
          <span>Interpolate</span>
        </label>
      </div>

      {/* Label set */}
      <div className={styles.labelSection}>
        <div className={styles.sectionTitle}>Label Set</div>
        <div className={styles.labelRow}>
          <select
            value={labelSet.name}
            aria-label="Select label set"
            onChange={(e) => {
              const name = e.target.value;
              const raw = localStorage.getItem("sequence_label_sets_v1");
              if (!raw) return;
              try {
                const sets: LabelSet[] = JSON.parse(raw);
                const s = sets.find((x) => x.name === name);
                if (s)
                  setLabelSet((prev) => ({
                    name: s.name,
                    classes: [...s.classes],
                    colors: s.colors ?? s.classes.map((_, i) => prev.colors[i] ?? "#4ea3ff"),
                  }));
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
              const name = prompt("Save label set as:", labelSet.name || "Set");
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
                localStorage.setItem("sequence_label_sets_v1", JSON.stringify(sets));
                setLabelSet((s) => ({ ...s, name }));
              }
            }}
          >
            Save
          </button>
        </div>

        {/* Classes editor */}
        <div className={styles.classesList}>
          <div className={styles.sectionSubtitle}>Classes</div>
          {labelSet.classes.map((c, i) => (
            <div key={i} className={styles.classRow}>
              <span className={styles.classIndex}>{i + 1}.</span>
              <input
                className={styles.inputText}
                aria-label={`Class ${i + 1} name`}
                value={c}
                onChange={(e) =>
                  setLabelSet((s) => ({
                    ...s,
                    classes: s.classes.map((x, idx) => (idx === i ? e.target.value : x)),
                  }))
                }
              />
              <input
                className={styles.inputColor}
                type="color"
                aria-label={`Class ${i + 1} color`}
                value={labelSet.colors[i]}
                onChange={(e) => {
                  const val = e.target.value;
                  setLabelSet((s) => ({
                    ...s,
                    colors: s.colors.map((col, idx) => (idx === i ? val : col)),
                  }));
                }}
              />
              <button
                aria-label={`Remove class ${i + 1}`}
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
            className={styles.classAdd}
            onClick={() =>
              setLabelSet((s) => ({
                ...s,
                classes: [...s.classes, `Class${s.classes.length + 1}`],
                colors: [...s.colors, s.colors[(s.colors.length - 1) % s.colors.length] || "#4ea3ff"],
              }))
            }
          >
            + Add Class
          </button>
        </div>
      </div>

      {/* Tracks */}
      <div className={styles.tracksSection}>
        <div className={styles.tracksHeader}>
          <div className={styles.sectionTitle}>Tracks</div>
          <div className={styles.tracksActions}>
            <button onClick={onCopySelectedTracks} disabled={!selectedIds.size}>Copy</button>
            <button onClick={onPasteTracks} disabled={!canPaste}>Paste</button>
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
          hiddenClasses={hiddenClasses}
          setHiddenClasses={setHiddenClasses}
          onTrack={onTrack}
        />
      </div>

      <div className={styles.shortcutHelp}>
        Frames: ←/→ ±1, Shift+←/Shift+→ ±10, Ctrl+←/Ctrl+→ ±100, Space Play ·
        KF: K add, Shift+K del, , prev, . next · Presence: N toggle ·
        View: I interpolate, G ghosts · Multi-move: Alt+드래그 · Copy/Paste: Ctrl+C / Ctrl+V · 1~9 pick class
      </div>
    </div>
  );
};

export default SLRightPanel;
