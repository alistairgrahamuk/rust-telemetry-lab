import { describe, expect, it } from 'vitest'
import { Series } from './series'

function series(ts: number[]) {
  const s = new Series()
  ts.forEach((t, i) => s.push(t, i))
  return s
}

describe('Series', () => {
  it('grows past its initial capacity and keeps order', () => {
    const s = new Series()
    for (let i = 0; i < 10_000; i++) s.push(i * 1000, i)
    expect(s.len).toBe(10_000)
    expect(s.ts(9_999)).toBe(9_999_000)
    expect(s.value(1234)).toBe(1234)
    expect(s.lastTs()).toBe(9_999_000)
    expect(s.view().length).toBe(20_000)
  })

  it('nearestIndex picks the closest timestamp on either side', () => {
    const s = series([0, 100, 200, 300])
    expect(s.nearestIndex(-50)).toBe(0)
    expect(s.nearestIndex(0)).toBe(0)
    expect(s.nearestIndex(140)).toBe(1)
    expect(s.nearestIndex(160)).toBe(2)
    expect(s.nearestIndex(300)).toBe(3)
    expect(s.nearestIndex(10_000)).toBe(3)
  })
})
