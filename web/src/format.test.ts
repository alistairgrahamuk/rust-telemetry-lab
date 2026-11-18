import { describe, expect, it } from 'vitest'
import { DAY, humanSpan } from './format'

describe('humanSpan', () => {
  it('is empty for nothing', () => { expect(humanSpan(0)).toBe(''); expect(humanSpan(NaN)).toBe('') })
  it('minutes under an hour', () => expect(humanSpan(45 * 60_000)).toBe('~45 minutes'))
  it('hours and minutes under three days', () => expect(humanSpan(6 * 3_600_000 + 10 * 60_000)).toBe('~6 hours 10 minutes'))
  it('days up to about four months', () => { expect(humanSpan(30 * DAY)).toBe('~30 days'); expect(humanSpan(90 * DAY)).toBe('~90 days') })
  it('a year reads as a year, not 11 months 30 days', () => expect(humanSpan(365 * DAY)).toBe('~1 year'))
  it('years and months beyond', () => expect(humanSpan(1052 * DAY)).toBe('~2 years 11 months'))
  it('singular units', () => expect(humanSpan(1 * 3_600_000 + 60_000)).toBe('~1 hour 1 minute'))
})
