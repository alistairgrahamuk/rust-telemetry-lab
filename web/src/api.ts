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
  onRows: (rows: Reading[]) => void
}

/**
 * Streams NDJSON rows for a set of sensors over a range, calling onRows for every network
 * chunk so the chart can render progressively. Resolves when the server closes the stream.
 */
export async function streamReadings(
  sensorIds: number[],
  fromMs: number | null,
  toMs: number | null,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const params = new URLSearchParams({ sensor_ids: sensorIds.join(',') })
  if (fromMs != null) params.set('from', new Date(fromMs).toISOString())
  if (toMs != null) params.set('to', new Date(toMs).toISOString())

  const res = await fetch(`/api/readings/stream?${params}`, { signal })
  if (!res.ok || !res.body) throw new Error(`stream: HTTP ${res.status} ${await res.text().catch(() => '')}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let tail = ''

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    tail += decoder.decode(value, { stream: true })
    const lastNl = tail.lastIndexOf('\n')
    if (lastNl < 0) continue
    const complete = tail.slice(0, lastNl)
    tail = tail.slice(lastNl + 1)

    const rows: Reading[] = []
    for (const line of complete.split('\n')) {
      if (!line) continue
      if (line.charCodeAt(0) === 123 /* '{' */) {
        const obj = JSON.parse(line)
        if (obj.type === 'meta') handlers.onMeta(obj)
        continue
      }
      rows.push(JSON.parse(line))
    }
    if (rows.length) handlers.onRows(rows)
  }
  if (tail.trim()) handlers.onRows([JSON.parse(tail)])
}

/** Subscribes to new rows after `afterMs` for a set of sensors via SSE. Returns a disposer. */
export function subscribeLive(
  sensorIds: number[],
  afterMs: number,
  onRows: (rows: Reading[]) => void,
  onError: (msg: string) => void,
): () => void {
  const params = new URLSearchParams({ sensor_ids: sensorIds.join(','), after: new Date(afterMs).toISOString() })
  const es = new EventSource(`/api/readings/live?${params}`)
  es.addEventListener('rows', (e) => onRows(JSON.parse((e as MessageEvent).data)))
  es.addEventListener('error', (e) => {
    const data = (e as MessageEvent).data
    if (data) onError(String(data))
    // Connection-level errors: EventSource reconnects on its own.
  })
  return () => es.close()
}
