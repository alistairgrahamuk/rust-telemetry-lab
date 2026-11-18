export interface Sensor {
  id: number
  device_id: number
  device: string
  location: string
  metric: string
  unit: string
  first_ms: number | null
  last_ms: number | null
}

/** [sensor_id, timestamp_ms, value] */
export type Reading = [number, number, number]

import type { WorkerIn, WorkerOut } from './stream.worker'

export interface StreamMeta {
  sensor_ids: number[]
  count: number
  from_ms: number
  to_ms: number
}

export async function fetchSensors(): Promise<Sensor[]> {
  const res = await fetch('/api/sensors')
  if (!res.ok) throw new Error(`sensors: HTTP ${res.status}`)
  return res.json()
}

export interface StreamHandlers {
  onMeta: (meta: StreamMeta) => void
  /** `buf` holds `n` triples (sensor_id, ts_ms, value) at stride 3; it is owned by the callee. */
  onRows: (buf: Float64Array, n: number) => void
}

/**
 * Streams NDJSON rows for a set of sensors over a range. Fetching, decoding and parsing run
 * in a Web Worker (see stream.worker.ts); parsed rows arrive here as transferred typed arrays
 * so the main thread does no string work. Resolves when the server closes the stream.
 */
export function streamReadings(
  sensorIds: number[],
  fromMs: number | null,
  toMs: number | null,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const params = new URLSearchParams({ sensor_ids: sensorIds.join(',') })
  if (fromMs != null) params.set('from', new Date(fromMs).toISOString())
  if (toMs != null) params.set('to', new Date(toMs).toISOString())
  const url = new URL(`/api/readings/stream?${params}`, location.origin).href

  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL('./stream.worker.ts', import.meta.url), { type: 'module' })
    const finish = (err?: Error) => {
      worker.terminate()
      signal.removeEventListener('abort', onAbort)
      err ? reject(err) : resolve()
    }
    const onAbort = () => finish(new DOMException('aborted', 'AbortError'))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort)

    worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data
      if (m.type === 'meta') handlers.onMeta(m.meta)
      else if (m.type === 'rows') handlers.onRows(m.buf, m.n)
      else if (m.type === 'done') finish()
      else finish(new Error(m.message))
    }
    worker.onerror = (e) => finish(new Error(e.message || 'stream worker failed'))
    worker.postMessage({ type: 'start', url } satisfies WorkerIn)
  })
}

/** Delay before re-opening a live subscription the browser gave up on. */
const LIVE_RETRY_MS = 3_000

/**
 * Subscribes to new rows for a set of sensors via SSE. `getAfter` is asked for the newest
 * timestamp already held each time a connection is (re)opened, so nothing is missed or
 * re-sent across reconnects. The browser retries transient network errors itself, but gives
 * up for good on a non-stream response (e.g. a 502 from a dev proxy while the API restarts),
 * so a closed source is re-created here. `onState` reports the real connection state.
 */
export function subscribeLive(
  sensorIds: number[],
  getAfter: () => number,
  onRows: (rows: Reading[]) => void,
  onState: (connected: boolean) => void,
  onError: (msg: string) => void,
): () => void {
  let es: EventSource | null = null
  let timer: number | null = null
  let disposed = false

  const open = () => {
    const params = new URLSearchParams({ sensor_ids: sensorIds.join(','), after: new Date(getAfter()).toISOString() })
    es = new EventSource(`/api/readings/live?${params}`)
    es.addEventListener('open', () => onState(true))
    es.addEventListener('rows', (e) => onRows(JSON.parse((e as MessageEvent).data)))
    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent).data
      if (data) onError(String(data))
      onState(false)
      if (es?.readyState === EventSource.CLOSED && !disposed && timer == null) {
        timer = window.setTimeout(() => { timer = null; open() }, LIVE_RETRY_MS)
      }
    })
  }
  open()
  return () => {
    disposed = true
    if (timer != null) window.clearTimeout(timer)
    es?.close()
    onState(false)
  }
}
