import { describe, it, expect } from 'vitest';
import { findKFIndexAtOrBefore, isVisibleAt, rectAtFrame } from './geom';
import type { Keyframe, Track } from '../types';

describe('findKFIndexAtOrBefore', () => {
  const kfs: Keyframe[] = [
    { frame: 10, bbox_xywh: [0, 0, 0, 0] },
    { frame: 20, bbox_xywh: [0, 0, 0, 0] },
    { frame: 30, bbox_xywh: [0, 0, 0, 0] },
  ];

  it('returns -1 before first keyframe', () => {
    expect(findKFIndexAtOrBefore(kfs, 5)).toBe(-1);
  });

  it('returns preceding index between keyframes', () => {
    expect(findKFIndexAtOrBefore(kfs, 25)).toBe(1);
  });

  it('returns last index after final keyframe', () => {
    expect(findKFIndexAtOrBefore(kfs, 40)).toBe(2);
  });
});

describe('isVisibleAt', () => {
  const track: Track = {
    track_id: '1',
    class_id: 0,
    keyframes: [
      { frame: 0, bbox_xywh: [0, 0, 0, 0] },
      { frame: 5, bbox_xywh: [0, 0, 0, 0], absent: true },
      { frame: 10, bbox_xywh: [0, 0, 0, 0] },
    ],
  };

  it('is visible at keyframes and hidden after absence markers', () => {
    expect(isVisibleAt(track, 0)).toBe(true);
    expect(isVisibleAt(track, 5)).toBe(true);
    expect(isVisibleAt(track, 6)).toBe(false);
    expect(isVisibleAt(track, 7)).toBe(false);
    expect(isVisibleAt(track, 10)).toBe(true);
    expect(isVisibleAt(track, 12)).toBe(true);
  });
});

describe('rectAtFrame', () => {
  const baseTrack: Track = {
    track_id: '1',
    class_id: 0,
    keyframes: [
      { frame: 0, bbox_xywh: [0, 0, 10, 10] },
      { frame: 10, bbox_xywh: [10, 10, 10, 10] },
    ],
  };

  it('interpolates between keyframes', () => {
    const rect = rectAtFrame(baseTrack, 5)!;
    expect(rect).toEqual({ x: 5, y: 5, w: 10, h: 10 });
  });

  it('returns null when track is hidden', () => {
    const hidden: Track = {
      ...baseTrack,
      keyframes: [
        { ...baseTrack.keyframes[0], absent: true },
        baseTrack.keyframes[1],
      ],
    };
    expect(rectAtFrame(hidden, 4)).toBeNull();
  });
});

