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
  const [showTable, setShowTable] = useState(false)
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

  const pct = state.expected ? Math.min(100, (state.loaded / state.expected) * 100) : 0
  const mbps = state.elapsedMs > 0 ? (state.bytesHint / 1_048_576) / (state.elapsedMs / 1000) : 0

  // Table view: newest 50 rows across the selected sensors.
  const latest = useMemo(() => {
    if (!showTable) return []
    const rows: { ts: number; s: Sensor; v: number }[] = []
    for (const it of selected) {
      const ser = series.current.get(it.sensor.id)
      if (!ser) continue
      for (let i = Math.max(0, ser.len - 50); i < ser.len; i++) rows.push({ ts: ser.ts(i), s: it.sensor, v: ser.value(i) })
    }
    return rows.sort((a, b) => b.ts - a.ts || a.s.id - b.s.id).slice(0, 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTable, selected, state.version])

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
        <label className="toggle"><input type="checkbox" checked={showTable} onChange={(e) => setShowTable(e.target.checked)} /> Table</label>
      </div>

      <div className="status" aria-live="polite">
        {!slots.size && sensors.length > 0 && <span>Select at least one sensor.</span>}
        {state.phase === 'streaming' && <>
          <span>Streaming {nf.format(state.loaded)} / {nf.format(state.expected)} rows</span>
          <div className="progress"><div style={{ width: `${pct}%` }} /></div>
          <span>{mbps.toFixed(1)} MB/s</span>
        </>}
        {state.phase === 'done' && <span>{nf.format(state.loaded)} rows · {selected.length} series in {(state.elapsedMs / 1000).toFixed(2)} s</span>}
        {state.phase === 'done' && range.to == null && (
          <span><span className={`dot${state.liveConnected ? ' live' : ''}`} />{state.liveConnected ? `Live · ${nf.format(state.liveCount)} new` : 'Live off'}</span>
        )}
        {state.phase === 'done' && range.to != null && <span><span className="dot" />Fixed range, live tail not attached</span>}
        {(draftError || state.error || loadError) && <span className="error">{draftError ?? state.error ?? loadError}</span>}
      </div>

      <div className="chart-card">
        <Chart series={series} version={state.version} selected={selected} streaming={state.phase === 'streaming'} />
      </div>

      {showTable && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Sensor</th><th>Value</th></tr></thead>
            <tbody>
              {latest.map((r) => (
                <tr key={`${r.s.id}-${r.ts}`}>
                  <td>{new Date(r.ts).toLocaleString()}</td>
                  <td><span className="swatch" style={{ background: `var(--series-${slots.get(r.s.id)! + 1})` }} />{seriesName(r.s)}</td>
                  <td>{r.v.toFixed(1)} {r.s.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
