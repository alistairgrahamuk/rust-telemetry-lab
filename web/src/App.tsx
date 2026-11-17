import { useEffect, useMemo, useState } from 'react'
import { fetchSensors, type Sensor } from './api'
import { useReadings } from './useReadings'
import Chart from './Chart'

const DAY = 86_400_000
const PRESETS: { label: string; days: number | null }[] = [
  { label: '24h', days: 1 }, { label: '7d', days: 7 }, { label: '30d', days: 30 },
  { label: '90d', days: 90 }, { label: '1y', days: 365 }, { label: 'All', days: null },
]

const nf = new Intl.NumberFormat()
function toLocalInput(ms: number) {
  const d = new Date(ms - new Date().getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}

export default function App() {
  const [sensors, setSensors] = useState<Sensor[]>([])
  const [sensorId, setSensorId] = useState<number | null>(null)
  const [preset, setPreset] = useState<number | null>(30)
  const [custom, setCustom] = useState<{ from: number; to: number } | null>(null)
  const [draft, setDraft] = useState({ from: '', to: '' })
  const [live, setLive] = useState(true)
  const [showTable, setShowTable] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    fetchSensors()
      .then((s) => { setSensors(s); setSensorId((id) => id ?? s[0]?.id ?? null) })
      .catch((e: Error) => setLoadError(e.message))
  }, [])

  const sensor = sensors.find((s) => s.id === sensorId)

  // Presets are anchored to the sensor's last reading so they always show data, even on a
  // historical dataset. "All" and presets leave `to` open so the live tail can attach.
  const range = useMemo(() => {
    if (custom) return { from: custom.from, to: custom.to }
    if (!sensor?.last_ms || preset == null) return { from: null, to: null }
    return { from: sensor.last_ms - preset * DAY, to: null }
  }, [custom, preset, sensor])

  const { rows, state } = useReadings(sensorId, range.from, range.to, live)

  const applyCustom = () => {
    const from = Date.parse(draft.from), to = Date.parse(draft.to)
    if (Number.isFinite(from) && Number.isFinite(to) && from < to) { setCustom({ from, to }); setPreset(null) }
  }
  const pickPreset = (days: number | null) => { setPreset(days); setCustom(null) }

  const pct = state.expected ? Math.min(100, (state.loaded / state.expected) * 100) : 0
  const mbps = state.elapsedMs > 0 ? (state.bytesHint / 1_048_576) / (state.elapsedMs / 1000) : 0
  const latest = showTable ? rows.current.slice(-50).reverse() : []

  return (
    <div className="app">
      <div className="toolbar">
        <h1>Telemetry</h1>
        <label className="field">Sensor
          <select value={sensorId ?? ''} onChange={(e) => setSensorId(Number(e.target.value))}>
            {sensors.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.location}</option>)}
          </select>
        </label>
        <div className="presets" role="group" aria-label="Time range">
          {PRESETS.map((p) => (
            <button key={p.label} aria-pressed={!custom && preset === p.days} onClick={() => pickPreset(p.days)}>{p.label}</button>
          ))}
        </div>
        <span className="field">
          <input type="datetime-local" aria-label="From" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })}
            onFocus={() => !draft.from && sensor?.first_ms && setDraft({ from: toLocalInput(sensor.first_ms), to: toLocalInput(sensor.last_ms ?? Date.now()) })} />
          –
          <input type="datetime-local" aria-label="To" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
          <button onClick={applyCustom} disabled={!draft.from || !draft.to}>Apply</button>
        </span>
        <label className="toggle"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live tail</label>
        <label className="toggle"><input type="checkbox" checked={showTable} onChange={(e) => setShowTable(e.target.checked)} /> Table</label>
      </div>

      <div className="status" aria-live="polite">
        {state.phase === 'streaming' && <>
          <span>Streaming {nf.format(state.loaded)} / {nf.format(state.expected)} rows</span>
          <div className="progress"><div style={{ width: `${pct}%` }} /></div>
          <span>{mbps.toFixed(1)} MB/s</span>
        </>}
        {state.phase === 'done' && <span>{nf.format(state.loaded)} rows in {(state.elapsedMs / 1000).toFixed(2)} s</span>}
        {state.phase === 'done' && range.to == null && (
          <span><span className={`dot${state.liveConnected ? ' live' : ''}`} />{state.liveConnected ? `Live · ${nf.format(state.liveCount)} new` : 'Live off'}</span>
        )}
        {state.phase === 'done' && range.to != null && <span><span className="dot" />Fixed range, live tail not attached</span>}
        {(state.error || loadError) && <span className="error">{state.error ?? loadError}</span>}
      </div>

      <div className="chart-card">
        {sensorId != null && <Chart rows={rows} version={state.version} title={sensor?.name ?? `sensor ${sensorId}`} />}
      </div>

      {showTable && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Temperature (°C)</th><th>Humidity (%)</th><th>Pressure (hPa)</th></tr></thead>
            <tbody>
              {latest.map((r) => (
                <tr key={r[0]}><td>{new Date(r[0]).toLocaleString()}</td><td>{r[1].toFixed(1)}</td><td>{r[2].toFixed(1)}</td><td>{r[3].toFixed(1)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
