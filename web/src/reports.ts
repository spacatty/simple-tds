import { get } from './api'
import type { Params } from './api'
import type { DateRange } from './components/DateRangePicker'
import { browserTZ, fmtInt, fmtMoney, fmtPct } from './format'
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
  const t = emptyRow('Total')
  for (const r of rows) {
    t.clicks += r.clicks
    t.uniques += r.uniques
    t.bots += r.bots
    t.conversions += r.conversions
    t.rejected += r.rejected
    t.revenue += r.revenue
    t.cost += r.cost
  }
  t.profit = t.revenue - t.cost
  const real = t.clicks - t.bots
  if (real > 0) {
    t.cr = (t.conversions / real) * 100
    t.epc = t.revenue / real
  }
  if (t.cost > 0) t.roi = (t.profit / t.cost) * 100
  return t
}

export type MetricKey = 'clicks' | 'uniques' | 'bots' | 'conversions' | 'rejected' | 'revenue' | 'cost' | 'profit' | 'cr' | 'roi' | 'epc'

export interface MetricDef {
  key: MetricKey
  label: string
  title?: string
  fmt: (v: number) => string
}

export const METRICS: MetricDef[] = [
  { key: 'clicks', label: 'Clicks', fmt: fmtInt },
  { key: 'uniques', label: 'Uniques', fmt: fmtInt },
  { key: 'bots', label: 'Bots', fmt: fmtInt },
  { key: 'conversions', label: 'Conv.', title: 'Conversions (excluding rejected)', fmt: fmtInt },
  { key: 'rejected', label: 'Rejected', fmt: fmtInt },
  { key: 'cr', label: 'CR', title: 'Conversions / non-bot clicks', fmt: (v) => fmtPct(v) },
  { key: 'revenue', label: 'Revenue', fmt: (v) => fmtMoney(v) },
  { key: 'cost', label: 'Cost', fmt: (v) => fmtMoney(v) },
  { key: 'profit', label: 'Profit', fmt: (v) => fmtMoney(v) },
  { key: 'roi', label: 'ROI', title: 'Profit / cost', fmt: (v) => fmtPct(v, 1) },
  { key: 'epc', label: 'EPC', title: 'Revenue per non-bot click', fmt: (v) => v.toFixed(4) },
]
