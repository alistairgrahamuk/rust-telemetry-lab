import { describe, expect, it } from 'vitest'
import { COLS, DEFAULT_H, DEFAULT_W, placeNew } from './dashboard'

describe('placeNew', () => {
  it('puts the first widget top-left', () => {
    expect(placeNew([], 'a')).toMatchObject({ i: 'a', x: 0, y: 0, w: DEFAULT_W, h: DEFAULT_H })
  })
  it('fills free space to the right before starting a new row', () => {
    const layout = [{ i: 'a', x: 0, y: 0, w: DEFAULT_W, h: DEFAULT_H }]
    expect(placeNew(layout, 'b')).toMatchObject({ x: DEFAULT_W, y: 0 })
  })
  it('starts a new row when the first is full', () => {
    const layout = [
      { i: 'a', x: 0, y: 0, w: DEFAULT_W, h: DEFAULT_H },
      { i: 'b', x: DEFAULT_W, y: 0, w: COLS - DEFAULT_W, h: DEFAULT_H },
    ]
    expect(placeNew(layout, 'c')).toMatchObject({ x: 0, y: DEFAULT_H })
  })
  it('slots into a gap left by a shorter widget', () => {
    const layout = [
      { i: 'a', x: 0, y: 0, w: DEFAULT_W, h: DEFAULT_H + 4 },
      { i: 'b', x: DEFAULT_W, y: 0, w: DEFAULT_W, h: 2 },
    ]
    expect(placeNew(layout, 'c')).toMatchObject({ x: DEFAULT_W, y: 2 })
  })
})
