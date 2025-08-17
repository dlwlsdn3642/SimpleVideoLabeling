import { describe, it, expect } from 'vitest';
import type { Keyframe } from '../types';
import { togglePresenceAtFrame } from './presence';

describe('togglePresenceAtFrame', () => {
  const kfs: Keyframe[] = [
    { frame: 0, bbox_xywh: [0,0,0,0] },
    { frame: 10, bbox_xywh: [0,0,0,0] },
    { frame: 20, bbox_xywh: [0,0,0,0] },
  ];

  it('preserves next keyframe presence when toggling previous keyframe', () => {
    const initial = [10,20];
    const toggledOn = togglePresenceAtFrame(initial, kfs, 0);
    expect(toggledOn).toEqual([0,10,20]);
    const toggledOff = togglePresenceAtFrame(toggledOn, kfs, 0);
    expect(toggledOff).toEqual([10,20]);
  });

  it('removes paired toggle when disabling presence at keyframe', () => {
    const initial = [0,10];
    const result = togglePresenceAtFrame(initial, kfs, 0);
    expect(result).toEqual([]);
  });
});
