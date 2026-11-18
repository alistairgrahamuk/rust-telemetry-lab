import { useCallback, useEffect, useMemo, useState } from 'react'
import GridLayout, { useContainerWidth, verticalCompactor, type Layout } from 'react-grid-layout'
import { fetchSensors, type Sensor } from './api'
import { useSeriesStore } from './useSeriesStore'
import Widget from './Widget'
import {
  COLS, ROW_HEIGHT, type Dashboard, type Widget as WidgetConfig,
  emptyDashboard, loadDashboard, newId, placeNew, saveDashboard, widgetSensorIds,
} from './dashboard'

const DAY = 86_400_000
const PRESETS: { label: string; days: number | null }[] = [
  { label: '24h', days: 1 }, { label: '7d', days: 7 }, { label: '30d', days: 30 },
  { label: '90d', days: 90 }, { label: '1y', days: 365 }, { label: 'All', days: null },
]

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

const HOUR = 3_600_000, MONTH = 30.44 * DAY, YEAR = 365.25 * DAY
/** Approximate, readable span: the two largest non-zero units, e.g. "~2 years 3 months". */
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
  const [dash, setDash] = useState<Dashboard>(() => loadDashboard() ?? emptyDashboard())
  const [hadSaved] = useState(() => loadDashboard() != null)
  const [draft, setDraft] = useState({ from: '', to: '' })
  const [draftError, setDraftError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const { width, containerRef, mounted } = useContainerWidth()

  useEffect(() => {
    fetchSensors()
      .then((s) => {
        setSensors(s)
        // First visit: one widget with the first device's temperature channel.
        if (!hadSaved) {
          const first = s.find((x) => x.metric === 'temperature') ?? s[0]
          if (first) setDash((d) => d.widgets.length ? d : addWidget(d, [{ id: first.id, slot: 0 }]))
        }
      })
      .catch((e: Error) => setLoadError(e.message))
  }, [hadSaved])

  useEffect(() => { saveDashboard(dash) }, [dash])

  const byId = useMemo(() => new Map(sensors.map((s) => [s.id, s])), [sensors])

  // Union of every widget's sensors drives fetching; presets anchor to its newest reading.
  const wantedIds = useMemo(() => [...new Set(dash.widgets.flatMap(widgetSensorIds))].sort((a, b) => a - b), [dash.widgets])
  const wantedKey = wantedIds.join(',')
  const lastMs = wantedIds.reduce((acc, id) => Math.max(acc, byId.get(id)?.last_ms ?? 0), 0)
  const firstMs = wantedIds.reduce((acc, id) => Math.min(acc, byId.get(id)?.first_ms ?? Infinity), Infinity)
  const range = useMemo(() => {
    if (dash.custom) return { from: dash.custom.from, to: dash.custom.to }
    if (!lastMs || dash.preset == null) return { from: null, to: null }
    return { from: lastMs - dash.preset * DAY, to: null }
  }, [dash.custom, dash.preset, lastMs])

  const { series, state } = useSeriesStore(wantedKey, range.from, range.to, dash.live)
  const streaming = state.pending > 0

  const applyCustom = () => {
    const from = parseLocal(draft.from), to = parseLocal(draft.to)
    if (!Number.isFinite(from) || !Number.isFinite(to)) { setDraftError('Use YYYY-MM-DD or YYYY-MM-DD HH:MM'); return }
    if (from >= to) { setDraftError('From must be before To'); return }
    setDraftError(null); setDash((d) => ({ ...d, custom: { from, to }, preset: null }))
  }
  const pickPreset = (days: number | null) => { setDraftError(null); setDash((d) => ({ ...d, preset: days, custom: null })) }
  const prefillDraft = () => {
    if (!draft.from && !draft.to && Number.isFinite(firstMs) && lastMs) setDraft({ from: fmtLocal(firstMs), to: fmtLocal(lastMs) })
  }

  const updateWidget = useCallback((id: string, fn: (w: WidgetConfig) => WidgetConfig) =>
    setDash((d) => ({ ...d, widgets: d.widgets.map((x) => (x.id === id ? fn(x) : x)) })), [])
  const removeWidget = useCallback((id: string) => setDash((d) => ({
    ...d, widgets: d.widgets.filter((w) => w.id !== id), layout: d.layout.filter((l) => l.i !== id),
  })), [])
  const onLayoutChange = useCallback((layout: Layout) => setDash((d) => (sameLayout(d.layout, layout) ? d : { ...d, layout })), [])

  // Span of the data actually loaded, shown in the status line.
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

  return (
    <div className="app">
      <div className="toolbar">
        <h1>Telemetry</h1>
        <button className="primary" onClick={() => setDash((d) => addWidget(d, []))}>+ Add widget</button>
        <span className="spacer" />
        <div className="presets" role="group" aria-label="Time range">
          {PRESETS.map((p) => (
            <button key={p.label} aria-pressed={!dash.custom && dash.preset === p.days} onClick={() => pickPreset(p.days)}>{p.label}</button>
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
        <label className="toggle"><input type="checkbox" checked={dash.live} onChange={(e) => setDash((d) => ({ ...d, live: e.target.checked }))} /> Live tail</label>
      </div>

      <div className="status" aria-live="polite">
        {!dash.widgets.length && sensors.length > 0 && <span>Add a widget to get started.</span>}
        {dash.widgets.length > 0 && !wantedIds.length && <span>Pick sensors on a widget to see data.</span>}
        {streaming && <>
          <span>Streaming {nf.format(state.loaded)} / {nf.format(state.expected)} rows</span>
          <div className="progress"><div style={{ width: `${pct}%` }} /></div>
        </>}
        {!streaming && wantedIds.length > 0 && (
          <span>
            {nf.format(state.loaded)} rows · {wantedIds.length} sensor{wantedIds.length === 1 ? '' : 's'} · {dash.widgets.length} widget{dash.widgets.length === 1 ? '' : 's'}
            {span && <> · <span title={`${new Date(span.min).toLocaleString()} – ${new Date(span.max).toLocaleString()}`}>{span.text}</span></>}
            {state.elapsedMs > 0 && <> in {(state.elapsedMs / 1000).toFixed(2)} s</>}
          </span>
        )}
        {!streaming && wantedIds.length > 0 && range.to == null && (
          <span><span className={`dot${state.liveConnected ? ' live' : ''}`} />{state.liveConnected ? `Live · ${nf.format(state.liveCount)} new` : 'Live off'}</span>
        )}
        {!streaming && wantedIds.length > 0 && range.to != null && <span><span className="dot" />Fixed range, live tail not attached</span>}
        {(draftError || state.error || loadError) && <span className="error">{draftError ?? state.error ?? loadError}</span>}
      </div>

      <div className="grid-host" ref={containerRef}>
        {mounted && (
          <GridLayout
            width={width}
            layout={dash.layout}
            gridConfig={{ cols: COLS, rowHeight: ROW_HEIGHT, margin: [12, 12], containerPadding: [0, 0] }}
            dragConfig={{ enabled: true, handle: '.widget-head', cancel: '.no-drag' }}
            resizeConfig={{ enabled: true, handles: ['se'] }}
            compactor={verticalCompactor}
            onLayoutChange={onLayoutChange}
          >
            {dash.widgets.map((w) => (
              <div key={w.id}>
                <Widget widget={w} sensors={sensors} byId={byId} series={series} version={state.version} streaming={streaming}
                  onChange={(fn) => updateWidget(w.id, fn)} onRemove={() => removeWidget(w.id)} />
              </div>
            ))}
          </GridLayout>
        )}
      </div>
    </div>
  )
}

function addWidget(d: Dashboard, sensors: WidgetConfig['sensors']): Dashboard {
  const id = newId()
  return { ...d, widgets: [...d.widgets, { id, title: '', sensors }], layout: [...d.layout, placeNew(d.layout, id)] }
}

function sameLayout(a: Layout, b: Layout) {
  if (a.length !== b.length) return false
  const m = new Map(a.map((l) => [l.i, l]))
  return b.every((l) => { const o = m.get(l.i); return o && o.x === l.x && o.y === l.y && o.w === l.w && o.h === l.h })
}
