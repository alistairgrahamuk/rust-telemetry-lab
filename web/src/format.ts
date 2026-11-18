export const DAY = 86_400_000
const HOUR = 3_600_000, MONTH = 30.44 * DAY

/** Approximate, readable span: "~45 minutes", "~6 hours 10 minutes", "~30 days", "~1 year", "~2 years 11 months". */
export function humanSpan(ms: number): string {
  if (!(ms > 0)) return ''
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'}`
  if (ms < HOUR) return `~${unit(Math.max(1, Math.round(ms / 60_000)), 'minute')}`
  if (ms < 3 * DAY) {
    const h = Math.floor(ms / HOUR), m = Math.round((ms - h * HOUR) / 60_000)
    return `~${unit(h, 'hour')}${m ? ' ' + unit(m, 'minute') : ''}`
  }
  if (ms < 4 * MONTH) return `~${unit(Math.round(ms / DAY), 'day')}`
  const months = Math.round(ms / MONTH)
  const y = Math.floor(months / 12), m = months % 12
  return `~${[y ? unit(y, 'year') : '', m ? unit(m, 'month') : ''].filter(Boolean).join(' ')}`
}
