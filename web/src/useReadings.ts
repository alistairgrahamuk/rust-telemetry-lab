import { useCallback, useEffect, useRef, useState } from 'react'
import { streamReadings, subscribeLive, type Reading } from './api'

export type Phase = 'idle' | 'streaming' | 'done' | 'error'

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
}
export type SeriesMap = Map<number, Series>

export interface ReadingsState {
  phase: Phase
  loaded: number
  expected: number
  bytesHint: number
  elapsedMs: number
  liveCount: number
  liveConnected: boolean
  error: string | null
  /** Bumped whenever the series change; consumers re-render off this instead of copying arrays. */
  version: number
}

const initial: ReadingsState = {
  phase: 'idle', loaded: 0, expected: 0, bytesHint: 0, elapsedMs: 0,
  liveCount: 0, liveConnected: false, error: null, version: 0,
}

/** Minimum interval between React re-renders while rows are pouring in. */
const RENDER_EVERY_MS = 150

/**
 * Owns the row buffers for a set of sensors over one range. Series live in a ref (mutated in
 * place, hundreds of thousands of points) and a cheap `version` counter drives re-renders at a
 * bounded rate. `idsKey` is the sorted, comma-joined sensor ids so deps stay stable.
 */
export function useReadings(idsKey: string, fromMs: number | null, toMs: number | null, live: boolean) {
  const series = useRef<SeriesMap>(new Map())
  const loaded = useRef(0)
  const [state, setState] = useState<ReadingsState>(initial)
  const flushTimer = useRef<number | null>(null)
  const pending = useRef<Partial<ReadingsState>>({})
  const liveCount = useRef(0)

  const ids = idsKey ? idsKey.split(',').map(Number) : []

  const append = (batch: Reading[]) => {
    const m = series.current
    for (const [sid, ts, v] of batch) {
      let ser = m.get(sid)
      if (!ser) { ser = new Series(); m.set(sid, ser) }
      ser.push(ts, v)
    }
    loaded.current += batch.length
  }

  // Coalesce many onRows calls into at most one setState per RENDER_EVERY_MS.
  const scheduleFlush = useCallback((patch: Partial<ReadingsState>, immediate = false) => {
    Object.assign(pending.current, patch)
    const run = () => {
      flushTimer.current = null
      const p = pending.current
      pending.current = {}
      setState((s) => ({ ...s, ...p, loaded: loaded.current, liveCount: liveCount.current, version: s.version + 1 }))
    }
    if (immediate) {
      if (flushTimer.current != null) window.clearTimeout(flushTimer.current)
      run()
    } else if (flushTimer.current == null) {
      flushTimer.current = window.setTimeout(run, RENDER_EVERY_MS)
    }
  }, [])

  // History stream: restart whenever the selection changes.
  useEffect(() => {
    series.current = new Map()
    loaded.current = 0
    liveCount.current = 0
    setState({ ...initial })
    if (!ids.length) return

    const ctrl = new AbortController()
    const started = performance.now()
    let bytes = 0
    scheduleFlush({ phase: 'streaming' }, true)

    streamReadings(ids, fromMs, toMs, {
      onMeta: (m) => scheduleFlush({ expected: m.count }),
      onRows: (batch) => {
        append(batch)
        bytes += batch.length * 24 // ~bytes per NDJSON row, good enough for a rate readout
        scheduleFlush({ bytesHint: bytes, elapsedMs: performance.now() - started })
      },
    }, ctrl.signal)
      .then(() => scheduleFlush({ phase: 'done', elapsedMs: performance.now() - started }, true))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return
        scheduleFlush({ phase: 'error', error: e instanceof Error ? e.message : String(e) }, true)
      })

    return () => {
      ctrl.abort()
      if (flushTimer.current != null) window.clearTimeout(flushTimer.current)
      flushTimer.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, fromMs, toMs, scheduleFlush])

  // Live tail: only once history has finished, and only if the range is open-ended.
  useEffect(() => {
    if (!live || !ids.length || state.phase !== 'done' || toMs != null) return
    let last = 0
    for (const ser of series.current.values()) last = Math.max(last, ser.lastTs())
    scheduleFlush({ liveConnected: true }, true)
    const dispose = subscribeLive(
      ids,
      last || Date.now(),
      (batch) => { append(batch); liveCount.current += batch.length; scheduleFlush({}) },
      (msg) => scheduleFlush({ error: msg }),
    )
    return () => {
      dispose()
      scheduleFlush({ liveConnected: false }, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, idsKey, toMs, state.phase, scheduleFlush])

  return { series, state }
}
