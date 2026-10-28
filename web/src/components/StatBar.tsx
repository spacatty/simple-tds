import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ReportRow } from '../types'
import { fmtInt, fmtMoney, fmtPct, ratioPct } from '../format'
import { t, tn } from '../i18n'

export interface Metric {
  label: string
  value: string
  sub?: string
  /** m-clicks, m-bots, …: the colour of the dot before the label. */
  metric?: string
  /** pos / neg colours the value. */
  tone?: string
  title?: string
  /** Where the figure leads, e.g. the click log. */
  to?: string
}

/**
 * The five figures every page shows for a period, the same way everywhere: clicks, bots,
 * conversions, revenue and profit. Clicks and conversions can lead to their logs.
 */
export function periodMetrics(r: ReportRow, currency: string, links: { clicks?: string; clicksTitle?: string; conversions?: string; conversionsTitle?: string } = {}): Metric[] {
  return [
    { label: t('Clicks'), value: fmtInt(r.clicks), metric: 'm-clicks', to: links.clicks, title: links.clicksTitle, sub: tn(r.uniques, '{n} unique', '{n} unique', { n: fmtInt(r.uniques) }) },
    { label: t('Bots'), value: ratioPct(r.bots, r.clicks), metric: 'm-bots', sub: tn(r.bots, '{n} click', '{n} clicks', { n: fmtInt(r.bots) }) },
    { label: t('Conv.'), value: fmtInt(r.conversions), metric: 'm-conv', to: links.conversions, title: links.conversionsTitle, sub: `CR ${fmtPct(r.cr)}` },
    { label: t('Revenue'), value: fmtMoney(r.revenue, currency), metric: 'm-conv', sub: t('cost {value}', { value: fmtMoney(r.cost, currency) }) },
    {
      label: t('Profit'),
      value: fmtMoney(r.profit, currency),
      metric: r.profit < 0 ? 'm-loss' : 'm-conv',
      tone: r.profit > 0 ? 'pos' : r.profit < 0 ? 'neg' : '',
      sub: r.cost > 0 ? `ROI ${fmtPct(r.roi, 1)}` : t('no cost recorded'),
    },
  ]
}

/** The totals of a page for the chosen period, with the period controls at the right end. */
export function StatBar({ metrics, loading, controls, flat }: { metrics: Metric[]; loading?: boolean; controls?: ReactNode; /** No card: a strip of large figures sitting under a page header. */ flat?: boolean }) {
  return (
    <div className={'sb' + (flat ? ' flat' : '')}>
      <div className="sb-kpis">
        {metrics.map((m) => {
          const body = (
            <>
              <span className="sb-label">{m.label}</span>
              <b className={'sb-value ' + (m.tone ?? '')}>{loading ? '·' : m.value}</b>
              {m.sub && <span className="sb-sub">{m.sub}</span>}
            </>
          )
          return m.to ? (
            <Link key={m.label} to={m.to} className={'sb-kpi sb-link ' + (m.metric ?? '')} title={m.title}>
              {body}
            </Link>
          ) : (
            <div key={m.label} className={'sb-kpi ' + (m.metric ?? '')} title={m.title}>
              {body}
            </div>
          )
        })}
      </div>
      {controls && <div className="sb-ctl">{controls}</div>}
    </div>
  )
}
