import { get } from './api'
import type { Params } from './api'
import type { DateRange } from './components/DateRangePicker'
import { browserTZ, fmtInt, fmtMoney, fmtPct } from './format'
import { t, tn } from './i18n'
import type { ReportRow } from './types'
import { confirmDialog } from './components/ui'

export function rangeParams(range: DateRange): Params {
  return { from: range.from, to: range.to, tz: browserTZ }
}

export async function loadReport(group: string, range: DateRange, extra: Params = {}): Promise<ReportRow[]> {
  const r = await get<{ rows: ReportRow[] | null }>('reports', { group, ...rangeParams(range), ...extra })
  return r.rows ?? []
}

/** Clicks of the last hour for these filters; 0 when the report cannot be had. */
export async function lastHourClicks(filters: Params): Promise<number> {
  const to = Math.floor(Date.now() / 1000)
  try {
    const rows = await loadReport('total', { preset: 'custom', from: to - 3600, to }, filters)
    return rows[0]?.clicks ?? 0
  } catch {
    return 0
  }
}

/**
 * Asks before a switch cuts off traffic that is arriving right now. A campaign or stream
 * that had no clicks in the last hour is switched off without a question.
 */
export async function confirmCutOff(kind: 'campaign' | 'stream', name: string, filters: Params): Promise<boolean> {
  const n = await lastHourClicks(filters)
  if (n === 0) return true
  return kind === 'campaign'
    ? confirmDialog({
        title: t('Pause “{name}”?', { name }),
        confirmLabel: t('Pause@@campaign action'),
        message: tn(n, '{n} click arrived in the last hour. While the campaign is paused, its link answers 404.', '{n} clicks arrived in the last hour. While the campaign is paused, its link answers 404.'),
      })
    : confirmDialog({
        title: t('Turn off “{name}”?', { name }),
        confirmLabel: t('Turn off'),
        message: tn(n, '{n} click went through this stream in the last hour. Turned off, its visitors go on to the streams below it.', '{n} clicks went through this stream in the last hour. Turned off, its visitors go on to the streams below it.'),
      })
}

export const emptyRow = (key = ''): ReportRow => ({
  key,
  clicks: 0,
  uniques: 0,
  bots: 0,
  conversions: 0,
  rejected: 0,
  revenue: 0,
  cost: 0,
  profit: 0,
  cr: 0,
  roi: 0,
  epc: 0,
  types: {},
})

/** Totals with the derived ratios recomputed the same way the server does. */
export function sumRows(rows: ReportRow[]): ReportRow {
  const sum = emptyRow(t('Total'))
  for (const r of rows) {
    sum.clicks += r.clicks
    sum.uniques += r.uniques
    sum.bots += r.bots
    sum.conversions += r.conversions
    sum.rejected += r.rejected
    sum.revenue += r.revenue
    sum.cost += r.cost
  }
  sum.profit = sum.revenue - sum.cost
  const real = sum.clicks - sum.bots
  if (real > 0) {
    sum.cr = (sum.conversions / real) * 100
    sum.epc = sum.revenue / real
  }
  if (sum.cost > 0) sum.roi = (sum.profit / sum.cost) * 100
  return sum
}

export type MetricKey = 'clicks' | 'uniques' | 'bots' | 'conversions' | 'rejected' | 'revenue' | 'cost' | 'profit' | 'cr' | 'roi' | 'epc'

export interface MetricDef {
  key: MetricKey
  label: string
  title?: string
  fmt: (v: number) => string
}

export const METRICS: MetricDef[] = [
  { key: 'clicks', label: t('Clicks'), fmt: fmtInt },
  { key: 'uniques', label: t('Uniques'), fmt: fmtInt },
  { key: 'bots', label: t('Bots'), fmt: fmtInt },
  { key: 'conversions', label: t('Conv.'), title: t('Conversions (excluding rejected)'), fmt: fmtInt },
  { key: 'rejected', label: t('Rejected'), fmt: fmtInt },
  { key: 'cr', label: t('CR'), title: t('Conversions / non-bot clicks'), fmt: (v) => fmtPct(v) },
  { key: 'revenue', label: t('Revenue'), fmt: (v) => fmtMoney(v) },
  { key: 'cost', label: t('Cost'), fmt: (v) => fmtMoney(v) },
  { key: 'profit', label: t('Profit'), fmt: (v) => fmtMoney(v) },
  { key: 'roi', label: t('ROI'), title: t('Profit / cost'), fmt: (v) => fmtPct(v, 1) },
  { key: 'epc', label: t('EPC'), title: t('Revenue per non-bot click'), fmt: (v) => v.toFixed(4) },
]
