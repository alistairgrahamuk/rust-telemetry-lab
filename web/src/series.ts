/**
 * Per-sensor series as a flat, growable Float64Array of (timestamp_ms, value) pairs in time
 * order. ECharts ingests a flat typed array far cheaper than millions of two-element arrays.
 */
export class Series {
  buf = new Float64Array(2 * 4096)
  /** Number of points (pairs) in use. */
  len = 0

  push(ts: number, v: number) {
    if (this.len * 2 + 2 > this.buf.length) {
      const next = new Float64Array(this.buf.length * 2)
      next.set(this.buf)
      this.buf = next
    }
    this.buf[this.len * 2] = ts
    this.buf[this.len * 2 + 1] = v
    this.len++
  }
  /** A no-copy view of the used portion, for handing to the chart. */
  view() { return this.buf.subarray(0, this.len * 2) }
  ts(i: number) { return this.buf[i * 2] }
  value(i: number) { return this.buf[i * 2 + 1] }
  lastTs() { return this.len ? this.buf[(this.len - 1) * 2] : 0 }

  /** Index of the point whose timestamp is closest to `t` (points are time-ordered). */
  nearestIndex(t: number): number {
    let lo = 0, hi = this.len - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.ts(mid) < t) lo = mid + 1
      else hi = mid
    }
    return lo > 0 && t - this.ts(lo - 1) < this.ts(lo) - t ? lo - 1 : lo
  }
}

export type SeriesMap = Map<number, Series>
