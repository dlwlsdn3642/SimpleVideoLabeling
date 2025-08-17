import React, { useRef } from "react";
import type { Track, LabelSet } from "../types";
import { clamp } from "../utils/geom";

type Props = {
  total: number;
  frame: number;
  onSeek: (f: number) => void;
  tracks: Track[];
  labelSet: LabelSet;
  onDeleteKeyframe: (trackId: string, frame: number) => void;
  onAddKeyframe: (trackId: string, frame: number) => void;
  width?: number;
  rowHeight?: number;
};

const Timeline: React.FC<Props> = ({
  total,
  frame,
  onSeek,
  tracks,
  labelSet,
  onDeleteKeyframe,
  onAddKeyframe,
  width = 800,
  rowHeight = 20,
}) => {
  const margin = 8;
  const innerW = Math.max(1, width - margin * 2);
  const step = innerW / Math.max(1, total);
  const height = margin * 2 + rowHeight * tracks.length;
  const innerH = height - margin * 2;
  const scaleX = (f: number) => margin + f * step;
  const centerX = (f: number) => margin + (f + 0.5) * step;

  const draggingRef = useRef(false);
  const getPosFromEvent = (
    ev: React.PointerEvent<SVGSVGElement> | React.MouseEvent<SVGSVGElement>,
  ) => {
    const rect = (ev.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x = ev.clientX - rect.left - margin;
    const y = ev.clientY - rect.top - margin;
    const f = clamp(Math.floor(x / step), 0, total - 1);
    const trackIdx = Math.floor(y / rowHeight);
    return { f, trackIdx };
  };
  const seekFromEvent = (ev: React.PointerEvent<SVGSVGElement>) => {
    const { f } = getPosFromEvent(ev);
    onSeek(f);
  };
  const onPointerDown = (ev: React.PointerEvent<SVGSVGElement>) => {
    ev.preventDefault();
    document.body.style.userSelect = "none";
    draggingRef.current = true;
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    seekFromEvent(ev);
  };
  const onPointerMove = (ev: React.PointerEvent<SVGSVGElement>) => {
    if (!draggingRef.current) return;
    seekFromEvent(ev);
  };
  const onPointerUp = (ev: React.PointerEvent<SVGSVGElement>) => {
    draggingRef.current = false;
    (ev.target as Element).releasePointerCapture?.(ev.pointerId);
    document.body.style.userSelect = "";
  };
  const onWheel = (ev: React.WheelEvent<SVGSVGElement>) => {
    ev.preventDefault();
    const delta = ev.deltaY > 0 ? 1 : -1;
    onSeek(clamp(frame + delta, 0, total - 1));
  };

  const frameHasKF = (f: number) =>
    tracks.some((t) => t.keyframes.some((k) => k.frame === f));

  return (
    <svg
      width={width}
      height={height}
      style={{ display: "block", width: "100%", userSelect: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onDoubleClick={(ev) => {
        ev.preventDefault();
        document.getSelection()?.removeAllRanges();
        const { f, trackIdx } = getPosFromEvent(ev);
        if (trackIdx >= 0 && trackIdx < tracks.length) {
          onAddKeyframe(tracks[trackIdx].track_id, f);
        }
      }}
      onContextMenu={(ev) => ev.preventDefault()}
    >
      <rect
        x={0}
        y={0}
        width={width}
        height={height}
        fill="#161616"
        stroke="#333"
      />

      {Array.from({ length: total }, (_, f) => (
        <rect
          key={`grid-${f}`}
          x={scaleX(f)}
          y={margin}
          width={step}
          height={innerH}
          fill="none"
          stroke="#333"
        >
          <title>{`Frame ${f}${frameHasKF(f) ? " (keyframe)" : ""}`}</title>
        </rect>
      ))}

      {tracks.map((t, idx) => {
        const y = margin + rowHeight * idx;
        const color = labelSet.colors[t.class_id] || "#4ea3ff";
        const segs: Array<[number, number]> = [];
        const kfs = t.keyframes;
        for (let i = 0; i < kfs.length; i++) {
          const curr = kfs[i];
          const nextF = i + 1 < kfs.length ? kfs[i + 1].frame : total;
          const end = curr.absent ? curr.frame + 1 : nextF;
          if (end > curr.frame) segs.push([curr.frame, end]);
        }
        return (
          <g key={t.track_id}>
            {segs.map(([s, e], i) => (
              <line
                key={`seg-${i}`}
                x1={centerX(s)}
                x2={centerX(e - 1)}
                y1={y + rowHeight / 2}
                y2={y + rowHeight / 2}
                stroke={color}
                strokeWidth={2}
              />
            ))}
            {t.keyframes.map((k) => (
              <circle
                key={k.frame}
                cx={centerX(k.frame)}
                cy={y + rowHeight / 2}
                r={4}
                fill={color}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  onDeleteKeyframe(t.track_id, k.frame);
                }}
              >
                <title>{`Frame ${k.frame}`}</title>
              </circle>
            ))}
          </g>
        );
      })}

      <line
        x1={centerX(frame)}
        x2={centerX(frame)}
        y1={margin - 1}
        y2={margin + innerH + 1}
        stroke="#fff"
        strokeWidth={2}
      />
    </svg>
  );
};

export default Timeline;
