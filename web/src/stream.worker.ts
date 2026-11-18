/// <reference lib="webworker" />
//
// Streams NDJSON readings off the main thread. The worker fetches, decodes and parses rows,
// and posts them back as transferable Float64Array triples (sensor_id, ts_ms, value), so the
// page only appends numbers into its series buffers and paints.

import type { StreamMeta } from './api'

export type WorkerIn = { type: 'start'; url: string }
export type WorkerOut =
  | { type: 'meta'; meta: StreamMeta }
  | { type: 'rows'; buf: Float64Array; n: number }
  | { type: 'done' }
  | { type: 'error'; message: string }

/** Post when this many rows are buffered ... */
const POST_ROWS = 50_000
/** ... or this long has passed since the last post, whichever first. */
const POST_EVERY_MS = 80

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer)

/**
 * Byte-level NDJSON parser for `[int,int,decimal]` rows. Avoids TextDecoder + split + slice +
 * Number for ~2.4M rows; anything unexpected (the meta object, or a malformed line) falls back
 * to decoding that line as text.
 */
class RowParser {
  private buf = new Float64Array(POST_ROWS * 3)
  private n = 0
  private lastPost = performance.now()
  // current row state
  private field = 0          // 0..2 = which number we're in; -1 = between rows
  private num = 0            // integer part accumulated so far
  private frac = 0           // fraction accumulated (digits after '.')
  private fracScale = 1      // 10^(fraction digits)
  private neg = false
  private inFrac = false
  private seenDigit = false
  private odd: number[] = [] // bytes of a line we couldn't parse (e.g. the meta object)
  private inOdd = false
  private decoder = new TextDecoder()

  feed(chunk: Uint8Array) {
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]
      if (this.inOdd) {
        if (b === 10) this.endOdd()
        else this.odd.push(b)
        continue
      }
      if (b >= 48 && b <= 57) {               // 0-9
        if (this.field < 0) { this.startOdd(b); continue }
        this.seenDigit = true
        if (this.inFrac) { this.frac = this.frac * 10 + (b - 48); this.fracScale *= 10 }
        else this.num = this.num * 10 + (b - 48)
      } else if (b === 44) {                  // ','
        if (!this.endNumber()) continue
      } else if (b === 93) {                  // ']'
        if (!this.endNumber()) continue
        if (this.field !== 3) { this.abandonRow(); continue }
        this.n++
        this.field = -1
        if (this.n >= POST_ROWS) this.flush()
      } else if (b === 91) {                  // '['
        if (this.field !== -1) { this.abandonRow(); continue }
        this.field = 0; this.resetNumber()
      } else if (b === 46) {                  // '.'
        this.inFrac = true
      } else if (b === 45) {                  // '-'
        this.neg = true
      } else if (b === 10 || b === 13 || b === 32) {
        // row separators / whitespace
      } else {
        this.startOdd(b)
      }
    }
    if (performance.now() - this.lastPost >= POST_EVERY_MS) this.flush()
  }

  private resetNumber() { this.num = 0; this.frac = 0; this.fracScale = 1; this.neg = false; this.inFrac = false; this.seenDigit = false }
  /** Commits the number being read into the current field; false if we weren't in a row. */
  private endNumber() {
    if (this.field < 0 || this.field > 2 || !this.seenDigit) { this.abandonRow(); return false }
    let v = this.num + (this.inFrac ? this.frac / this.fracScale : 0)
    if (this.neg) v = -v
    this.buf[this.n * 3 + this.field] = v
    this.field++
    this.resetNumber()
    return true
  }
  private abandonRow() { this.field = -1; this.resetNumber() }
  private startOdd(b: number) { this.abandonRow(); this.inOdd = true; this.odd = [b] }
  private endOdd() {
    this.inOdd = false
    const line = this.decoder.decode(new Uint8Array(this.odd)).trim()
    this.odd = []
    if (!line) return
    if (line.charCodeAt(0) === 123 /* '{' */) {
      const obj = JSON.parse(line)
      if (obj.type === 'meta') post({ type: 'meta', meta: obj })
      return
    }
    // Unknown line shape: try the generic JSON path so one odd row doesn't kill the stream.
    const arr = JSON.parse(line)
    if (Array.isArray(arr) && arr.length === 3) {
      this.buf[this.n * 3] = +arr[0]; this.buf[this.n * 3 + 1] = +arr[1]; this.buf[this.n * 3 + 2] = +arr[2]
      if (++this.n >= POST_ROWS) this.flush()
    }
  }
  flush() {
    if (!this.n) return
    // A timed flush can land mid-row: fields of the row in progress are already committed at
    // index n. Carry them into the fresh buffer or that row would surface with zeros (a sensor
    // id of 0, or a timestamp of 0 = 1970).
    const partial = this.field > 0 ? this.buf.slice(this.n * 3, this.n * 3 + this.field) : null
    post({ type: 'rows', buf: this.buf, n: this.n }, [this.buf.buffer])
    this.buf = new Float64Array(POST_ROWS * 3)
    if (partial) this.buf.set(partial, 0)
    this.n = 0
    this.lastPost = performance.now()
  }
  end() {
    if (this.inOdd) this.endOdd()
    this.flush()
  }
}

async function run(url: string) {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`stream: HTTP ${res.status} ${await res.text().catch(() => '')}`)
  const reader = res.body.getReader()
  const parser = new RowParser()
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
