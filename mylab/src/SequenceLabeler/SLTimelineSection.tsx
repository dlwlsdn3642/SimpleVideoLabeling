import type { RefObject, FC } from "react";
import styles from "./SequenceLabeler.module.css";
import { Timeline } from "../components";
import type { Track, LabelSet } from "../types";
import { shouldInjectError } from "../utils/debug";

/* Timeline */

type Props = {
  timelineToolbarRef: RefObject<HTMLDivElement | null>;
  timelineViewRef: RefObject<HTMLDivElement | null>;
  timelineResizerRef?: RefObject<HTMLDivElement | null>;
  timelineHeight?: number | null;
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
  hiddenClasses: Set<number>;
  rowHeight?: number;
  onStartResize?: (ev: React.MouseEvent<HTMLDivElement>) => void;
};

const SLTimelineSection: FC<Props> = ({
  timelineToolbarRef,
  timelineViewRef,
  timelineResizerRef,
  timelineHeight,
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
  hiddenClasses,
  rowHeight = 20,
  onStartResize,
}) => {
  if (shouldInjectError('SLTimelineSection')) {
    throw new Error('Injected error: SLTimelineSection');
  }
  return (
    <div data-testid="Timeline">
      <div ref={timelineToolbarRef} className={styles.timelineToolbar} data-testid="TimelineToolbar">
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
      <div
        ref={timelineResizerRef}
        className={styles.timelineResizer}
        data-testid="TimelineResizer"
        onMouseDown={onStartResize}
      />

      <div
        ref={timelineViewRef}
        className={styles.timelineView}
        data-testid="TimelineView"
        style={timelineHeight != null ? { height: `${timelineHeight}px` } : undefined}
      >
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
          hiddenClasses={hiddenClasses}
          rowHeight={rowHeight}
        />
      </div>
    </div>
  );
};

export default SLTimelineSection;
