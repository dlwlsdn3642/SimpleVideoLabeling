import React, { RefObject } from "react";
import styles from "./SequenceLabeler.module.css";
import { Timeline } from "../components";
import type { Track, LabelSet } from "../types";
import { clamp } from "../utils/geom";

type Props = {
  timelineBarRef: RefObject<HTMLDivElement>;
  timelineWrapRef: RefObject<HTMLDivElement>;
  frame: number;
  totalFrames: number;
  onPrevFrame: () => void;
  onNextFrame: () => void;
  onAddKeyframeAtCurrent: () => void;
  oneSelected: boolean;
  timelineWidth: number;
  scheduleSeek: (f: number) => void;
  tracks: Track[];
  labelSet: LabelSet;
  selectedIds: Set<string>;
  onSelectTrack: (tid: string, additive: boolean) => void;
  onDeleteKeyframe: (trackId: string, frame: number) => void;
  onAddKeyframe: (trackId: string, frame: number) => void;
};

const SLTimelineSection: React.FC<Props> = ({
  timelineBarRef,
  timelineWrapRef,
  frame,
  totalFrames,
  onPrevFrame,
  onNextFrame,
  onAddKeyframeAtCurrent,
  oneSelected,
  timelineWidth,
  scheduleSeek,
  tracks,
  labelSet,
  selectedIds,
  onSelectTrack,
  onDeleteKeyframe,
  onAddKeyframe,
}) => {
  return (
    <>
      <div ref={timelineBarRef} className={styles.timelineBar}>
        <button title="Prev frame" onClick={onPrevFrame} aria-label="Previous frame">←</button>
        <button title="Next frame" onClick={onNextFrame} aria-label="Next frame">→</button>
        <span style={{ opacity: 0.85 }}>
          Frame {totalFrames ? frame + 1 : "—"}/{totalFrames || "—"}
        </span>
        <button
          title="Add keyframe at current (K)"
          onClick={onAddKeyframeAtCurrent}
          disabled={!oneSelected}
          style={{ marginLeft: 8 }}
          aria-label="Add keyframe"
        >
          + Add Keyframe
        </button>
      </div>

      <div ref={timelineWrapRef} className={styles.timelineWrap}>
        <Timeline
          total={totalFrames || 1}
          frame={frame}
          onSeek={scheduleSeek}
          tracks={tracks}
          labelSet={labelSet}
          onDeleteKeyframe={onDeleteKeyframe}
          onAddKeyframe={onAddKeyframe}
          width={timelineWidth}
          selectedIds={selectedIds}
          onSelectTrack={onSelectTrack}
        />
      </div>
    </>
  );
};

export default SLTimelineSection;

