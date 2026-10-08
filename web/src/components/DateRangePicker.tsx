import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { ymd, ymdh } from '../format'
import { locale, t } from '../i18n'
import { useOutside } from './ui'

/** from/to are unix seconds; `to` is exclusive. */
export interface DateRange {
  preset: string
  from: number
  to: number
}

const PRESETS: { id: string; label: string }[] = [
  { id: 'today', label: t('Today') },
  { id: 'yesterday', label: t('Yesterday') },
  { id: '7d', label: t('Last 7 days') },
  { id: '30d', label: t('Last 30 days') },
  { id: 'month', label: t('This month') },
  { id: 'lastmonth', label: t('Last month') },
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
    case 'lastmonth':
      return { preset, from: sec(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: sec(new Date(today.getFullYear(), today.getMonth(), 1)) }
    default:
      return { preset: 'today', from: sec(today), to: sec(tomorrow) }
  }
}

// The chosen range follows the user from page to page.
let remembered: DateRange | null = null

export function rememberRange(r: DateRange) {
  remembered = r
}

/** The range last chosen anywhere in the panel (presets recomputed for today). */
export function currentRange(initial = 'today'): DateRange {
  if (!remembered) return presetRange(initial)
  return remembered.preset === 'custom' ? remembered : presetRange(remembered.preset)
}

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
  // A page left open past midnight: move presets on, or "Today" keeps showing yesterday.
  useEffect(() => {
    if (range.preset === 'custom') return
    const t = setInterval(() => {
      const now = presetRange(range.preset)
      if (now.from !== range.from || now.to !== range.to) set(now)
    }, 60_000)
    return () => clearInterval(t)
  }, [range, set])
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

// Month names come from Intl: on its own a month is in the nominative case, which is what a calendar heading needs.
const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long' })
const MONTHS = Array.from({ length: 12 }, (_, i) => {
  const m = monthFmt.format(new Date(2024, i, 1))
  return m.charAt(0).toUpperCase() + m.slice(1)
})
const WEEKDAYS = [t('Mo'), t('Tu'), t('We'), t('Th'), t('Fr'), t('Sa'), t('Su')]
const dayFmt = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
const dayYearFmt = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' })
const pad = (n: number) => String(n).padStart(2, '0')
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const dayLabel = (d: Date, year: boolean) => (year ? dayYearFmt : dayFmt).format(d)

/** "930", "9:30", "9" → "09:30", "09:30", "09:00"; null when it is not a time. */
function parseTime(s: string): string | null {
  const m = /^(\d{1,2})(?:[:.\s]?(\d{2}))?$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2] ?? 0)
  return h > 23 || min > 59 ? null : `${pad(h)}:${pad(min)}`
}

/** What the range covers, as local days and times. The last minute is inclusive: a whole day ends at 23:59. */
function rangeParts(r: DateRange) {
  const from = new Date(r.from * 1000)
  const last = new Date(r.to * 1000 - 60_000)
  return { start: startOfDay(from), end: startOfDay(last), fromTime: hm(from), toTime: hm(last) }
}

export function rangeLabel(r: DateRange): string {
  const preset = PRESETS.find((p) => p.id === r.preset)
  if (preset) return preset.label
  const p = rangeParts(r)
  const whole = p.fromTime === '00:00' && p.toTime === '23:59'
  const sameDay = p.start.getTime() === p.end.getTime()
  const thisYear = p.end.getFullYear() === new Date().getFullYear()
  if (whole) return sameDay ? dayLabel(p.start, !thisYear) : `${dayLabel(p.start, p.start.getFullYear() !== p.end.getFullYear())} – ${dayLabel(p.end, !thisYear)}`
  if (sameDay) return `${dayLabel(p.start, !thisYear)}, ${p.fromTime} – ${p.toTime}`
  return `${dayLabel(p.start, false)} ${p.fromTime} – ${dayLabel(p.end, !thisYear)} ${p.toTime}`
}

/** The six weeks shown for a month, Monday first. */
function monthCells(year: number, month: number): Date[] {
  const offset = (new Date(year, month, 1).getDay() + 6) % 7
  return Array.from({ length: 42 }, (_, i) => new Date(year, month, 1 - offset + i))
}

function TimeInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => {
    const t = parseTime(text)
    if (t) onChange(t)
    setText(t ?? value)
  }
  const step = (by: number) => {
    const [h, m] = (parseTime(text) ?? value).split(':').map(Number)
    const total = (((h * 60 + m + by) % 1440) + 1440) % 1440
    onChange(`${pad(Math.floor(total / 60))}:${pad(total % 60)}`)
  }
  return (
    <input
      className="input mono dr-time"
      aria-label={label}
      title={t('Time, HH:MM — ↑/↓ to step')}
      inputMode="numeric"
      maxLength={5}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault()
          step((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 60 : 15))
        }
      }}
    />
  )
}

/** One button showing the period; it opens presets, a two-month calendar and from/to times. */
export function DateRangePicker({ value, onChange }: { value: DateRange; onChange: (r: DateRange) => void }) {
  const [open, setOpen] = useState(false)
  // How far the popover is moved left so that it stays on screen.
  const [nudge, setNudge] = useState(0)
  // One month instead of two when the pane cannot fit both.
  const [narrow, setNarrow] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  useOutside(ref, () => setOpen(false), open)

  // The draft is edited freely and only applied on demand.
  const [start, setStart] = useState<Date | null>(null)
  const [end, setEnd] = useState<Date | null>(null)
  const [hover, setHover] = useState<Date | null>(null)
  const [fromTime, setFromTime] = useState('00:00')
  const [toTime, setToTime] = useState('23:59')
  // The month in the left pane.
  const [view, setView] = useState(() => new Date())

  const show = () => {
    const p = rangeParts(value)
    setStart(p.start)
    setEnd(p.end)
    setHover(null)
    setFromTime(p.fromTime)
    setToTime(p.toTime)
    setView(new Date(p.end.getFullYear(), p.end.getMonth() - 1, 1))
    setOpen(true)
  }

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      if (!ref.current || !popRef.current) return
      // The room is the scrolling pane around the picker, without its scrollbar: at a high zoom that is not much.
      let pane: HTMLElement | null = ref.current.parentElement
      while (pane && !/(auto|scroll)/.test(getComputedStyle(pane).overflowY)) pane = pane.parentElement
      const box = pane ? pane.getBoundingClientRect() : { left: 0 }
      const min = box.left + 8
      const max = (pane ? box.left + pane.clientWidth : document.documentElement.clientWidth) - 8
      const left = ref.current.getBoundingClientRect().left
      setNarrow(max - min < 600)
      const over = left + popRef.current.offsetWidth - max
      setNudge(over > 0 ? -Math.min(over, Math.max(0, left - min)) : 0)
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, narrow])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    // Capture, so an enclosing drawer does not close together with the popover.
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open])

  const pick = (d: Date) => {
    if (!start || end) {
      setStart(d)
      setEnd(null)
    } else if (d < start) {
      setEnd(start)
      setStart(d)
    } else {
      setEnd(d)
    }
  }
  const at = (day: Date, time: string) => {
    const [h, m] = time.split(':').map(Number)
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m)
  }
  const lastDay = end ?? start
  const from = start ? sec(at(start, fromTime)) : 0
  const to = lastDay ? sec(at(lastDay, toTime)) + 60 : 0
  const valid = !!start && to > from
  const apply = () => {
    if (!valid) return
    onChange({ preset: 'custom', from, to })
    setOpen(false)
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const today = useMemo(() => startOfDay(new Date()), [open])
  // While the second day is being chosen, the range follows the pointer.
  const lo = start && !end && hover ? (hover < start ? hover : start) : start
  const hi = start && !end && hover ? (hover < start ? start : hover) : end ?? start
  const shift = (by: number) => setView(new Date(view.getFullYear(), view.getMonth() + by, 1))

  const month = (offset: number) => {
    const first = new Date(view.getFullYear(), view.getMonth() + offset, 1)
    return (
      <div className="dr-month" key={offset}>
        <div className="dr-month-head">
          <button type="button" className={'icon-btn' + (offset === 0 ? '' : ' dr-nav-hidden')} aria-label={t('Previous month')} onClick={() => shift(-1)}>
            <ChevronLeft size={15} />
          </button>
          <b>
            {MONTHS[first.getMonth()]} {first.getFullYear()}
          </b>
          {/* With one month on screen (narrow layout) it carries both arrows. */}
          <button type="button" className={'icon-btn' + (offset === 1 ? '' : ' dr-nav-narrow')} aria-label={t('Next month')} onClick={() => shift(1)}>
            <ChevronRight size={15} />
          </button>
        </div>
        <div className="dr-grid">
          {WEEKDAYS.map((w, i) => (
            <span key={i} className="dr-wd">
              {w}
            </span>
          ))}
          {monthCells(first.getFullYear(), first.getMonth()).map((d) => {
            const t = d.getTime()
            if (d.getMonth() !== first.getMonth()) return <span key={t} />
            const inRange = !!lo && !!hi && t >= lo.getTime() && t <= hi.getTime()
            const isFirst = inRange && t === lo!.getTime()
            const isLast = inRange && t === hi!.getTime()
            const cls = 'dr-day' + (inRange ? ' in' : '') + (isFirst || isLast ? ' edge' : '') + (isFirst ? ' first' : '') + (isLast ? ' last' : '') + (t === today.getTime() ? ' today' : '')
            return (
              <button type="button" key={t} className={cls} onClick={() => pick(d)} onMouseEnter={() => setHover(d)}>
                {d.getDate()}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="dr" ref={ref}>
      <button type="button" className={'btn dr-trigger' + (open ? ' open' : '')} aria-expanded={open} title={t('Period')} onClick={() => (open ? setOpen(false) : show())}>
        <Calendar size={14} />
        <span>{rangeLabel(value)}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className={'popover dr-pop' + (narrow ? ' narrow' : '')} style={{ left: nudge }} ref={popRef} role="dialog" aria-label={t('Choose a period')}>
          <div className="dr-presets">
            {PRESETS.map((p) => (
              <button
                type="button"
                key={p.id}
                className={'menu-item' + (value.preset === p.id ? ' selected' : '')}
                onClick={() => {
                  onChange(presetRange(p.id))
                  setOpen(false)
                }}
              >
                {p.label}
              </button>
            ))}
            <div className={'menu-item dr-custom' + (value.preset === 'custom' ? ' selected' : '')}>{t('Custom range')}</div>
          </div>
          <div className="dr-main">
            <div className="dr-months" onMouseLeave={() => setHover(null)}>
              {month(0)}
              {month(1)}
            </div>
            <div className="dr-foot">
              <div className="dr-bounds">
                <span className="dr-bound">
                  <span className="dr-date">{start ? dayLabel(start, true) : '—'}</span>
                  <TimeInput value={fromTime} onChange={setFromTime} label={t('From time')} />
                </span>
                <span className="muted">–</span>
                <span className="dr-bound">
                  <span className="dr-date">{lastDay ? dayLabel(lastDay, true) : '—'}</span>
                  <TimeInput value={toTime} onChange={setToTime} label={t('To time')} />
                </span>
              </div>
              <span className="grow" />
              <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>
                {t('Cancel')}
              </button>
              <button type="button" className="btn small primary" disabled={!valid} title={valid ? undefined : t('The period ends before it starts')} onClick={apply}>
                {t('Apply')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
