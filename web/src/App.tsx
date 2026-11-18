import { useCallback, useEffect, useMemo, useState } from 'react'
import GridLayout, { useContainerWidth, verticalCompactor, type Layout } from 'react-grid-layout'
import { fetchSensors, type Sensor } from './api'
import { DAY, humanSpan } from './format'
import { useSeriesStore } from './useSeriesStore'
import Widget from './Widget'
import {
  COLS, ROW_HEIGHT, type Dashboard, type Widget as WidgetConfig,
  emptyDashboard, loadDashboard, newId, placeNew, saveDashboard, widgetSensorIds,
} from './dashboard'

const PRESETS: { label: string; days: number | null }[] = [
  { label: '24h', days: 1 }, { label: '7d', days: 7 }, { label: '30d', days: 30 },
  { label: '90d', days: 90 }, { label: '1y', days: 365 }, { label: 'All', days: null },
]

const nf = new Intl.NumberFormat()

export default function App() {
  const [sensors, setSensors] = useState<Sensor[]>([])
  const [dash, setDash] = useState<Dashboard>(() => loadDashboard() ?? emptyDashboard())
  const [hadSaved] = useState(() => loadDashboard() != null)
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
  // Presets are anchored to the newest reading so they always show data; `to` stays open so
  // the live tail can attach.
  const range = useMemo(() => {
    if (!lastMs || dash.preset == null) return { from: null, to: null }
    return { from: lastMs - dash.preset * DAY, to: null }
  }, [dash.preset, lastMs])

  const { series, state } = useSeriesStore(wantedKey, range.from, range.to, dash.live)
  const streaming = state.pending > 0

  const pickPreset = (days: number | null) => setDash((d) => ({ ...d, preset: days }))

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
      <div className="header">
        <h1>Telemetry</h1>
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
        {!streaming && wantedIds.length > 0 && (
          <span><span className={`dot${state.liveConnected ? ' live' : ''}`} />{state.liveConnected ? `Live · ${nf.format(state.liveCount)} new` : dash.live ? 'Live · connecting…' : 'Live off'}</span>
        )}
        {(state.error || loadError) && <span className="error">{state.error ?? loadError}</span>}
        </div>
      </div>

      <div className="controls" role="toolbar" aria-label="Dashboard controls">
        <button className="primary" onClick={() => setDash((d) => addWidget(d, []))}>+ Add widget</button>
        <span className="sep" />
        <div className="presets" role="group" aria-label="Time range">
          {PRESETS.map((p) => (
            <button key={p.label} aria-pressed={dash.preset === p.days} onClick={() => pickPreset(p.days)}>{p.label}</button>
          ))}
        </div>
        <span className="sep" />
        <label className="toggle"><input type="checkbox" checked={dash.live} onChange={(e) => setDash((d) => ({ ...d, live: e.target.checked }))} /> Live tail</label>
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
