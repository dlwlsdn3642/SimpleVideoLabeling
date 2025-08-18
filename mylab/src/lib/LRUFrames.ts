export default class LRUFrames {
  private max: number;
  private map = new Map<number, ImageBitmap>();
  constructor(max = 24) { this.max = max; }
  get(k: number) {
    const v = this.map.get(k);
    if (v) { this.map.delete(k); this.map.set(k, v); }
    return v ?? null;
  }
  has(k: number) { return this.map.has(k); }
  set(k: number, v: ImageBitmap) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) {
      const fk = this.map.keys().next().value as number;
      // Do not forcibly close evicted bitmaps; allow GC to reclaim them.
      this.map.delete(fk);
    }
  }
  clear() { for (const [, v] of this.map) v.close?.(); this.map.clear(); }
  delete(k: number) { this.map.delete(k); }
}
