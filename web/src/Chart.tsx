import { useEffect, useMemo, useRef, type RefObject } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { DataZoomComponent, GridComponent, LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { Sensor } from './api'
import type { SeriesMap } from './useReadings'

echarts.use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, TitleComponent, LegendComponent, CanvasRenderer])

/** Fixed slot order; a sensor keeps its slot for as long as it is selected. */
export const SLOT_COUNT = 8

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
    const n = Math.max(panels.length, 1)
    const legendH = order.length > 1 ? 7 : 0        // % of height reserved for the legend row
    const top = 4 + legendH, bottom = 12             // % reserved above (titles/legend) and below (zoom slider)
    const span = (100 - top - bottom) / n
    const gridFor = (i: number) => ({ top: `${top + i * span + 4}%`, height: `${span - 8}%`, left: 64, right: 24 })

    return {
      animation: false,
      backgroundColor: 'transparent',
      textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
      legend: {
        show: order.length > 1, top: 6, left: 64, right: 24, type: 'scroll',
        icon: 'roundRect', itemWidth: 14, itemHeight: 4,
        textStyle: { color: ink2, fontSize: 12 },
        data: order.map((it) => seriesName(it.sensor)),
      },
      title: panels.map((p, i) => ({
        text: p.title, left: 64, top: `${top + i * span - 0.5}%`,
        textStyle: { fontSize: 13, fontWeight: 600, color: ink2 },
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
      xAxis: panels.map((_, i) => ({
        type: 'time', gridIndex: i,
        axisLine: { lineStyle: { color: axis } }, axisTick: { show: i === panels.length - 1 },
        axisLabel: { show: i === panels.length - 1, color: muted, hideOverlap: true },
        splitLine: { show: false },
      })),
      yAxis: panels.map((_, i) => ({
        type: 'value', gridIndex: i, scale: true,
        axisLabel: { color: muted }, splitLine: { lineStyle: { color: grid } }, splitNumber: 3,
      })),
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
        lineStyle: { width: 1.5, color: slotColor(it.slot) }, itemStyle: { color: slotColor(it.slot) },
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
    const ro = new ResizeObserver(() => chart.current?.resize())
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
