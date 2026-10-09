import { t, ts } from './i18n'

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const moneyFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 12345 → "12,345" */
export function fmtInt(v: unknown): string {
  return intFmt.format(num(v))
}

/** 1234.5 → "1,234.50" */
export function fmtMoney(v: unknown, currency?: string): string {
  const s = moneyFmt.format(num(v))
  return currency ? `${s} ${currency}` : s
}

/** 12.345 → "12.35%" (the value is already a percentage) */
export function fmtPct(v: unknown, digits = 2): string {
  return num(v).toFixed(digits) + '%'
}

export function ratioPct(part: number, total: number, digits = 1): string {
  return total > 0 ? ((part / total) * 100).toFixed(digits) + '%' : '0%'
}

/** Compact axis ticks: 1.2K, 3.4M */
export function fmtCompact(v: unknown): string {
  const n = num(v)
  const a = Math.abs(n)
  if (a >= 1e9) return trim(n / 1e9) + 'B'
  if (a >= 1e6) return trim(n / 1e6) + 'M'
  if (a >= 1e3) return trim(n / 1e3) + 'K'
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}
function trim(n: number) {
  return n.toFixed(1).replace(/\.0$/, '')
}

export function fmtBytes(v: unknown): string {
  let n = num(v)
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return (i === 0 ? String(n) : n.toFixed(1)) + ' ' + units[i]
}

const pad = (n: number) => String(n).padStart(2, '0')

function parseDate(v: unknown): Date | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(v as string)
  if (isNaN(d.getTime()) || d.getFullYear() < 1971) return null
  return d
}

/** "2026-01-31 14:05:09" in the browser's timezone */
export function fmtDateTime(v: unknown, seconds = true): string {
  const d = parseDate(v)
  if (!d) return '—'
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` +
    (seconds ? ':' + pad(d.getSeconds()) : '')
  )
}

export function fmtAgo(v: unknown): string {
  const d = parseDate(v)
  if (!d) return t('never')
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000))
  if (s < 60) return t('{n}s ago', { n: s })
  if (s < 3600) return t('{n}m ago', { n: Math.floor(s / 60) })
  if (s < 86400) return t('{n}h ago', { n: Math.floor(s / 3600) })
  return t('{n}d ago', { n: Math.floor(s / 86400) })
}

/** A length of time in seconds: "42s", "3m 5s", "2h 14m", "5d 3h". */
export function fmtSpan(v: unknown): string {
  const s = Math.max(0, Math.round(num(v)))
  if (s < 60) return t('{s}s', { s })
  if (s < 3600) return t('{m}m {s}s', { m: Math.floor(s / 60), s: s % 60 })
  if (s < 86400) return t('{h}h {m}m', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) })
  return t('{d}d {h}h', { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600) })
}

/** Seconds between two timestamps, or null when either is missing. */
export function secondsBetween(from: unknown, to: unknown): number | null {
  const a = parseDate(from)
  const b = parseDate(to)
  return a && b ? (b.getTime() - a.getTime()) / 1000 : null
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function ymdh(d: Date): string {
  return `${ymd(d)} ${pad(d.getHours())}:00`
}

/** snake_case → "Snake case", translated when the dictionary knows the result */
export function humanize(s: string): string {
  const h = s.replace(/_/g, ' ')
  return ts(h.charAt(0).toUpperCase() + h.slice(1))
}

export function csvEscape(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  // Neutralise spreadsheet formula injection from third-party data.
  if (s && '=+-@\t\r'.includes(s[0]) && isNaN(Number(s))) s = "'" + s
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export function downloadText(filename: string, text: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const browserTZ: string = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
})()
