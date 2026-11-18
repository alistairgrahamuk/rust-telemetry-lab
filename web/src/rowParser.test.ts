import { describe, expect, it } from 'vitest'
import { RowParser, type ParserOut } from './rowParser'

const enc = new TextEncoder()

/** Runs the parser over `chunks`, returning every row posted (flattened) and any meta lines. */
function parse(chunks: (string | { flush: true })[]) {
  const rows: number[][] = []
  const metas: unknown[] = []
  const p = new RowParser((m: ParserOut) => {
    if (m.type === 'meta') metas.push(m.meta)
    else for (let i = 0; i < m.n; i++) rows.push([m.buf[i * 3], m.buf[i * 3 + 1], m.buf[i * 3 + 2]])
  })
  for (const c of chunks) typeof c === 'string' ? p.feed(enc.encode(c)) : p.flush()
  p.end()
  return { rows, metas }
}

const META = '{"type":"meta","sensor_ids":[1,2],"count":3,"from_ms":0,"to_ms":1}\n'
const BODY = '[1,1700000000000,22.5]\n[2,1700000000000,-0.25]\n[1,1700000300000,1003.1]\n'

describe('RowParser', () => {
  it('parses a meta line followed by rows in one chunk', () => {
    const { rows, metas } = parse([META + BODY])
    expect(metas).toEqual([{ type: 'meta', sensor_ids: [1, 2], count: 3, from_ms: 0, to_ms: 1 }])
    expect(rows).toEqual([[1, 1700000000000, 22.5], [2, 1700000000000, -0.25], [1, 1700000300000, 1003.1]])
  })

  it('is byte-boundary agnostic: one byte per chunk gives the same rows', () => {
    const whole = parse([META + BODY]).rows
    const bytes = [...(META + BODY)].map((ch) => ch)
    expect(parse(bytes).rows).toEqual(whole)
  })

  it('keeps a row intact when a flush lands between its fields (regression: 1970 rows)', () => {
    // Split inside the second row, after its sensor id and timestamp have been committed.
    const a = '[1,1700000000000,22.5]\n[2,1700000000000,'
    const b = '-0.25]\n[1,1700000300000,1003.1]\n'
    const { rows } = parse([a, { flush: true }, b])
    expect(rows).toEqual([[1, 1700000000000, 22.5], [2, 1700000000000, -0.25], [1, 1700000300000, 1003.1]])
    expect(rows.some((r) => r[0] === 0 || r[1] === 0)).toBe(false)
  })

  it('keeps a row intact when a flush lands inside a number', () => {
    const { rows } = parse(['[1,17000000', { flush: true }, '00000,22.5]\n[2,1,2]\n'])
    expect(rows).toEqual([[1, 1700000000000, 22.5], [2, 1, 2]])
  })

  it('skips a malformed line and carries on', () => {
    const { rows } = parse(['[1,1,1]\nthis is not a row\n[2,2,2]\n'.replace('this is not a row', '"oops"')])
    expect(rows).toEqual([[1, 1, 1], [2, 2, 2]])
  })

  it('handles a trailing row with no final newline', () => {
    expect(parse(['[7,5,0.5]']).rows).toEqual([[7, 5, 0.5]])
  })
})
