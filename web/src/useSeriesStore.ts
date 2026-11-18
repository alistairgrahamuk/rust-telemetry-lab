import { useCallback, useEffect, useRef, useState } from 'react'
import { streamReadings, subscribeLive, type Reading } from './api'
import { Series, type SeriesMap } from './series'

/** The API accepts this many sensors per stream request. */
const MAX_PER_REQUEST = 16
/** Minimum interval between React re-renders while rows are pouring in. */
const RENDER_EVERY_MS = 150

export interface StoreState {
  /** Streams currently in flight (0 = all requested history has arrived). */
  pending: number
  loaded: number
  expected: number
  elapsedMs: number
  liveCount: number
  liveConnected: boolean
  error: string | null
  /** Bumped whenever the series change; consumers re-render off this instead of copying arrays. */
  version: number
}

const initial: StoreState = {
  pending: 0, loaded: 0, expected: 0, elapsedMs: 0, liveCount: 0, liveConnected: false, error: null, version: 0,
}

/**
 * One store for the whole dashboard: every wanted sensor is fetched once for the current range
 * no matter how many widgets show it. Changing the range refetches everything; adding a sensor
 * fetches only that sensor; a single live-tail subscription covers the union.
 *
 * `wantedKey` is the sorted, comma-joined sensor ids so effect deps stay stable.
 */
export function useSeriesStore(wantedKey: string, fromMs: number | null, toMs: number | null, live: boolean) {
  const series = useRef<SeriesMap>(new Map())
  /** Sensors with a stream in flight, mapped to that stream's abort controller. */
  const inflight = useRef<Map<number, AbortController>>(new Map())
  const [state, setState] = useState<StoreState>(initial)
  const counters = useRef({ loaded: 0, expected: 0, live: 0, pending: 0, started: 0 })
  const flushTimer = useRef<number | null>(null)
  const pendingPatch = useRef<Partial<StoreState>>({})

  const wanted = wantedKey ? wantedKey.split(',').map(Number) : []
  const rangeKey = `${fromMs ?? ''}:${toMs ?? ''}`

  // Coalesce many onRows calls into at most one setState per RENDER_EVERY_MS.
  const scheduleFlush = useCallback((patch: Partial<StoreState>, immediate = false) => {
    Object.assign(pendingPatch.current, patch)
    const run = () => {
      flushTimer.current = null
      const p = pendingPatch.current
      pendingPatch.current = {}
      const c = counters.current
      setState((s) => ({
        ...s, ...p,
        loaded: c.loaded, expected: c.expected, liveCount: c.live, pending: c.pending,
        elapsedMs: c.started ? performance.now() - c.started : s.elapsedMs,
        version: s.version + 1,
      }))
    }
    if (immediate) {
      if (flushTimer.current != null) window.clearTimeout(flushTimer.current)
      run()
    } else if (flushTimer.current == null) {
      flushTimer.current = window.setTimeout(run, RENDER_EVERY_MS)
    }
  }, [])

  const seriesFor = (sid: number) => {
    let ser = series.current.get(sid)
    if (!ser) { ser = new Series(); series.current.set(sid, ser) }
    return ser
  }

  /** Starts one stream for `ids` (≤ MAX_PER_REQUEST) and books it as in flight. */
  const startStream = (ids: number[]) => {
    const ctrl = new AbortController()
    for (const id of ids) { inflight.current.set(id, ctrl); seriesFor(id) }
    const c = counters.current
    c.pending++
    if (!c.started) c.started = performance.now()
    scheduleFlush({}, true)
    streamReadings(ids, fromMs, toMs, {
      onMeta: (m) => { c.expected += m.count; scheduleFlush({}) },
      onRows: (buf, n) => {
        let last: Series | null = null, lastSid = -1
        for (let i = 0; i < n; i++) {
          const sid = buf[i * 3]
          if (sid !== lastSid) { last = seriesFor(sid); lastSid = sid }
          last!.push(buf[i * 3 + 1], buf[i * 3 + 2])
        }
        c.loaded += n
        scheduleFlush({})
      },
    }, ctrl.signal)
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) scheduleFlush({ error: e instanceof Error ? e.message : String(e) })
      })
      .finally(() => {
        for (const id of ids) if (inflight.current.get(id) === ctrl) inflight.current.delete(id)
        c.pending--
        if (c.pending === 0) c.started = 0
        scheduleFlush({}, true)
      })
  }

  // Range change: drop everything and start over.
  useEffect(() => {
    return () => {
      for (const ctrl of new Set(inflight.current.values())) ctrl.abort()
      inflight.current = new Map()
      series.current = new Map()
      counters.current = { loaded: 0, expected: 0, live: 0, pending: 0, started: 0 }
      if (flushTimer.current != null) window.clearTimeout(flushTimer.current)
      flushTimer.current = null
      pendingPatch.current = {}
      setState({ ...initial })
    }
  }, [rangeKey])

  // Selection change: fetch what is missing, forget what nobody shows any more.
  useEffect(() => {
    const want = new Set(wanted)
    for (const id of [...series.current.keys()]) {
      if (!want.has(id) && !inflight.current.has(id)) series.current.delete(id)
    }
    const missing = wanted.filter((id) => !series.current.has(id) && !inflight.current.has(id))
    for (let i = 0; i < missing.length; i += MAX_PER_REQUEST) startStream(missing.slice(i, i + MAX_PER_REQUEST))
    if (!missing.length) scheduleFlush({}, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, rangeKey])

  // Live tail: one subscription for the union, only while nothing is loading and the range is
  // open-ended. Rows older than a series' newest point are dropped, so overlap is harmless.
  useEffect(() => {
    if (!live || !wanted.length || state.pending > 0 || toMs != null) return
    let last = 0
    for (const ser of series.current.values()) last = Math.max(last, ser.lastTs())
    scheduleFlush({ liveConnected: true }, true)
    const dispose = subscribeLive(
      wanted,
      last || Date.now(),
      (batch: Reading[]) => {
        let added = 0
        for (const [sid, ts, v] of batch) {
          const ser = series.current.get(sid)
          if (!ser || ts <= ser.lastTs()) continue
          ser.push(ts, v); added++
        }
        counters.current.live += added
        counters.current.loaded += added
        scheduleFlush({})
      },
      (msg) => scheduleFlush({ error: msg }),
    )
    return () => { dispose(); scheduleFlush({ liveConnected: false }, true) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, wantedKey, rangeKey, state.pending, scheduleFlush])

  return { series, state }
}
