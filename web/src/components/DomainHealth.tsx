import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import { get } from '../api'
import { useInterval, useLoad, useMeta } from '../hooks'
import type { Domain, RepResult } from '../types'
import { fmtAgo, fmtDateTime, fmtInt } from '../format'
import { t, tn, ts } from '../i18n'
import { Badge, ErrorBox, Skeleton } from './ui'
import type { Tone } from './ui'

/**
 * What a domain is like right now, in one word. The worst news wins: a domain
 * that is both unreachable and on a blocklist is "flagged".
 */
export type Health = 'ok' | 'flagged' | 'error' | 'pending' | 'off'

export const HEALTH: { key: Health; label: string; tone: Tone; help: string }[] = [
  { key: 'ok', label: t('Healthy'), tone: 'ok', help: t('Reachable and on no blocklist.') },
  { key: 'flagged', label: t('Flagged'), tone: 'err', help: t('On at least one blocklist.') },
  { key: 'error', label: t('Unreachable'), tone: 'warn', help: t('The connection check failed.') },
  { key: 'pending', label: t('Pending@@domain'), tone: 'info', help: t('Waiting for the connection check or the certificate.') },
  { key: 'off', label: t('Switched off'), tone: 'neutral', help: t('Disabled domains answer nothing and are not checked.') },
]
const HEALTH_BY_KEY = Object.fromEntries(HEALTH.map((h) => [h.key, h])) as Record<Health, (typeof HEALTH)[number]>

export function domainHealth(d: Domain): Health {
  if (!d.enabled) return 'off'
  if (d.rep_status === 'listed') return 'flagged'
  if (d.status === 'error') return 'error'
  if (d.status === 'pending') return 'pending'
  return 'ok'
}

export function healthCounts(domains: Domain[]): Record<Health, number> {
  const n: Record<Health, number> = { ok: 0, flagged: 0, error: 0, pending: 0, off: 0 }
  for (const d of domains) n[domainHealth(d)]++
  return n
}

/** Short and full names of the blocklist providers, by id. */
export function useProviderNames() {
  const defs = useMeta().reputation_providers
  return useMemo(() => {
    const by = new Map((defs ?? []).map((d) => [d.id, d]))
    return { short: (id: string) => by.get(id)?.short ?? id, full: (id: string) => by.get(id)?.name ?? id }
  }, [defs])
}

const REP_LABEL: Record<string, string> = { clean: t('not listed'), listed: t('listed'), error: t('no answer') }
const repLine = (r: RepResult, name: string) => `${name}: ${r.detail ? ts(r.detail) : (REP_LABEL[r.status] ?? r.status)}`

/** The filter strip of the Domains page: one tile per state, with its count. */
export function HealthTiles({ domains, value, onChange }: { domains: Domain[]; value: Health | ''; onChange: (v: Health | '') => void }) {
  const counts = useMemo(() => healthCounts(domains), [domains])
  return (
    <div className="health-tiles" role="radiogroup" aria-label={t('Filter by state')}>
      <button role="radio" aria-checked={value === ''} className={'health-tile' + (value === '' ? ' active' : '')} onClick={() => onChange('')}>
        <span className="health-tile-label">{t('All domains')}</span>
        <b>{fmtInt(domains.length)}</b>
      </button>
      {HEALTH.map((h) => (
        <button key={h.key} role="radio" aria-checked={value === h.key} title={h.help} className={`health-tile ht-${h.tone}` + (value === h.key ? ' active' : '') + (counts[h.key] ? '' : ' zero')} onClick={() => onChange(value === h.key ? '' : h.key)}>
          <span className="health-tile-label">
            <i className="health-dot" />
            {h.label}
          </span>
          <b>{fmtInt(counts[h.key])}</b>
        </button>
      ))}
    </div>
  )
}

/** Every provider's answer about a domain, as chips; a chip opens the provider's own page where there is one. */
export function RepChips({ d, active }: { d: Domain; active: boolean }) {
  const names = useProviderNames()
  const results = d.reputation ?? []
  if (!results.length) return <span className="muted small">{!active ? t('Blocklist checks are off') : d.enabled ? t('Not checked yet') : '—'}</span>
  return (
    <span className="rep-chips">
      {results.map((r) => {
        const title = repLine(r, names.full(r.provider)) + '\n' + t('Checked {time}', { time: fmtDateTime(r.checked_at) })
        const body = (
          <>
            <i className="health-dot" />
            {names.short(r.provider)}
          </>
        )
        return r.url ? (
          <a key={r.provider} className={'rep-chip ' + r.status} title={title} href={r.url} target="_blank" rel="noreferrer noopener">
            {body}
          </a>
        ) : (
          <span key={r.provider} className={'rep-chip ' + r.status} title={title}>
            {body}
          </span>
        )
      })}
    </span>
  )
}

/** The reputation of a domain in one badge, for a table cell. */
export function RepBadge({ d, active }: { d: Domain; active: boolean }) {
  const names = useProviderNames()
  const results = d.reputation ?? []
  if (!results.length) return <span className="muted">{active && d.enabled ? t('Not checked yet') : '—'}</span>
  const title = results.map((r) => repLine(r, names.full(r.provider))).join('\n') + '\n' + t('Checked {time}', { time: fmtDateTime(d.rep_checked_at) })
  const listed = results.filter((r) => r.status === 'listed')
  const answered = results.filter((r) => r.status !== 'error').length
  return (
    <span title={title} className="rep-badge">
      {listed.length > 0 ? (
        <Badge tone="err">
          <ShieldAlert size={12} /> <span className="ellipsis">{listed.map((r) => names.short(r.provider)).join(', ')}</span>
        </Badge>
      ) : answered > 0 ? (
        <Badge tone="ok">
          <ShieldCheck size={12} /> {t('Clean')}
        </Badge>
      ) : (
        <Badge tone="warn">
          <ShieldQuestion size={12} /> {t('No answer')}
        </Badge>
      )}
      <span className="muted small">{t('{answered} of {total}', { answered: listed.length > 0 ? listed.length : answered, total: results.length })}</span>
    </span>
  )
}

/** What is wrong with a domain, in a line. */
function problemText(d: Domain, short: (id: string) => string): string {
  if (d.rep_status === 'listed')
    return (d.reputation ?? [])
      .filter((r) => r.status === 'listed')
      .map((r) => short(r.provider))
      .join(', ')
  if (d.status === 'error') return ts(d.status_msg) || t('The connection check failed.')
  return ts(d.status_msg) || t('Waiting for the check to finish.')
}

/** A dashboard widget: how the viewer's domains are doing, and which need attention. */
export function DomainsWidget({ tick, tall }: { tick: number; tall: boolean }) {
  const list = useLoad(() => get<Domain[]>('domains'), [tick])
  const names = useProviderNames()
  const domains = useMemo(() => list.data ?? [], [list.data])
  useInterval(() => list.reload(), 60000, true)
  const counts = useMemo(() => healthCounts(domains), [domains])
  const problems = useMemo(() => {
    const rank: Record<Health, number> = { flagged: 0, error: 1, pending: 2, ok: 3, off: 4 }
    return domains
      .map((d) => ({ d, h: domainHealth(d) }))
      .filter((x) => x.h === 'flagged' || x.h === 'error' || x.h === 'pending')
      .sort((a, b) => rank[a.h] - rank[b.h] || a.d.name.localeCompare(b.d.name))
  }, [domains])

  if (list.error) return <ErrorBox error={list.error} retry={list.reload} />
  if (!list.data) return <Skeleton rows={4} />
  if (!domains.length)
    return (
      <div className="muted pad-s">
        {t('No domains yet.')} <Link to="/domains">{t('Add domains')}</Link>
      </div>
    )
  // A widget of a set height scrolls, so it can list more than fits at a glance.
  const shown = problems.slice(0, tall ? 100 : 5)
  const lastRep = domains.reduce((m, d) => (d.rep_checked_at && d.rep_checked_at > m ? d.rep_checked_at : m), '')
  return (
    <div className="wdomains">
      <div className="health-bar" role="img" aria-label={HEALTH.map((h) => `${h.label}: ${counts[h.key]}`).join(', ')}>
        {HEALTH.filter((h) => counts[h.key] > 0).map((h) => (
          <i key={h.key} className={'ht-' + h.tone} style={{ flexGrow: counts[h.key] }} title={`${h.label}: ${counts[h.key]}`} />
        ))}
      </div>
      <div className="health-legend">
        {HEALTH.filter((h) => counts[h.key] > 0 || h.key === 'ok').map((h) => (
          <Link key={h.key} to={'/domains?show=' + h.key} className={'ht-' + h.tone} title={h.help}>
            <i className="health-dot" />
            <b>{fmtInt(counts[h.key])}</b> {h.label}
          </Link>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className="wdomains-fine">
          <ShieldCheck size={15} /> {tn(domains.length - counts.off, '{n} domain is fine', 'All {n} domains are fine')}
        </div>
      ) : (
        <div className="wdomains-list">
          {shown.map(({ d, h }) => (
            <Link key={d.id} to={'/domains?show=' + h} className="wdomains-row" title={problemText(d, names.full)}>
              <Badge tone={HEALTH_BY_KEY[h].tone}>{HEALTH_BY_KEY[h].label}</Badge>
              <span className="strong ellipsis">{d.name}</span>
              <span className="muted small ellipsis">{problemText(d, names.short)}</span>
            </Link>
          ))}
          {problems.length > shown.length && (
            <Link to="/domains" className="muted small">
              {tn(problems.length - shown.length, '+{n} more@@domains', '+{n} more@@domains')}
            </Link>
          )}
        </div>
      )}
      {lastRep && <div className="muted small">{t('Blocklists checked {ago}', { ago: fmtAgo(lastRep) })}</div>}
    </div>
  )
}
