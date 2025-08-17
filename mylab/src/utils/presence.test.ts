import { describe, it, expect } from 'vitest';
import type { Keyframe } from '../types';
import { togglePresenceAtFrame } from './presence';

describe('togglePresenceAtFrame', () => {
  const kfs: Keyframe[] = [
    { frame: 0, bbox_xywh: [0,0,0,0] },
    { frame: 10, bbox_xywh: [0,0,0,0] },
    { frame: 20, bbox_xywh: [0,0,0,0] },
    { frame: 30, bbox_xywh: [0,0,0,0] },
  ];

  it('merges neighbouring absence when toggling previous keyframe', () => {
    const initial = [10,30];
    const result = togglePresenceAtFrame(initial, kfs, 0);
    expect(result).toEqual([0,30]);
  });

  it('splits absence interval when toggling inside it', () => {
    const initial = [0,30];
    const result = togglePresenceAtFrame(initial, kfs, 10);
    expect(result).toEqual([0,10,20,30]);
  });

  it('toggling twice restores original state', () => {
    const initial = [10,20];
    const once = togglePresenceAtFrame(initial, kfs, 10);
    expect(once).toEqual([]);
    const twice = togglePresenceAtFrame(once, kfs, 10);
    expect(twice).toEqual([10,20]);
  });
});

