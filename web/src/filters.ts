// Drill-down filter state shared by Reports, Clicks and the stream stats
// drawer. It lives in the URL query so links are shareable and Back works:
//   ?group=country&range=7d&campaign_id=3&stream_id=9&f.country=DE&bots=exclude
import type { Params } from './api'
import { presetRange } from './components/DateRangePicker'
import type { DateRange } from './components/DateRangePicker'
import { browserTZ, humanize } from './format'
import { t } from './i18n'

export const DIM_LABELS: Record<string, string> = {
  total: t('Total'),
  day: t('Day'),
  hour: t('Hour'),
  campaign: t('Campaign'),
  stream: t('Stream'),
  domain: t('Domain'),
  country: t('Country'),
  region: t('Region'),
  city: t('City'),
  isp: t('ISP'),
  device_type: t('Device type'),
  os: t('OS'),
  browser: t('Browser'),
  lang: t('Language'),
  ref_domain: t('Referrer domain'),
  keyword: t('Keyword'),
  action: t('Action'),
  bot_reason: t('Bot reason'),
  key: t('Conversion key'),
  type: t('Conversion type'),
}
export const dimLabel = (d: string) => DIM_LABELS[d] ?? humanize(d)

/** Groupings that only exist for clicks / only for conversions. */
export const CLICK_ONLY = ['action', 'bot_reason']
export const CONV_ONLY = ['key', 'type']

const ID_PARAMS: Record<string, string> = { campaign: 'campaign_id', stream: 'stream_id', key: 'key_id' }

export interface Crumb {
  /** Dimension name: campaign | stream | key | any f.<dim> */
  dim: string
  value: string
  /** The URL parameter that carries it. */
  param: string
}

export interface FilterState {
  crumbs: Crumb[]
  bots: string
}

/** Reads the drill-down filters in the order they appear in the URL. */
export function parseFilters(sp: URLSearchParams): FilterState {
  const crumbs: Crumb[] = []
  sp.forEach((value, key) => {
    if (key === 'campaign_id' || key === 'stream_id' || key === 'key_id') {
      if (value && value !== '0') crumbs.push({ dim: key.slice(0, -3), value, param: key })
    } else if (key.startsWith('f.') && key.length > 2) {
      crumbs.push({ dim: key.slice(2), value, param: key })
    }
  })
  const bots = sp.get('bots') ?? ''
  return { crumbs, bots: bots === 'only' || bots === 'exclude' ? bots : '' }
}

/** API query parameters for a filter state. Empty f.<dim> values are real filters and are kept by qs(). */
export function filterParams(f: FilterState): Params {
  const p: Params = {}
  for (const c of f.crumbs) p[c.param] = c.value
  if (f.bots) p.bots = f.bots
  return p
}

/** The URL parameter that filters by one value of a dimension, or null when it cannot be filtered. */
export function paramFor(dim: string, filterable: string[]): string | null {
  if (ID_PARAMS[dim]) return ID_PARAMS[dim]
  return filterable.includes(dim) ? 'f.' + dim : null
}

export function crumbValue(f: FilterState, dim: string): string | undefined {
  return f.crumbs.find((c) => c.dim === dim)?.value
}

// ---- date range in the URL ----------------------------------------------------

export function rangeFromSearch(sp: URLSearchParams, fallback: DateRange): DateRange {
  const preset = sp.get('range')
  if (preset && preset !== 'custom') return presetRange(preset)
  const from = Number(sp.get('from'))
  const to = Number(sp.get('to'))
  if (from > 0 && to > from) return { preset: 'custom', from, to }
  return fallback
}

export function writeRange(sp: URLSearchParams, r: DateRange) {
  sp.delete('range')
  sp.delete('from')
  sp.delete('to')
  if (r.preset === 'custom') {
    sp.set('from', String(r.from))
    sp.set('to', String(r.to))
  } else {
    sp.set('range', r.preset)
  }
}

export function rangeApiParams(r: DateRange): Params {
  return { from: r.from, to: r.to, tz: browserTZ }
}

/** Builds "?…" for a link into Reports or Clicks. */
export function buildSearch(opts: { range?: DateRange; group?: string; filters?: Record<string, string | number | undefined | null>; bots?: string; extra?: Record<string, string> }): string {
  const sp = new URLSearchParams()
  if (opts.group) sp.set('group', opts.group)
  if (opts.range) writeRange(sp, opts.range)
  for (const [k, v] of Object.entries(opts.filters ?? {})) if (v !== undefined && v !== null) sp.set(k, String(v))
  if (opts.bots) sp.set('bots', opts.bots)
  for (const [k, v] of Object.entries(opts.extra ?? {})) sp.set(k, v)
  const s = sp.toString()
  return s ? '?' + s : ''
}

/** Local-time bounds of a "YYYY-MM-DD" or "YYYY-MM-DD HH:00" report key, as a custom range. */
export function bucketRange(key: string): DateRange | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):00)?$/.exec(key)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  if (m[4] !== undefined) {
    const from = new Date(y, mo, d, Number(m[4]))
    return { preset: 'custom', from: Math.floor(from.getTime() / 1000), to: Math.floor(from.getTime() / 1000) + 3600 }
  }
  const from = new Date(y, mo, d)
  const to = new Date(y, mo, d + 1)
  return { preset: 'custom', from: Math.floor(from.getTime() / 1000), to: Math.floor(to.getTime() / 1000) }
}
