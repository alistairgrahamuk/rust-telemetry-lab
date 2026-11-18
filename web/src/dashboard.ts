import type { Layout, LayoutItem } from 'react-grid-layout'

/** A sensor shown on a widget, with its colour slot (stable while selected). */
export interface WidgetSensor { id: number; slot: number }

export interface Widget {
  id: string
  title: string
  sensors: WidgetSensor[]
}

export interface Dashboard {
  widgets: Widget[]
  layout: Layout
  /** Preset in days, or null for "All"; ignored while `custom` is set. */
  preset: number | null
  custom: { from: number; to: number } | null
  live: boolean
}

export const COLS = 12
export const ROW_HEIGHT = 40
export const DEFAULT_W = 6
export const DEFAULT_H = 8
export const MIN_W = 3
export const MIN_H = 4

const KEY = 'telemetry.dashboard.v1'

export const newId = () => Math.random().toString(36).slice(2, 10)

export function emptyDashboard(): Dashboard {
  return { widgets: [], layout: [], preset: 30, custom: null, live: true }
}

export function loadDashboard(): Dashboard | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const d = JSON.parse(raw) as Dashboard
    if (!Array.isArray(d.widgets) || !Array.isArray(d.layout)) return null
    return { ...emptyDashboard(), ...d }
  } catch { return null }
}

export function saveDashboard(d: Dashboard) {
  try { localStorage.setItem(KEY, JSON.stringify(d)) } catch { /* private mode etc. */ }
}

/** Grid slot for a new widget: the first free DEFAULT_W × DEFAULT_H spot, scanning rows top-down, left to right. */
export function placeNew(layout: Layout, id: string): LayoutItem {
  const overlaps = (x: number, y: number) =>
    layout.some((l) => x < l.x + l.w && x + DEFAULT_W > l.x && y < l.y + l.h && y + DEFAULT_H > l.y)
  const bottom = layout.reduce((acc, l) => Math.max(acc, l.y + l.h), 0)
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + DEFAULT_W <= COLS; x++) {
      if (!overlaps(x, y)) return { i: id, x, y, w: DEFAULT_W, h: DEFAULT_H, minW: MIN_W, minH: MIN_H }
    }
  }
  return { i: id, x: 0, y: bottom, w: DEFAULT_W, h: DEFAULT_H, minW: MIN_W, minH: MIN_H }
}

export const widgetSensorIds = (w: Widget) => w.sensors.map((s) => s.id)
