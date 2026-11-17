import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { DataZoomComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { Sensor } from './api'
import type { SeriesMap } from './useReadings'

echarts.use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, TitleComponent, LegendComponent, CanvasRenderer])

/** Fixed slot order; a sensor keeps its slot for as long as it is selected (overlay layout). */
export const SLOT_COUNT = 8
/** Small-multiples layout: one panel per sensor, colour by metric, so many more fit. */
export const GRID_LIMIT = 32
export type Layout = 'overlay' | 'grid'

/** Panels are ordered by metric so the layout is predictable; unknown metrics go last. */
const METRIC_ORDER = ['temperature', 'humidity', 'pressure']

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
export const slotColor = (slot: number) => cssVar(`--series-${slot + 1}`)

export const seriesName = (s: Sensor) => `${s.device} ${s.metric}`
const cap = (m: string) => m[0].toUpperCase() + m.slice(1)

/** In the grid layout every panel names its device, so colour only needs to say which metric. */
export function metricSlot(metric: string) {
  const i = METRIC_ORDER.indexOf(metric)
  return i < 0 ? 3 : i
}
export function colorSlot(it: Selected, layout: Layout) {
  return layout === 'grid' ? metricSlot(it.sensor.metric) : it.slot
}

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

export interface Selected {
  sensor: Sensor
  slot: number
}

interface Panel {
  unit: string
  title: string
  items: Selected[]
}

/** Group selected sensors by unit: one panel per unit, so different units never share an axis. */
export function buildPanels(selected: Selected[]): Panel[] {
  const byUnit = new Map<string, Panel>()
  for (const it of selected) {
    const u = it.sensor.unit
    let p = byUnit.get(u)
    if (!p) {
      p = { unit: u, title: '', items: [] }
      byUnit.set(u, p)
    }
    p.items.push(it)
  }
  const panels = [...byUnit.values()]
  for (const p of panels) {
    const metrics = [...new Set(p.items.map((i) => i.sensor.metric))]
    p.title = `${metrics.map(cap).join(' / ')} (${p.unit})`
  }
  const rank = (p: Panel) => {
    const i = METRIC_ORDER.indexOf(p.items[0].sensor.metric)
    return i < 0 ? METRIC_ORDER.length : i
  }
  return panels.sort((a, b) => rank(a) - rank(b) || a.unit.localeCompare(b.unit))
}

/** Small multiples: one panel per sensor, device-major so a row reads as one device. */
export function buildGridPanels(selected: Selected[]): Panel[] {
  const sorted = [...selected].sort((a, b) =>
    a.sensor.device_id - b.sensor.device_id || metricSlot(a.sensor.metric) - metricSlot(b.sensor.metric) || a.sensor.id - b.sensor.id)
  return sorted.map((it) => ({ unit: it.sensor.unit, title: `${it.sensor.device} · ${cap(it.sensor.metric)} (${it.sensor.unit})`, items: [it] }))
}

/** Rows of panels for a given panel count and container width (3 columns wide, 1 narrow). */
export function gridColumns(panelCount: number, width: number) {
  if (width < 700) return 1
  return Math.min(3, Math.max(1, panelCount))
}
export const GRID_ROW_PX = 170

interface Props {
  /** Shared, mutated-in-place buffers; `version` tells us when to re-read them. */
  series: RefObject<SeriesMap>
  version: number
  selected: Selected[]
  layout: Layout
  /** While true, chart refreshes are rate-limited; a final refresh runs when it turns false. */
  streaming: boolean
}

/** Refresh pacing while rows stream in: never more often than this ... */
const MIN_REFRESH_MS = 400
/** ... and back off so a refresh costs at most ~1/5 of wall time (ECharts re-ingests every point). */
const REFRESH_DUTY = 5
const MAX_REFRESH_MS = 10_000

/** Stacked panels (one per unit) with overlaid sensors, a shared x-axis, crosshair, legend and zoom. */
export default function Chart({ series, version, selected, layout, streaming }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  const lastPush = useRef({ at: 0, cost: 0 })
  const pushTimer = useRef<number | null>(null)
  const [width, setWidth] = useState(1200)
  const panels = useMemo(() => (layout === 'grid' ? buildGridPanels(selected) : buildPanels(selected)), [selected, layout])
  const cols = layout === 'grid' ? gridColumns(panels.length, width) : 1
  const structureKey = `${layout}/${cols}/` + panels.map((p) => `${p.unit}:${p.items.map((i) => `${i.sensor.id}@${i.slot}`).join('+')}`).join('|')

  // Series are flattened in panel order; this maps sensor id -> series index.
  const order = useMemo(() => panels.flatMap((p) => p.items), [panels])

  const seriesData = (id: number) => series.current?.get(id)?.view() ?? new Float64Array(0)

  /** Per-unit [min, max] over everything loaded, so small multiples share a comparable scale. */
  const unitExtents = () => {
    const ext = new Map<string, [number, number]>()
    for (const it of order) {
      const ser = series.current?.get(it.sensor.id)
      if (!ser?.len) continue
      let [lo, hi] = ext.get(it.sensor.unit) ?? [Infinity, -Infinity]
      for (let i = 0; i < ser.len; i++) { const v = ser.value(i); if (v < lo) lo = v; if (v > hi) hi = v }
      ext.set(it.sensor.unit, [lo, hi])
    }
    // Snap to "nice" bounds (multiples of 1/2/5 x 10^k) so the shared axes read cleanly.
    const out = new Map<string, { min: number; max: number; interval: number }>()
    for (const [u, [lo, hi]] of ext) {
      if (!Number.isFinite(lo)) continue
      const raw = (hi - lo || 1) / 3
      const mag = 10 ** Math.floor(Math.log10(raw))
      const step = [1, 2, 5, 10].map((m) => m * mag).find((v) => v >= raw) ?? 10 * mag
      out.set(u, { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, interval: step })
    }
    return out
  }

  const buildOption = () => {
    const ink = cssVar('--text'), ink2 = cssVar('--text-2'), muted = cssVar('--muted'), grid = cssVar('--grid'), axis = cssVar('--axis'), surface = cssVar('--surface')
    const n = Math.max(panels.length, 1)
    const isGrid = layout === 'grid'
    const legendH = !isGrid && order.length > 1 ? 7 : 0   // % of height reserved for the legend row
    const top = (isGrid ? 1 : 4) + legendH, bottom = isGrid ? Math.min(12, 6000 / Math.max(1, Math.ceil(n / cols) * GRID_ROW_PX)) : 12
    const rows = Math.ceil(n / cols)
    const rowSpan = (100 - top - bottom) / rows
    const colSpan = 100 / cols
    // Panel i sits at (row, col); titles live in the top ~22px of each cell.
    const cell = (i: number) => ({ row: Math.floor(i / cols), col: i % cols })
    const gridFor = (i: number) => {
      const { row, col } = cell(i)
      // Grid cell: title in the top 18% of the row, plot in the next 62%, the rest is breathing room.
      return isGrid
        ? { top: `${top + row * rowSpan + rowSpan * 0.18}%`, height: `${rowSpan * 0.62}%`, left: `${col * colSpan + 1}%`, width: `${colSpan - 2.5}%`, containLabel: true }
        : { top: `${top + row * rowSpan + 4}%`, height: `${rowSpan - 8}%`, left: 64, right: 24 }
    }
    const titleFor = (i: number) => {
      const { row, col } = cell(i)
      return isGrid
        ? { left: `${col * colSpan + 1}%`, top: `${top + row * rowSpan}%` }
        : { left: 64, top: `${top + row * rowSpan - 0.5}%` }
    }
    const extents = isGrid ? unitExtents() : new Map<string, { min: number; max: number; interval: number }>()
    const lastRowStart = (rows - 1) * cols

    return {
      animation: false,
      backgroundColor: 'transparent',
      textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
      legend: {
        show: !isGrid && order.length > 1, top: 6, left: 64, right: 24, type: 'scroll',
        icon: 'roundRect', itemWidth: 14, itemHeight: 4,
        textStyle: { color: ink2, fontSize: 12 },
        data: order.map((it) => seriesName(it.sensor)),
      },
      title: panels.map((p, i) => ({
        text: p.title, ...titleFor(i),
        textStyle: { fontSize: isGrid ? 12 : 13, fontWeight: 600, color: ink2 },
      })),
      axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: muted }, label: { backgroundColor: ink2 } },
      tooltip: {
        trigger: 'axis', backgroundColor: surface, borderColor: axis, textStyle: { color: ink, fontSize: 12 },
        formatter: (params: unknown) => {
          const ps = params as { seriesIndex: number; seriesName: string; value: [number, number]; marker: string }[]
          if (!ps.length) return ''
          const unit = order[ps[0].seriesIndex]?.sensor.unit ?? ''
          const lines = ps.map((p) => `${p.marker} ${p.seriesName}: <b>${p.value[1].toFixed(1)} ${unit}</b>`)
          return `${fmtTime(ps[0].value[0])}<br/>${lines.join('<br/>')}`
        },
      },
      grid: panels.map((_, i) => gridFor(i)),
      xAxis: panels.map((_, i) => {
        const bottomRow = isGrid ? i >= lastRowStart : i === panels.length - 1
        return {
          type: 'time', gridIndex: i,
          axisLine: { lineStyle: { color: axis } }, axisTick: { show: bottomRow },
          axisLabel: { show: bottomRow, color: muted, hideOverlap: true, fontSize: isGrid ? 11 : 12 },
          splitLine: { show: false },
        }
      }),
      yAxis: panels.map((p, i) => {
        const ext = extents.get(p.unit)
        return {
          type: 'value', gridIndex: i, scale: true,
          ...(ext ? { min: ext.min, max: ext.max, interval: ext.interval } : {}),
          axisLabel: { color: muted, fontSize: isGrid ? 11 : 12 }, splitLine: { lineStyle: { color: grid } }, splitNumber: isGrid ? 2 : 3,
        }
      }),
      dataZoom: [
        { type: 'inside', xAxisIndex: panels.map((_, i) => i), filterMode: 'filter' },
        {
          type: 'slider', xAxisIndex: panels.map((_, i) => i), bottom: 8, height: 22, left: 64, right: 24,
          borderColor: axis, fillerColor: 'rgba(42,120,214,0.12)', handleStyle: { color: surface, borderColor: muted },
          textStyle: { color: muted }, dataBackground: { lineStyle: { color: axis }, areaStyle: { color: grid } },
        },
      ],
      series: panels.flatMap((p, gi) => p.items.map((it) => ({
        name: seriesName(it.sensor), type: 'line', xAxisIndex: gi, yAxisIndex: gi,
        showSymbol: false, symbol: 'none',
        lineStyle: { width: isGrid ? 1.2 : 1.5, color: slotColor(colorSlot(it, layout)) }, itemStyle: { color: slotColor(colorSlot(it, layout)) },
        sampling: 'lttb', large: true, largeThreshold: 20_000,
        // Flat typed array of (ts, value) pairs; `dimensions` tells ECharts the stride.
        dimensions: ['ts', 'value'],
        encode: { x: 'ts', y: 'value' },
        data: seriesData(it.sensor.id),
      }))),
    }
  }

  // Create once; rebuild the whole option when the panel structure or theme changes.
  useEffect(() => {
    if (!el.current) return
    if (!chart.current) chart.current = echarts.init(el.current, undefined, { renderer: 'canvas' })
    chart.current.setOption(buildOption(), { notMerge: true })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onTheme = () => chart.current?.setOption(buildOption(), { notMerge: true })
    mq.addEventListener('change', onTheme)
    return () => mq.removeEventListener('change', onTheme)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey])

  useEffect(() => {
    if (!el.current) return
    const ro = new ResizeObserver((entries) => { chart.current?.resize(); setWidth(entries[0].contentRect.width) })
    ro.observe(el.current)
    return () => { ro.disconnect(); chart.current?.dispose(); chart.current = null }
  }, [])

  // Data-only update: hand ECharts the current buffers in series order. ECharts re-ingests and
  // re-samples every point on each call, so while streaming we pace calls by how long the last
  // one took (otherwise a 2M-point load spends most of its time blocking the main thread).
  const push = () => {
    const c = chart.current
    if (!c) return
    const t0 = performance.now()
    const patch: Record<string, unknown> = { series: order.map((it) => ({ data: seriesData(it.sensor.id) })) }
    if (layout === 'grid') {
      // Keep the shared per-unit scale in step with the data as it streams in.
      const extents = unitExtents()
      patch.yAxis = panels.map((p) => { const e = extents.get(p.unit); return e ? { min: e.min, max: e.max, interval: e.interval } : {} })
    }
    c.setOption(patch, { lazyUpdate: true })
    lastPush.current = { at: performance.now(), cost: performance.now() - t0 }
  }
  useEffect(() => {
    if (pushTimer.current != null) { window.clearTimeout(pushTimer.current); pushTimer.current = null }
    if (!streaming) { push(); return }
    const gap = Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, lastPush.current.cost * REFRESH_DUTY))
    const wait = lastPush.current.at + gap - performance.now()
    if (wait <= 0) push()
    else pushTimer.current = window.setTimeout(() => { pushTimer.current = null; push() }, wait)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, structureKey, streaming])

  const label = order.map((it) => seriesName(it.sensor)).join(', ') || 'no sensors selected'
  return <div className="chart" ref={el} role="img" aria-label={`Readings over time for ${label}`} />
}
