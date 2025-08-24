/**
 * Renderer module: canvas drawing helpers.
 *
 * Public API:
 *   - clearViewport(viewportRef)
 *     Clears the canvas and fills it with a dark background. Used when no
 *     frame is available or when resetting the viewport.
 */
import type React from "react";

export function clearViewport(
  viewportRef: React.MutableRefObject<HTMLCanvasElement | null>
): void {
  const c = viewportRef.current;
  if (!c) return;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.restore();
}
