import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchSensors, type Sensor } from './api'
import { useReadings } from './useReadings'
import Chart, { SLOT_COUNT, seriesName, type Selected } from './Chart'

const DAY = 86_400_000
const PRESETS: { label: string; days: number | null }[] = [
  { label: '24h', days: 1 }, { label: '7d', days: 7 }, { label: '30d', days: 30 },
  { label: '90d', days: 90 }, { label: '1y', days: 365 }, { label: 'All', days: null },
]
const METRIC_ORDER = ['temperature', 'humidity', 'pressure']

const nf = new Intl.NumberFormat()
const pad = (n: number) => String(n).padStart(2, '0')
/** Local time as "YYYY-MM-DD HH:MM" for the plain-text range inputs. */
function fmtLocal(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** Parses "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" (local time); NaN if invalid. */
function parseLocal(s: string) {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?\s*$/.exec(s)
  if (!m) return NaN
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)).getTime()
}

interface DeviceRow { id: number; name: string; location: string; sensors: Sensor[] }

const HOUR = 3_600_000, MONTH = 30.44 * DAY, YEAR = 365.25 * DAY
/**
 * Approximate, readable span: the two largest non-zero units, e.g. "~2 years 3 months",
 * "~6 days 4 hours", "~28 hours" (hours are used up to 3 days), "~45 minutes".
 */
function humanSpan(ms: number): string {
  if (!(ms > 0)) return ''
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'}`
  if (ms < HOUR) return `~${unit(Math.max(1, Math.round(ms / 60_000)), 'minute')}`
  if (ms < 3 * DAY) {
    const h = Math.floor(ms / HOUR), m = Math.round((ms - h * HOUR) / 60_000)
    return `~${unit(h, 'hour')}${m ? ' ' + unit(m, 'minute') : ''}`
  }
  const parts: [number, string][] = [[YEAR, 'year'], [MONTH, 'month'], [DAY, 'day'], [HOUR, 'hour']]
  const out: string[] = []
  let rest = ms
  for (const [size, name] of parts) {
    const n = Math.floor(rest / size)
    if (n > 0 || out.length) {
      if (n > 0) out.push(unit(n, name))
      rest -= n * size
    }
    if (out.length === 2) break
  }
  return `~${out.join(' ')}`
}

export default function App() {
  const [sensors, setSensors] = useState<Sensor[]>([])
  /** sensor id -> colour slot; insertion order is selection order. */
  const [slots, setSlots] = useState<Map<number, number>>(new Map())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [preset, setPreset] = useState<number | null>(30)
  const [custom, setCustom] = useState<{ from: number; to: number } | null>(null)
  const [draft, setDraft] = useState({ from: '', to: '' })
  const [draftError, setDraftError] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchSensors()
      .then((s) => {
        setSensors(s)
        // Default: the first device's temperature channel.
        const first = s.find((x) => x.metric === 'temperature') ?? s[0]
        if (first) setSlots((m) => (m.size ? m : new Map([[first.id, 0]])))
      })
      .catch((e: Error) => setLoadError(e.message))
  }, [])

  // Close the picker on outside click or Escape.
  useEffect(() => {
    if (!pickerOpen) return
    const onDown = (e: MouseEvent) => { if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [pickerOpen])

  const byId = useMemo(() => new Map(sensors.map((s) => [s.id, s])), [sensors])
  const devices = useMemo<DeviceRow[]>(() => {
    const m = new Map<number, DeviceRow>()
    for (const s of sensors) {
      let d = m.get(s.device_id)
      if (!d) { d = { id: s.device_id, name: s.device, location: s.location, sensors: [] }; m.set(s.device_id, d) }
      d.sensors.push(s)
    }
    for (const d of m.values()) d.sensors.sort((a, b) => METRIC_ORDER.indexOf(a.metric) - METRIC_ORDER.indexOf(b.metric))
    return [...m.values()]
  }, [sensors])
  const visibleDevices = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? devices.filter((d) => d.name.toLowerCase().includes(q) || d.location.toLowerCase().includes(q)) : devices
  }, [devices, filter])

  const selected = useMemo<Selected[]>(
    () => [...slots].map(([id, slot]) => ({ sensor: byId.get(id)!, slot })).filter((x) => x.sensor),
    [slots, byId],
  )
  const idsKey = useMemo(() => [...slots.keys()].sort((a, b) => a - b).join(','), [slots])
  const atLimit = slots.size >= SLOT_COUNT

  const toggle = (id: number) => {
    setSlots((m) => {
      const next = new Map(m)
      if (next.has(id)) { next.delete(id); return next }
      if (next.size >= SLOT_COUNT) return m
      const used = new Set(next.values())
      let slot = 0
      while (used.has(slot)) slot++
      next.set(id, slot)
      return next
    })
  }

  // Presets are anchored to the newest reading among the selected sensors so they always show
  // data, even on a historical dataset. Presets leave `to` open so the live tail can attach.
  const lastMs = selected.reduce((acc, s) => Math.max(acc, s.sensor.last_ms ?? 0), 0)
  const firstMs = selected.reduce((acc, s) => Math.min(acc, s.sensor.first_ms ?? Infinity), Infinity)
  const range = useMemo(() => {
    if (custom) return { from: custom.from, to: custom.to }
    if (!lastMs || preset == null) return { from: null, to: null }
    return { from: lastMs - preset * DAY, to: null }
  }, [custom, preset, lastMs])

  const { series, state } = useReadings(idsKey, range.from, range.to, live)

  const applyCustom = () => {
    const from = parseLocal(draft.from), to = parseLocal(draft.to)
    if (!Number.isFinite(from) || !Number.isFinite(to)) { setDraftError('Use YYYY-MM-DD or YYYY-MM-DD HH:MM'); return }
    if (from >= to) { setDraftError('From must be before To'); return }
    setDraftError(null); setCustom({ from, to }); setPreset(null)
  }
  const pickPreset = (days: number | null) => { setPreset(days); setCustom(null); setDraftError(null) }
  const prefillDraft = () => {
    if (!draft.from && !draft.to && Number.isFinite(firstMs) && lastMs) setDraft({ from: fmtLocal(firstMs), to: fmtLocal(lastMs) })
  }

  // Span of the data actually loaded (across all selected series), shown in the status line.
  const span = useMemo(() => {
    let min = Infinity, max = 0
    for (const ser of series.current.values()) {
      if (!ser.len) continue
      min = Math.min(min, ser.ts(0)); max = Math.max(max, ser.lastTs())
    }
    return max > min ? { min, max, text: humanSpan(max - min) } : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.version])

  const pct = state.expected ? Math.min(100, (state.loaded / state.expected) * 100) : 0
  const mbps = state.elapsedMs > 0 ? (state.bytesHint / 1_048_576) / (state.elapsedMs / 1000) : 0

  return (
    <div className="app">
      <div className="toolbar">
        <h1>Telemetry</h1>

        <div className="picker" ref={pickerRef}>
          <button aria-haspopup="dialog" aria-expanded={pickerOpen} onClick={() => setPickerOpen((o) => !o)}>
            Sensors ({slots.size}/{SLOT_COUNT}) ▾
          </button>
          {pickerOpen && (
            <div className="popover" role="dialog" aria-label="Choose sensors">
              <input className="filter" placeholder="Filter by device or location" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
              <div className="device-list">
                {visibleDevices.map((d) => (
                  <div className="device-row" key={d.id}>
                    <span className="device-name">{d.name}</span>
                    <span className="device-loc">{d.location}</span>
                    <span className="metrics">
                      {d.sensors.map((s) => {
                        const on = slots.has(s.id)
                        return (
                          <button key={s.id} className="metric-chip" aria-pressed={on} disabled={!on && atLimit}
                            onClick={() => toggle(s.id)} title={`${s.metric} (${s.unit})`}>
                            {on && <span className="swatch" style={{ background: `var(--series-${slots.get(s.id)! + 1})` }} />}
                            {s.metric}
                          </button>
                        )
                      })}
                    </span>
                  </div>
                ))}
                {!visibleDevices.length && <div className="empty">No devices match</div>}
              </div>
              {atLimit && <div className="hint">Up to {SLOT_COUNT} sensors can be overlaid at once.</div>}
            </div>
          )}
        </div>

        <div className="chips">
          {selected.map((it) => (
            <span className="chip" key={it.sensor.id}>
              <span className="swatch" style={{ background: `var(--series-${it.slot + 1})` }} />
              {seriesName(it.sensor)}
              <button className="chip-x" aria-label={`Remove ${seriesName(it.sensor)}`} onClick={() => toggle(it.sensor.id)}>×</button>
            </span>
          ))}
        </div>

        <div className="presets" role="group" aria-label="Time range">
          {PRESETS.map((p) => (
            <button key={p.label} aria-pressed={!custom && preset === p.days} onClick={() => pickPreset(p.days)}>{p.label}</button>
          ))}
        </div>
        <span className="field range">
          <input type="text" inputMode="numeric" aria-label="From" placeholder="YYYY-MM-DD HH:MM" value={draft.from}
            onFocus={prefillDraft} onChange={(e) => setDraft({ ...draft, from: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && applyCustom()} />
          –
          <input type="text" inputMode="numeric" aria-label="To" placeholder="YYYY-MM-DD HH:MM" value={draft.to}
            onFocus={prefillDraft} onChange={(e) => setDraft({ ...draft, to: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && applyCustom()} />
          <button onClick={applyCustom} disabled={!draft.from || !draft.to}>Apply</button>
        </span>
        <label className="toggle"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live tail</label>
      </div>

      <div className="status" aria-live="polite">
        {!slots.size && sensors.length > 0 && <span>Select at least one sensor.</span>}
        {state.phase === 'streaming' && <>
          <span>Streaming {nf.format(state.loaded)} / {nf.format(state.expected)} rows</span>
          <div className="progress"><div style={{ width: `${pct}%` }} /></div>
          <span>{mbps.toFixed(1)} MB/s</span>
        </>}
        {state.phase === 'done' && (
          <span>
            {nf.format(state.loaded)} rows · {selected.length} series
            {span && <> · <span title={`${new Date(span.min).toLocaleString()} – ${new Date(span.max).toLocaleString()}`}>{span.text}</span></>}
            {' '}in {(state.elapsedMs / 1000).toFixed(2)} s
          </span>
        )}
        {state.phase === 'done' && range.to == null && (
          <span><span className={`dot${state.liveConnected ? ' live' : ''}`} />{state.liveConnected ? `Live · ${nf.format(state.liveCount)} new` : 'Live off'}</span>
        )}
        {state.phase === 'done' && range.to != null && <span><span className="dot" />Fixed range, live tail not attached</span>}
        {(draftError || state.error || loadError) && <span className="error">{draftError ?? state.error ?? loadError}</span>}
      </div>

      <div className="chart-card">
        <Chart series={series} version={state.version} selected={selected} streaming={state.phase === 'streaming'} />
      </div>
    </div>
  )
}
