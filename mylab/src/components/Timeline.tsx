import React, { useRef } from "react";
import type { Track } from "../types";

const Timeline: React.FC<{
  total: number;
  frame: number;
  onSeek: (f: number) => void;
  selectedTracks: Track[];
  width?: number;
  height?: number;
}> = ({ total, frame, onSeek, selectedTracks, width = 800, height = 56 }) => {
  const margin = 8;
  const innerW = Math.max(1, width - margin * 2);
  const innerH = height - margin * 2;
  const scaleX = (f: number) => margin + (f / Math.max(1, total - 1)) * innerW;

  // invisible spans from presence toggles
  const spans: { x1: number; x2: number }[] = [];
  selectedTracks.forEach(t => {
    const arr = [0, ...t.presence_toggles, total];
    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i], b = arr[i + 1];
      const visible = (i % 2) === 0;
      if (!visible) spans.push({ x1: a, x2: b });
    }
  });

  // markers
  const kfFrames = new Set<number>();
  const toggleFrames = new Set<number>();
  selectedTracks.forEach(t => {
    t.keyframes.forEach(k => kfFrames.add(k.frame));
    t.presence_toggles.forEach(f => toggleFrames.add(f));
  });

  const draggingRef = useRef(false);
  const seekFromEvent = (ev: React.PointerEvent<SVGSVGElement>) => {
    const rect = (ev.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x = ev.clientX - rect.left - margin;
    const t = Math.max(0, Math.min(1, x / innerW));
    onSeek(Math.round(t * (total - 1)));
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

  return (
    <svg
      width={width} height={height}
      style={{ display: "block", width: "100%" }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
    >
      <rect x={0} y={0} width={width} height={height} fill="#161616" stroke="#333" />
      {spans.map((s, i) => {
        const x1 = scaleX(s.x1), x2 = scaleX(s.x2);
        return <rect key={i} x={x1} y={margin} width={Math.max(1, x2 - x1)} height={innerH} fill="#444" opacity={0.5} />;
      })}
      <line x1={margin} y1={margin + innerH / 2} x2={margin + innerW} y2={margin + innerH / 2} stroke="#555" />
      {[...kfFrames].map((f, i) => (
        <line key={`kf-${i}`} x1={scaleX(f)} x2={scaleX(f)} y1={margin} y2={margin + innerH} stroke="#4ea3ff" strokeWidth={2} />
      ))}
      {[...toggleFrames].map((f, i) => {
        const x = scaleX(f), y = margin;
        return <polygon key={`tg-${i}`} points={`${x},${y} ${x - 5},${y + 10} ${x + 5},${y + 10}`} fill="#ff6a6a" />;
      })}
      <line x1={scaleX(frame)} x2={scaleX(frame)} y1={margin - 1} y2={margin + innerH + 1} stroke="#fff" strokeWidth={2} />
    </svg>
  );
};

export default Timeline;