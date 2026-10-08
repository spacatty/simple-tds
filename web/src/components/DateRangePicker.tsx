import { useCallback, useState } from 'react'
import { Calendar } from 'lucide-react'
import { ymd, ymdh } from '../format'

/** from/to are unix seconds; `to` is exclusive. */
export interface DateRange {
  preset: string
  from: number
  to: number
}

const PRESETS: { id: string; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'month', label: 'This month' },
]

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}
const sec = (d: Date) => Math.floor(d.getTime() / 1000)

export function presetRange(preset: string): DateRange {
  const today = startOfDay(new Date())
  const tomorrow = addDays(today, 1)
  switch (preset) {
    case 'yesterday':
      return { preset, from: sec(addDays(today, -1)), to: sec(today) }
    case '7d':
      return { preset, from: sec(addDays(today, -6)), to: sec(tomorrow) }
    case '30d':
      return { preset, from: sec(addDays(today, -29)), to: sec(tomorrow) }
    case 'month':
      return { preset, from: sec(new Date(today.getFullYear(), today.getMonth(), 1)), to: sec(tomorrow) }
    default:
      return { preset: 'today', from: sec(today), to: sec(tomorrow) }
  }
}

// The chosen range follows the user from page to page.
let remembered: DateRange | null = null

export function useDateRange(initial = 'today'): [DateRange, (r: DateRange) => void] {
  const [range, setRange] = useState<DateRange>(() => {
    if (!remembered) return presetRange(initial)
    // Recompute presets so "Today" opened tomorrow is still today.
    return remembered.preset === 'custom' ? remembered : presetRange(remembered.preset)
  })
  const set = useCallback((r: DateRange) => {
    remembered = r
    setRange(r)
  }, [])
  return [range, set]
}

/** Time-series granularity and the full list of bucket keys (matching the API's day/hour keys in the browser timezone). */
export function rangeBuckets(range: DateRange): { group: 'hour' | 'day'; keys: string[] } {
  const hours = (range.to - range.from) / 3600
  const group: 'hour' | 'day' = hours <= 49 ? 'hour' : 'day'
  const keys: string[] = []
  const end = Math.min(range.to * 1000, Date.now())
  if (group === 'hour') {
    const d = new Date(range.from * 1000)
    d.setMinutes(0, 0, 0)
    for (let t = d.getTime(); t < end && keys.length < 100; t += 3600_000) {
      const k = ymdh(new Date(t))
      if (keys[keys.length - 1] !== k) keys.push(k)
    }
  } else {
    let d = startOfDay(new Date(range.from * 1000))
    while (d.getTime() < end && keys.length < 800) {
      keys.push(ymd(d))
      d = addDays(d, 1)
    }
  }
  return { group, keys }
}

export function DateRangePicker({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const fromStr = ymd(new Date(value.from * 1000))
  // `to` is exclusive: show the last included day.
  const toStr = ymd(new Date(value.to * 1000 - 1000))

  const setCustom = (f: string, t: string) => {
    if (!f || !t) return
    const [fy, fm, fd] = f.split('-').map(Number)
    const [ty, tm, td] = t.split('-').map(Number)
    let from = new Date(fy, fm - 1, fd)
    let toDay = new Date(ty, tm - 1, td)
    if (isNaN(from.getTime()) || isNaN(toDay.getTime())) return
    if (toDay < from) [from, toDay] = [toDay, from]
    onChange({ preset: 'custom', from: sec(from), to: sec(addDays(toDay, 1)) })
  }

  return (
    <div className="daterange">
      <div className="segmented">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className={value.preset === p.id ? 'active' : ''} onClick={() => onChange(presetRange(p.id))}>
            {p.label}
          </button>
        ))}
      </div>
      <div className={'daterange-custom' + (value.preset === 'custom' ? ' active' : '')}>
        <Calendar size={14} />
        <input type="date" className="input" aria-label="From date" value={fromStr} max={toStr} onChange={(e) => setCustom(e.target.value, toStr)} />
        <span className="muted">–</span>
        <input type="date" className="input" aria-label="To date" value={toStr} min={fromStr} onChange={(e) => setCustom(fromStr, e.target.value)} />
      </div>
    </div>
  )
}
