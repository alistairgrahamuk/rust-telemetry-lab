import { useCallback, useMemo, useState, type RefObject } from 'react'
import type { Sensor } from './api'
import Chart, { SLOT_COUNT, type Selected } from './Chart'
import type { SeriesMap } from './series'
import SensorPicker from './SensorPicker'
import type { Widget as WidgetConfig } from './dashboard'

interface Props {
  widget: WidgetConfig
  sensors: Sensor[]
  byId: Map<number, Sensor>
  series: RefObject<SeriesMap>
  version: number
  streaming: boolean
  /** Functional update so rapid successive edits never clobber each other. */
  onChange: (fn: (w: WidgetConfig) => WidgetConfig) => void
  onRemove: () => void
}

/** Default title: just the count; the legend already says which sensors they are. */
export function autoTitle(selected: Selected[]): string {
  if (!selected.length) return 'Empty widget'
  return `${selected.length} sensor${selected.length === 1 ? '' : 's'}`
}

/** One dashboard card: a header (drag handle, title, sensor picker, remove) over a chart. */
export default function Widget({ widget, sensors, byId, series, version, streaming, onChange, onRemove }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const closePicker = useCallback(() => setPickerOpen(false), [])

  const slots = useMemo(() => new Map(widget.sensors.map((s) => [s.id, s.slot])), [widget.sensors])
  const selected = useMemo<Selected[]>(
    () => widget.sensors.map((s) => ({ sensor: byId.get(s.id)!, slot: s.slot })).filter((x) => x.sensor),
    [widget.sensors, byId],
  )

  const toggle = (id: number) => onChange((w) => {
    if (w.sensors.some((s) => s.id === id)) return { ...w, sensors: w.sensors.filter((s) => s.id !== id) }
    if (w.sensors.length >= SLOT_COUNT) return w
    const used = new Set(w.sensors.map((s) => s.slot))
    let slot = 0
    while (used.has(slot)) slot++
    return { ...w, sensors: [...w.sensors, { id, slot }] }
  })

  const title = widget.title.trim() || autoTitle(selected)

  return (
    <div className="widget">
      <div className="widget-head">
        <span className="widget-title" title={title}>{title}</span>
        <span className="widget-tools no-drag">
          <div className="picker">
            <button aria-haspopup="dialog" aria-expanded={pickerOpen} onClick={() => setPickerOpen((o) => !o)}>
              Sensors ({widget.sensors.length}/{SLOT_COUNT}) ▾
            </button>
            {pickerOpen && (
              <SensorPicker sensors={sensors} selected={slots} limit={SLOT_COUNT} onToggle={toggle} onClose={closePicker}
                header={
                  <label className="field title-field">
                    <span>Title</span>
                    <input type="text" placeholder={autoTitle(selected)} value={widget.title}
                      onChange={(e) => { const title = e.target.value; onChange((w) => ({ ...w, title })) }} />
                  </label>
                } />
            )}
          </div>
          <button className="icon" aria-label="Remove widget" title="Remove widget" onClick={onRemove}>×</button>
        </span>
      </div>
      <div className="widget-body">
        {selected.length
          ? <Chart series={series} version={version} selected={selected} streaming={streaming} />
          : <button className="empty-cta no-drag" onClick={() => setPickerOpen(true)}>Add sensors…</button>}
      </div>
    </div>
  )
}
