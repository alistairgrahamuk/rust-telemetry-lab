import { useEffect, useMemo, useRef, type RefObject } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { DataZoomComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { Sensor } from './api'
import type { Series, SeriesMap } from './series'

echarts.use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, TitleComponent, LegendComponent, CanvasRenderer])

/** Fixed slot order; a sensor keeps its slot for as long as it is selected. */
export const SLOT_COUNT = 8
/** Below this height the zoom slider is dropped so the panels keep room to breathe. */
const COMPACT_BELOW_PX = 300

/** Panels are ordered by metric so the layout is predictable; unknown metrics go last. */
const METRIC_ORDER = ['temperature', 'humidity', 'pressure']

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}
export const slotColor = (slot: number) => cssVar(`--series-${slot + 1}`)

export const seriesName = (s: Sensor) => `${s.device} ${s.metric}`

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

/** Index of the point whose timestamp is closest to `t` (series are time-ordered). */
function nearestIndex(ser: Series, t: number): number {
  let lo = 0, hi = ser.len - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ser.ts(mid) < t) lo = mid + 1
    else hi = mid
  }
  return lo > 0 && t - ser.ts(lo - 1) < ser.ts(lo) - t ? lo - 1 : lo
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
    p.title = `${metrics.map((m) => m[0].toUpperCase() + m.slice(1)).join(' / ')} (${p.unit})`
  }
  const rank = (p: Panel) => {
    const i = METRIC_ORDER.indexOf(p.items[0].sensor.metric)
    return i < 0 ? METRIC_ORDER.length : i
  }
  return panels.sort((a, b) => rank(a) - rank(b) || a.unit.localeCompare(b.unit))
}

interface Props {
  /** Shared, mutated-in-place buffers; `version` tells us when to re-read them. */
  series: RefObject<SeriesMap>
  version: number
  selected: Selected[]
  /** While true, chart refreshes are rate-limited; a final refresh runs when it turns false. */
  streaming: boolean
}

/** Refresh pacing while rows stream in: never more often than this ... */
const MIN_REFRESH_MS = 400
/** ... and back off so a refresh costs at most ~1/5 of wall time (ECharts re-ingests every point). */
const REFRESH_DUTY = 5
const MAX_REFRESH_MS = 10_000

/** Stacked panels (one per unit) with overlaid sensors, a shared x-axis, crosshair, legend and zoom. */
export default function Chart({ series, version, selected, streaming }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  const lastPush = useRef({ at: 0, cost: 0 })
  const pushTimer = useRef<number | null>(null)
  const panels = useMemo(() => buildPanels(selected), [selected])
  const structureKey = panels.map((p) => `${p.unit}:${p.items.map((i) => `${i.sensor.id}@${i.slot}`).join('+')}`).join('|')

  // Series are flattened in panel order; this maps sensor id -> series index.
  const order = useMemo(() => panels.flatMap((p) => p.items), [panels])

  const seriesData = (id: number) => series.current?.get(id)?.view() ?? new Float64Array(0)

  const buildOption = () => {
    const ink = cssVar('--text'), ink2 = cssVar('--text-2'), muted = cssVar('--muted'), grid = cssVar('--grid'), axis = cssVar('--axis'), surface = cssVar('--surface')
    const H = el.current?.clientHeight || 400
    const compact = H < COMPACT_BELOW_PX
    const n = Math.max(panels.length, 1)
    // Pixel layout so small widgets stay usable: legend row, per-panel title, x labels, slider.
    const legendH = order.length > 1 ? 26 : 0
    const titleH = 20
    const top = 6 + legendH
    const bottom = compact ? 28 : 64
    const span = Math.max(40, (H - top - bottom) / n)
    const gridFor = (i: number) => ({ top: top + i * span + titleH, height: Math.max(20, span - titleH - 8), left: 56, right: 16 })

    return {
      animation: false,
      backgroundColor: 'transparent',
      textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
      legend: {
        show: order.length > 1, top: 4, left: 56, right: 16, type: 'scroll',
        icon: 'roundRect', itemWidth: 14, itemHeight: 4,
        textStyle: { color: ink2, fontSize: 12 },
        data: order.map((it) => seriesName(it.sensor)),
      },
      title: panels.map((p, i) => ({
        text: p.title, left: 56, top: top + i * span - 2,
        textStyle: { fontSize: 12, fontWeight: 600, color: ink2 },
      })),
      axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: muted }, label: { backgroundColor: ink2 } },
      tooltip: {
        trigger: 'axis', backgroundColor: surface, borderColor: axis, textStyle: { color: ink, fontSize: 12 },
        // ECharts only lists series with a point at the exact hovered instant, and LTTB keeps
        // different points per series, so look up every series' nearest value ourselves.
        formatter: (params: unknown) => {
          const ps = params as { value: [number, number] }[]
          if (!ps.length) return ''
          const t = ps[0].value[0]
          const lines: string[] = []
          for (const it of order) {
            const ser = series.current?.get(it.sensor.id)
            if (!ser || !ser.len) continue
            const i = nearestIndex(ser, t)
            // Skip series with no reading near this instant (more than two typical gaps away).
            const gap = ser.len > 1 ? (ser.lastTs() - ser.ts(0)) / (ser.len - 1) : Infinity
            if (Math.abs(ser.ts(i) - t) > 2 * gap) continue
            lines.push(`<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${slotColor(it.slot)};margin-right:6px"></span>${seriesName(it.sensor)}: <b>${ser.value(i).toFixed(1)} ${it.sensor.unit}</b>`)
          }
          return `${fmtTime(t)}<br/>${lines.join('<br/>')}`
        },
      },
      grid: panels.map((_, i) => gridFor(i)),
      xAxis: panels.map((_, i) => ({
        type: 'time', gridIndex: i,
        axisLine: { lineStyle: { color: axis } }, axisTick: { show: i === panels.length - 1 },
        axisLabel: { show: i === panels.length - 1, color: muted, hideOverlap: true },
        splitLine: { show: false },
      })),
      yAxis: panels.map((_, i) => ({
        type: 'value', gridIndex: i, scale: true,
        axisLabel: { color: muted, hideOverlap: true }, splitLine: { lineStyle: { color: grid } }, splitNumber: compact ? 2 : 3,
      })),
      dataZoom: [
        { id: 'zoom-inside', type: 'inside', xAxisIndex: panels.map((_, i) => i), filterMode: 'filter' },
        ...(compact ? [] : [{
          id: 'zoom-slider', type: 'slider', xAxisIndex: panels.map((_, i) => i), bottom: 8, height: 22, left: 56, right: 16,
          borderColor: axis, fillerColor: 'rgba(42,120,214,0.12)', handleStyle: { color: surface, borderColor: muted },
          textStyle: { color: muted }, dataBackground: { lineStyle: { color: axis }, areaStyle: { color: grid } },
        }]),
      ],
      series: panels.flatMap((p, gi) => p.items.map((it) => ({
        name: seriesName(it.sensor), type: 'line', xAxisIndex: gi, yAxisIndex: gi,
        showSymbol: false, symbol: 'none',
        lineStyle: { width: 1.5, color: slotColor(it.slot) }, itemStyle: { color: slotColor(it.slot) },
        sampling: 'lttb', large: true, largeThreshold: 20_000,
        // Flat typed array of (ts, value) pairs; `dimensions` tells ECharts the stride.
        dimensions: ['ts', 'value'],
        encode: { x: 'ts', y: 'value' },
        data: seriesData(it.sensor.id),
      }))),
    }
  }

  // Latest builder for the resize observer, which is registered once.
  const buildRef = useRef(buildOption)
  buildRef.current = buildOption

  // Create once; rebuild the whole option when the panel structure or theme changes.
  useEffect(() => {
    if (!el.current) return
    // Each widget is independent: no ECharts group, so hover and zoom stay within the widget.
    if (!chart.current) chart.current = echarts.init(el.current, undefined, { renderer: 'canvas' })
    chart.current.setOption(buildOption(), { notMerge: true })
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onTheme = () => chart.current?.setOption(buildOption(), { notMerge: true })
    mq.addEventListener('change', onTheme)
    return () => mq.removeEventListener('change', onTheme)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey])

  // Resize with the widget; the layout is in pixels, so re-run the option on every size change.
  useEffect(() => {
    if (!el.current) return
    let lastH = el.current.clientHeight
    const ro = new ResizeObserver(() => {
      const c = chart.current
      if (!c || !el.current) return
      c.resize()
      if (el.current.clientHeight !== lastH) { lastH = el.current.clientHeight; c.setOption(buildRef.current(), { notMerge: true }) }
    })
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
    c.setOption({ series: order.map((it) => ({ data: seriesData(it.sensor.id) })) }, { lazyUpdate: true })
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
