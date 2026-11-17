import { useCallback, useEffect, useRef, useState } from 'react'
import { streamReadings, subscribeLive, type Reading } from './api'

export type Phase = 'idle' | 'streaming' | 'done' | 'error'

export interface ReadingsState {
  phase: Phase
  loaded: number
  expected: number
  bytesHint: number
  elapsedMs: number
  liveCount: number
  liveConnected: boolean
  error: string | null
  /** Bumped whenever `rows` changes; consumers re-render off this instead of copying arrays. */
  version: number
}

const initial: ReadingsState = {
  phase: 'idle', loaded: 0, expected: 0, bytesHint: 0, elapsedMs: 0,
  liveCount: 0, liveConnected: false, error: null, version: 0,
}

/** Minimum interval between React re-renders while rows are pouring in. */
const RENDER_EVERY_MS = 150

/**
 * Owns the row buffer for one sensor/range. Rows live in a ref (mutated in place, hundreds of
 * thousands of entries) and a cheap `version` counter drives re-renders at a bounded rate.
 */
export function useReadings(sensorId: number | null, fromMs: number | null, toMs: number | null, live: boolean) {
  const rows = useRef<Reading[]>([])
  const [state, setState] = useState<ReadingsState>(initial)
  const flushTimer = useRef<number | null>(null)
  const pending = useRef<Partial<ReadingsState>>({})

  // Coalesce many onRows calls into at most one setState per RENDER_EVERY_MS.
  const scheduleFlush = useCallback((patch: Partial<ReadingsState>, immediate = false) => {
    Object.assign(pending.current, patch)
    const run = () => {
      flushTimer.current = null
      const p = pending.current
      pending.current = {}
      setState((s) => ({ ...s, ...p, loaded: rows.current.length, version: s.version + 1 }))
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
    rows.current = []
    setState({ ...initial })
    if (sensorId == null) return

    const ctrl = new AbortController()
    const started = performance.now()
    let bytes = 0
    scheduleFlush({ phase: 'streaming' }, true)

    streamReadings(sensorId, fromMs, toMs, {
      onMeta: (m) => scheduleFlush({ expected: m.count }),
      onRows: (batch) => {
        for (const r of batch) rows.current.push(r)
        bytes += batch.length * 36 // ~bytes per NDJSON row, good enough for a rate readout
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
  }, [sensorId, fromMs, toMs, scheduleFlush])

  // Live tail: only once history has finished, and only if the range is open-ended.
  useEffect(() => {
    if (!live || sensorId == null || state.phase !== 'done' || toMs != null) return
    const last = rows.current.length ? rows.current[rows.current.length - 1][0] : Date.now()
    scheduleFlush({ liveConnected: true }, true)
    const dispose = subscribeLive(
      sensorId,
      last,
      (batch) => {
        for (const r of batch) rows.current.push(r)
        scheduleFlush({ liveCount: (pending.current.liveCount ?? stateRef.current.liveCount) + batch.length })
      },
      (msg) => scheduleFlush({ error: msg }),
    )
    return () => {
      dispose()
      scheduleFlush({ liveConnected: false }, true)
    }
  }, [live, sensorId, toMs, state.phase, scheduleFlush])

  // Latest state for callbacks without re-subscribing.
  const stateRef = useRef(state)
  stateRef.current = state

  return { rows, state }
}
