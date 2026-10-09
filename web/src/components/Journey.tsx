import { Link } from 'react-router-dom'
import { get } from '../api'
import { useLoad } from '../hooks'
import type { ClickEvent, ConvRow, Stage } from '../types'
import { fmtDateTime, fmtMoney, fmtSpan, num, secondsBetween } from '../format'
import { t, ts } from '../i18n'
import { ErrorBox } from './ui'

/** The name a campaign gives an event type, or the type itself outside its funnel. */
export function stageName(stages: Stage[] | null | undefined, type: string): string {
  return stages?.find((s) => s.key === type)?.name ?? ts(type)
}

/** Funnel progress of one click in a table cell: a pip per stage, filled once reached. */
export function StagePips({ stages, events, clickTs }: { stages: Stage[]; events: ClickEvent[]; clickTs: unknown }) {
  const other = events.filter((e) => !stages.some((s) => s.key === e.type))
  if (stages.length === 0 && other.length === 0) return <span className="muted">—</span>
  const revenue = events.reduce((n, e) => n + (e.type === 'rejected' ? 0 : num(e.revenue)), 0)
  return (
    <span className="pips">
      {stages.map((s) => {
        const e = events.find((x) => x.type === s.key)
        // How the stage ended for this click: a success if it has one, else the latest outcome.
        const mine = events.filter((x) => x.type === s.key && x.outcome).map((x) => s.outcomes?.find((o) => o.key === x.outcome))
        const out = mine.find((o) => o?.kind === 'ok') ?? mine[mine.length - 1]
        const what = out ? `${s.name} · ${out.name}` : s.name
        return (
          <span
            key={s.key}
            className={'pip' + (e ? ' on' : '') + (s.goal ? ' goal' : '') + (out?.kind === 'fail' ? ' fail' : '')}
            title={e ? t('{stage}: {time} after the click', { stage: what, time: fmtSpan(secondsBetween(clickTs, e.ts) ?? 0) }) : t('{stage}: not reached', { stage: s.name })}
          />
        )
      })}
      {other.map((e, i) => (
        <span key={i} className={'pip-tag' + (e.type === 'rejected' ? ' err' : '')} title={fmtDateTime(e.ts)}>
          {ts(e.type)}
        </span>
      ))}
      {revenue > 0 && <span className="pip-rev">{fmtMoney(revenue)}</span>}
    </span>
  )
}

/**
 * Everything received for one click, oldest first, against the stages of its
 * campaign: when each event came, through which key, from where and with what.
 */
export function Journey({
  clickId,
  clickTs,
  campaignId,
  stages,
  currency,
  keyName,
  current,
}: {
  clickId: string
  clickTs: unknown
  campaignId: number
  stages: Stage[]
  currency?: string
  keyName?: (id: unknown) => string
  /** The event being inspected, to mark it in the list. */
  current?: string
}) {
  const res = useLoad(() => get<{ rows: ConvRow[] | null }>('conversions', { click_id: clickId, campaign_id: campaignId || '', limit: 500 }), [clickId, campaignId])
  const events = [...(res.data?.rows ?? [])].reverse()
  const missing = stages.filter((s) => !events.some((e) => e.type === s.key))
  const seen = new Set<string>()

  return (
    <div className="journey">
      <div className="journey-head">
        <b>{t('Journey of this click')}</b>
        {res.data && <span className="muted">{events.length === 0 ? t('No events received for this click yet.') : t('Events received: {n}', { n: events.length })}</span>}
      </div>
      <ErrorBox error={res.error} retry={res.reload} />
      <ol className="journey-list">
        <li className="journey-step on">
          <span className="journey-dot" />
          <span className="journey-name">{t('Click')}</span>
          <span className="journey-when nowrap">{fmtDateTime(clickTs)}</span>
          <span className="journey-meta mono">{clickId}</span>
        </li>
        {res.loading && !res.data && (
          <li className="journey-step">
            <span className="journey-dot" />
            <span className="muted">{t('Loading…')}</span>
          </li>
        )}
        {events.map((e, i) => {
          const type = String(e.type)
          const stage = stages.find((s) => s.key === type)
          const outcome = stage?.outcomes?.find((o) => o.key === e.outcome)
          const repeat = seen.has(type + '|' + String(e.outcome ?? ''))
          seen.add(type + '|' + String(e.outcome ?? ''))
          const after = secondsBetween(clickTs, e.ts)
          const step = i > 0 ? secondsBetween(events[i - 1].ts, e.ts) : null
          const params = Object.entries(e.params ?? {})
          return (
            <li key={String(e.conv_id ?? i)} className={'journey-step on' + (type === 'rejected' || outcome?.kind === 'fail' ? ' err' : '') + (current && e.conv_id === current ? ' current' : '')}>
              <span className="journey-dot" />
              <span className="journey-name">
                {stage ? stage.name : ts(type)}
                {stage?.goal && ' ★'}
                {stage && <span className="muted mono small"> {type}</span>}
                {!!e.outcome && <span className={'pip-tag' + (outcome?.kind === 'fail' ? ' err' : outcome?.kind === 'ok' ? ' ok' : '')}>{outcome?.name ?? String(e.outcome)}</span>}
                {!stage && stages.length > 0 && type !== 'rejected' && <span className="pip-tag">{t('not a stage of this funnel')}</span>}
                {repeat && <span className="pip-tag">{t('repeat')}</span>}
              </span>
              <span className="journey-when nowrap">
                {after !== null ? t('+{time} after the click', { time: fmtSpan(after) }) : fmtDateTime(e.ts)}
                {step !== null && <span className="muted"> · {t('+{time} after the previous event', { time: fmtSpan(step) })}</span>}
              </span>
              <span className="journey-meta">
                <span className="nowrap">{fmtDateTime(e.ts)}</span>
                {num(e.revenue) !== 0 && <b>{fmtMoney(e.revenue, String(e.currency || currency || ''))}</b>}
                {num(e.key_id) > 0 && (
                  <span>
                    <span className="muted">{t('key')}</span> {keyName ? keyName(e.key_id) : `#${e.key_id}`}
                  </span>
                )}
                {!!e.sender_ip && (
                  <span>
                    <span className="muted">{t('from')}</span> <span className="mono">{String(e.sender_ip)}</span>
                  </span>
                )}
                <Link className="link mono small" to={'/conversions?' + new URLSearchParams({ click_id: clickId }).toString()} title={t('Conversion ID')}>
                  {String(e.conv_id)}
                </Link>
              </span>
              {params.length > 0 && (
                <span className="journey-params">
                  {params.map(([k, v]) => (
                    <span className="chip" key={k}>
                      <span className="muted">{k}</span> = {v}
                    </span>
                  ))}
                </span>
              )}
            </li>
          )
        })}
        {res.data &&
          missing.map((s) => (
            <li key={s.key} className="journey-step">
              <span className="journey-dot" />
              <span className="journey-name muted">
                {s.name}
                {s.goal && ' ★'}
              </span>
              <span className="journey-when muted">{t('not reached')}</span>
            </li>
          ))}
      </ol>
    </div>
  )
}
