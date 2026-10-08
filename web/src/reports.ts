import { get } from './api'
import type { Params } from './api'
import type { DateRange } from './components/DateRangePicker'
import { browserTZ, fmtInt, fmtMoney, fmtPct } from './format'
import { t } from './i18n'
import type { ReportRow } from './types'

export function rangeParams(range: DateRange): Params {
  return { from: range.from, to: range.to, tz: browserTZ }
}

export async function loadReport(group: string, range: DateRange, extra: Params = {}): Promise<ReportRow[]> {
  const r = await get<{ rows: ReportRow[] | null }>('reports', { group, ...rangeParams(range), ...extra })
  return r.rows ?? []
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
