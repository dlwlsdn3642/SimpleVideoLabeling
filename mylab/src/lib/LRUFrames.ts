export default class LRUFrames<K = string> {
  private max: number;
  private map = new Map<K, ImageBitmap>();

  constructor(max = 24) {
    this.max = max;
  }

  get(k: K) {
    const v = this.map.get(k);
    if (v) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v ?? null;
  }

  has(k: K) {
    return this.map.has(k);
  }

  set(k: K, v: ImageBitmap) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) {
      const fk = this.map.keys().next().value as K;
      this.map.get(fk)?.close?.();
      this.map.delete(fk);
    }
  }

  clear() {
    for (const [, v] of this.map) v.close?.();
    this.map.clear();
  }
}