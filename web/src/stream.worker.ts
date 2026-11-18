/// <reference lib="webworker" />
//
// Streams NDJSON readings off the main thread. The worker fetches, decodes and parses rows
// (see rowParser.ts), and posts them back as transferable Float64Array triples
// (sensor_id, ts_ms, value), so the page only appends numbers into its series buffers and paints.

import { RowParser, type ParserOut } from './rowParser'

export type WorkerIn = { type: 'start'; url: string }
export type WorkerOut = ParserOut | { type: 'done' } | { type: 'error'; message: string }

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer)

async function run(url: string) {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`stream: HTTP ${res.status} ${await res.text().catch(() => '')}`)
  const reader = res.body.getReader()
  const parser = new RowParser(post)
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    parser.feed(value)
  }
  parser.end()
  post({ type: 'done' })
}

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  if (e.data.type === 'start') {
    run(e.data.url).catch((err: unknown) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
  }
}
