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
  width = 800,
  rowHeight = 20
}) => {
  const margin = 8;
  const innerW = Math.max(1, width - margin * 2);
  const step = innerW / Math.max(1, total);
  const height = margin * 2 + rowHeight * tracks.length;
  const innerH = height - margin * 2;
  const scaleX = (f: number) => margin + f * step;
  const centerX = (f: number) => margin + (f + 0.5) * step;

  const draggingRef = useRef(false);
  const seekFromEvent = (ev: React.PointerEvent<SVGSVGElement>) => {
    const rect = (ev.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x = ev.clientX - rect.left - margin;
    const t = clamp(Math.floor(x / step), 0, total - 1);
    onSeek(t);
  };
  const onPointerDown = (ev: React.PointerEvent<SVGSVGElement>) => {
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
  };
  const onWheel = (ev: React.WheelEvent<SVGSVGElement>) => {
    ev.preventDefault();
    const delta = ev.deltaY > 0 ? 1 : -1;
    onSeek(clamp(frame + delta, 0, total - 1));
  };

  const frameHasKF = (f: number) =>
    tracks.some(t => t.keyframes.some(k => k.frame === f));

  return (
    <svg
      width={width}
      height={height}
      style={{ display: "block", width: "100%" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
    >
      <rect x={0} y={0} width={width} height={height} fill="#161616" stroke="#333" />

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
        const y = margin + rowHeight * idx + rowHeight / 2;
        const color = labelSet.colors[t.class_id] || "#4ea3ff";
        return (
          <g key={t.track_id}>
            <line
              x1={margin}
              y1={y}
              x2={margin + innerW}
              y2={y}
              stroke={color}
            />
            {t.keyframes.map(k => (
              <circle
                key={k.frame}
                cx={centerX(k.frame)}
                cy={y}
                r={4}
                fill={color}
                onContextMenu={ev => {
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

