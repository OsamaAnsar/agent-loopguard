/**
 * The newest `size` call keys, with a count per key.
 *
 * A fixed-size ring buffer plus a `Map` of counts: adding a call and asking how often its key
 * occurs in the window are both O(1), and memory is O(`size`) however long the run is. Keys are
 * fixed-length hashes, so the window holds no raw arguments.
 */
export class CallWindow {
  private buf: string[] = [];
  /** Index of the oldest key once the buffer is full. */
  private head = 0;
  private counts = new Map<string, number>();

  constructor(readonly size: number) {}

  /** Number of calls in the window right now (at most `size`). */
  get length(): number {
    return this.buf.length;
  }

  /** Add the newest call, dropping the oldest when the window is full. Returns how often `key` is in the window now. */
  add(key: string): number {
    if (this.buf.length < this.size) {
      this.buf.push(key);
    } else {
      const oldest = this.buf[this.head] as string;
      const left = (this.counts.get(oldest) as number) - 1;
      if (left === 0) this.counts.delete(oldest);
      else this.counts.set(oldest, left);
      this.buf[this.head] = key;
      this.head = (this.head + 1) % this.size;
    }
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return count;
  }

  /** How often `key` is in the window now. */
  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** The highest count of any one key in the window (0 when it is empty). */
  highest(): number {
    let best = 0;
    for (const count of this.counts.values()) if (count > best) best = count;
    return best;
  }

  /** The keys, oldest first. */
  keys(): string[] {
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
  }

  /** Replace the contents with `keys` (oldest first, at most `size` of them). */
  load(keys: readonly string[]): void {
    this.clear();
    for (const key of keys) this.add(key);
  }

  /** An independent copy, so that a hypothetical call can be added without touching this one. */
  clone(): CallWindow {
    const copy = new CallWindow(this.size);
    copy.buf = [...this.buf];
    copy.head = this.head;
    copy.counts = new Map(this.counts);
    return copy;
  }

  clear(): void {
    this.buf = [];
    this.head = 0;
    this.counts.clear();
  }
}
