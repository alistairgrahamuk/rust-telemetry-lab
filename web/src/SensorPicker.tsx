import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Sensor } from './api'

const METRIC_ORDER = ['temperature', 'humidity', 'pressure']

interface DeviceRow { id: number; name: string; location: string; sensors: Sensor[] }

/** Groups the flat sensor list by device, metrics in a fixed order. */
export function groupByDevice(sensors: Sensor[]): DeviceRow[] {
  const m = new Map<number, DeviceRow>()
  for (const s of sensors) {
    let d = m.get(s.device_id)
    if (!d) { d = { id: s.device_id, name: s.device, location: s.location, sensors: [] }; m.set(s.device_id, d) }
    d.sensors.push(s)
  }
  for (const d of m.values()) d.sensors.sort((a, b) => METRIC_ORDER.indexOf(a.metric) - METRIC_ORDER.indexOf(b.metric))
  return [...m.values()]
}

interface Props {
  sensors: Sensor[]
  /** sensor id -> colour slot */
  selected: Map<number, number>
  limit: number
  onToggle: (id: number) => void
  onClose: () => void
  /** Rendered above the filter (e.g. a title field). */
  header?: ReactNode
}

/** Popover listing every device with one chip per metric. Closes on outside click or Escape. */
export default function SensorPicker({ sensors, selected, limit, onToggle, onClose, header }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onClose])

  const devices = useMemo(() => groupByDevice(sensors), [sensors])
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? devices.filter((d) => d.name.toLowerCase().includes(q) || d.location.toLowerCase().includes(q)) : devices
  }, [devices, filter])
  const atLimit = selected.size >= limit

  return (
    <div className="popover no-drag" role="dialog" aria-label="Choose sensors" ref={ref}>
      {header}
      <input className="filter" placeholder="Filter by device or location" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
      <div className="device-list">
        {visible.map((d) => (
          <div className="device-row" key={d.id}>
            <span className="device-name">{d.name}</span>
            <span className="device-loc">{d.location}</span>
            <span className="metrics">
              {d.sensors.map((s) => {
                const on = selected.has(s.id)
                return (
                  <button key={s.id} className="metric-chip" aria-pressed={on} disabled={!on && atLimit}
                    onClick={() => onToggle(s.id)} title={`${s.metric} (${s.unit})`}>
                    {on && <span className="swatch" style={{ background: `var(--series-${selected.get(s.id)! + 1})` }} />}
                    {s.metric}
                  </button>
                )
              })}
            </span>
          </div>
        ))}
        {!visible.length && <div className="empty">No devices match</div>}
      </div>
      {atLimit && <div className="hint">Up to {limit} sensors per widget.</div>}
    </div>
  )
}
