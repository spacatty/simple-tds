// Filter state shared by the reports and the logs. It lives in the URL query
// so links are shareable and Back works:
//   ?group=country&range=7d&campaign_id=3&f.country=DE&f.country=FR&like.referer=shop&bots=exclude
// A repeated f.<dimension> lists alternatives; like.<field> is "contains".
import type { Params } from './api'
import { presetRange } from './components/DateRangePicker'
import type { DateRange } from './components/DateRangePicker'
import { countryName } from './countries'
import { browserTZ, humanize } from './format'
import { t, ts } from './i18n'

export const DIM_LABELS: Record<string, string> = {
  total: t('Total'),
  day: t('Day'),
  hour: t('Hour'),
  campaign: t('Campaign'),
  stream: t('Stream'),
  landing: t('Landing'),
  landing_preset: t('Landing preset'),
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
  referer: t('Referrer'),
  ua: 'User-Agent',
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
  /** Dimension name: campaign | stream | key | any f.<dim>, or the field of a like.<field>. */
  dim: string
  /** Several values of one dimension are alternatives. */
  values: string[]
  /** The URL parameter that carries it. */
  param: string
  /** A "contains" filter rather than exact values. */
  like?: boolean
}

export interface FilterState {
  crumbs: Crumb[]
  bots: string
}

/** Filters that are a plain URL parameter with one value. */
export const PLAIN_PARAMS = ['ip', 'click_id', 'unique', 'dc', 'banned']

/** Reads the dimension filters in the order they appear in the URL. */
export function parseFilters(sp: URLSearchParams): FilterState {
  const crumbs: Crumb[] = []
  const seen = new Set<string>()
  sp.forEach((value, key) => {
    if (seen.has(key)) return
    if (key === 'campaign_id' || key === 'stream_id' || key === 'key_id') {
      if (value && value !== '0') crumbs.push({ dim: key.slice(0, -3), values: [value], param: key })
    } else if (key.startsWith('f.') && key.length > 2) {
      seen.add(key)
      crumbs.push({ dim: key.slice(2), values: sp.getAll(key), param: key })
    } else if (key.startsWith('like.') && key.length > 5 && value.trim()) {
      crumbs.push({ dim: key.slice(5), values: [value], param: key, like: true })
    }
  })
  const bots = sp.get('bots') ?? ''
  return { crumbs, bots: bots === 'only' || bots === 'exclude' ? bots : '' }
}

/** API query parameters for a filter state. Empty f.<dim> values are real filters and are kept by qs(). */
export function filterParams(f: FilterState): Params {
  const p: Params = {}
  for (const c of f.crumbs) p[c.param] = c.values
  if (f.bots) p.bots = f.bots
  return p
}

/** Every filter the URL carries, as API query parameters: what a page sends with its request. */
export function urlFilterParams(sp: URLSearchParams): Params {
  const p = filterParams(parseFilters(sp))
  for (const k of PLAIN_PARAMS) if (sp.get(k)) p[k] = sp.get(k)
  sp.forEach((value, key) => {
    if (key.startsWith('p.') && key.length > 2 && value !== '') p[key] = value
  })
  return p
}

/** The URL parameter that filters by one value of a dimension, or null when it cannot be filtered. */
export function paramFor(dim: string, filterable: string[]): string | null {
  if (ID_PARAMS[dim]) return ID_PARAMS[dim]
  return filterable.includes(dim) ? 'f.' + dim : null
}

/** How one value of a dimension reads; ids are resolved by the page, which knows the names. */
export function valueText(dim: string, v: string): string {
  if (dim === 'country') return v ? `${countryName(v)} (${v})` : t('(unknown)')
  if (v === '') return dim === 'ref_domain' ? t('(direct / no referrer)') : t('(empty)')
  if (dim === 'device_type') return humanize(v)
  if (dim === 'action' || dim === 'type') return ts(v)
  return v
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
export function buildSearch(opts: { range?: DateRange; group?: string; filters?: Record<string, string | number | boolean | string[] | undefined | null>; bots?: string; extra?: Record<string, string> }): string {
  const sp = new URLSearchParams()
  if (opts.group) sp.set('group', opts.group)
  if (opts.range) writeRange(sp, opts.range)
  for (const [k, v] of Object.entries(opts.filters ?? {})) {
    if (v === undefined || v === null) continue
    sp.delete(k)
    for (const one of Array.isArray(v) ? v : [v]) sp.append(k, String(one))
  }
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
