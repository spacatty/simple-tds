import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

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
