import { useEffect, useRef, type RefObject } from 'react'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { DataZoomComponent, GridComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { Reading } from './api'

echarts.use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, TitleComponent, CanvasRenderer])

type Panel = { key: 1 | 2 | 3; title: string; unit: string; cssVar: string; decimals: number }
const PANELS: Panel[] = [
  { key: 1, title: 'Temperature', unit: '°C', cssVar: '--s-temp', decimals: 1 },
  { key: 2, title: 'Humidity', unit: '%', cssVar: '--s-hum', decimals: 1 },
  { key: 3, title: 'Pressure', unit: 'hPa', cssVar: '--s-press', decimals: 1 },
]

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function fmtTime(ms: number) {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

interface Props {
  /** Shared, mutated-in-place buffer; `version` tells us when to re-read it. */
  rows: RefObject<Reading[]>
  version: number
  title: string
}

/** Three stacked single-series line panels with one shared x-axis, crosshair and zoom. */
export default function Chart({ rows, version, title }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)

  // Create once; recreate on theme change so colours are re-read.
  useEffect(() => {
    if (!el.current) return
    const build = () => {
      chart.current?.dispose()
      const c = echarts.init(el.current!, undefined, { renderer: 'canvas' })
      chart.current = c
      const ink2 = cssVar('--text-2'), muted = cssVar('--muted'), grid = cssVar('--grid'), axis = cssVar('--axis'), surface = cssVar('--surface')
      const rowsOf = (i: number) => ({ top: `${6 + i * 29}%`, height: '22%', left: 64, right: 24 })

      c.setOption({
        animation: false,
        backgroundColor: 'transparent',
        textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
        title: PANELS.map((p, i) => ({
          text: `${p.title} (${p.unit})`, left: 64, top: `${1.5 + i * 29}%`,
          textStyle: { fontSize: 13, fontWeight: 600, color: ink2 },
        })),
        axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: muted }, label: { backgroundColor: ink2 } },
        tooltip: {
          trigger: 'axis', backgroundColor: surface, borderColor: axis, textStyle: { color: cssVar('--text'), fontSize: 12 },
          formatter: (params: unknown) => {
            const ps = params as { seriesIndex: number; value: [number, number]; marker: string }[]
            if (!ps.length) return ''
            const p = PANELS[ps[0].seriesIndex]
            return `${fmtTime(ps[0].value[0])}<br/>${ps[0].marker} ${p.title}: <b>${ps[0].value[1].toFixed(p.decimals)} ${p.unit}</b>`
          },
        },
        grid: PANELS.map((_, i) => rowsOf(i)),
        xAxis: PANELS.map((_, i) => ({
          type: 'time', gridIndex: i,
          axisLine: { lineStyle: { color: axis } }, axisTick: { show: i === 2 },
          axisLabel: { show: i === 2, color: muted, hideOverlap: true },
          splitLine: { show: false },
        })),
        yAxis: PANELS.map((_, i) => ({
          type: 'value', gridIndex: i, scale: true,
          axisLabel: { color: muted }, splitLine: { lineStyle: { color: grid } },
          splitNumber: 3,
        })),
        dataZoom: [
          { type: 'inside', xAxisIndex: [0, 1, 2], filterMode: 'filter' },
          { type: 'slider', xAxisIndex: [0, 1, 2], bottom: 8, height: 22, left: 64, right: 24, borderColor: axis, fillerColor: 'rgba(42,120,214,0.12)', handleStyle: { color: surface, borderColor: muted }, textStyle: { color: muted }, dataBackground: { lineStyle: { color: axis }, areaStyle: { color: grid } } },
        ],
        series: PANELS.map((p, i) => ({
          name: p.title, type: 'line', xAxisIndex: i, yAxisIndex: i,
          showSymbol: false, symbol: 'none', lineStyle: { width: 1.5, color: cssVar(p.cssVar) }, itemStyle: { color: cssVar(p.cssVar) },
          sampling: 'lttb', large: true, largeThreshold: 20_000,
          data: [],
        })),
      })
    }
    build()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onTheme = () => { build(); pushData() }
    mq.addEventListener('change', onTheme)
    const ro = new ResizeObserver(() => chart.current?.resize())
    ro.observe(el.current)
    return () => { mq.removeEventListener('change', onTheme); ro.disconnect(); chart.current?.dispose(); chart.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-split the shared buffer into per-metric [ts, value] pairs and hand it to ECharts.
  const pushData = () => {
    const c = chart.current
    if (!c) return
    const src = rows.current ?? []
    const n = src.length
    const t = new Array<[number, number]>(n), h = new Array<[number, number]>(n), p = new Array<[number, number]>(n)
    for (let i = 0; i < n; i++) {
      const r = src[i]
      t[i] = [r[0], r[1]]; h[i] = [r[0], r[2]]; p[i] = [r[0], r[3]]
    }
    c.setOption({ series: [{ data: t }, { data: h }, { data: p }] }, { lazyUpdate: true })
  }
  useEffect(pushData, [version]) // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="chart" ref={el} role="img" aria-label={`${title}: temperature, humidity and pressure over time`} />
}
