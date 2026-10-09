import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { get } from '../api'
import { useInterval, useLoad, useTitle } from '../hooks'
import type { SystemInfo } from '../types'
import { ErrorBox, PageHeader, Skeleton } from '../components/ui'
import { fmtAgo, fmtInt } from '../format'
import { t, tn, ts } from '../i18n'

type Level = 'ok' | 'warn' | 'err'

/** What is wrong with the system right now, worst first; empty when all is well. */
export function systemProblems(sys: SystemInfo | undefined): { level: Level; text: string }[] {
  if (!sys?.stats || !sys.geo) return []
  const out: { level: Level; text: string }[] = []
  if (sys.health.postgres !== 'ok') out.push({ level: 'err', text: t('PostgreSQL is not answering') })
  if (sys.health.clickhouse !== 'ok') out.push({ level: 'err', text: t('ClickHouse is not answering') })
  if (sys.stats.clicks_dropped > 0) out.push({ level: 'err', text: t('{n} clicks were lost because the write queue was full', { n: fmtInt(sys.stats.clicks_dropped) }) })
  if (sys.stats.queue_len >= 10000) out.push({ level: 'warn', text: t('{n} clicks are waiting to be written', { n: fmtInt(sys.stats.queue_len) }) })
  if (!sys.geo.city.loaded) out.push({ level: 'err', text: t('The geo database is not loaded') })
  else if (!sys.geo.asn.loaded) out.push({ level: 'warn', text: t('The ASN database is not loaded') })
  return out
}

/** System → Status: the health of the databases, the click pipeline and the geo data. */
export default function Status() {
  useTitle(t('Status'))
  const sys = useLoad(() => get<SystemInfo>('system'), [])
  useInterval(() => sys.reload(), 10000, true)
  const s = sys.data
  const problems = systemProblems(s)

  const row = (label: string, level: Level, value: ReactNode, hint?: string) => (
    <div className="sts-row" key={label}>
      <span className={'dot ' + level} />
      <span className="sts-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <b>{value}</b>
    </div>
  )
  const up = (state: string | undefined) => (state === 'ok' ? 'ok' : 'err') as Level

  return (
    <div className="page">
      <PageHeader title={t('Status')} sub={t('The health of the server behind this panel. Refreshes every 10 seconds.')}>
        <button className="btn" onClick={() => sys.reload()} title={t('Refresh')} aria-label={t('Refresh')}>
          <RefreshCw size={14} className={sys.loading ? 'spin' : ''} />
        </button>
      </PageHeader>
      <ErrorBox error={sys.error} retry={sys.reload} />
      {!s || !s.stats || !s.geo ? (
        !sys.error && <Skeleton rows={8} height={18} />
      ) : (
        <>
          <div className={'sts-banner ' + (problems.length === 0 ? 'ok' : problems.some((p) => p.level === 'err') ? 'err' : 'warn')}>
            <span className="sts-pulse" />
            <div>
              <b>{problems.length === 0 ? t('All systems operational') : tn(problems.length, '{n} problem needs attention', '{n} problems need attention')}</b>
              {problems.map((p) => (
                <div key={p.text}>{p.text}</div>
              ))}
            </div>
          </div>

          <div className="sts-grid">
            <section className="card sts-card">
              <h3>{t('Databases')}</h3>
              {row('PostgreSQL', up(s.health.postgres), s.health.postgres === 'ok' ? 'OK' : ts(s.health.postgres), t('Campaigns, streams, domains and settings'))}
              {row('ClickHouse', up(s.health.clickhouse), s.health.clickhouse === 'ok' ? 'OK' : ts(s.health.clickhouse), t('Clicks and conversions'))}
            </section>

            <section className="card sts-card">
              <h3>{t('Click pipeline')}</h3>
              {row(t('Write queue'), s.stats.queue_len < 10000 ? 'ok' : 'warn', fmtInt(s.stats.queue_len), t('Clicks waiting to be written to ClickHouse'))}
              {row(t('Written'), 'ok', fmtInt(s.stats.clicks_written), t('Clicks written since start'))}
              {row(t('Dropped clicks'), s.stats.clicks_dropped === 0 ? 'ok' : 'err', fmtInt(s.stats.clicks_dropped), t('Clicks lost because the write queue was full (since start)'))}
              {row(t('Uniqueness cache'), 'ok', fmtInt(s.stats.uniq_entries), t('Visitors remembered to tell unique clicks from repeats'))}
            </section>

            <section className="card sts-card">
              <h3>{t('Geo data')}</h3>
              {row(t('City database'), s.geo.city.loaded ? 'ok' : 'err', s.geo.city.loaded ? t('Loaded · {ago}', { ago: fmtAgo(s.geo.city.updated) }) : t('Not loaded'), t('Country, region and city of a visitor'))}
              {row(t('ASN database'), s.geo.asn.loaded ? 'ok' : 'warn', s.geo.asn.loaded ? t('Loaded · {ago}', { ago: fmtAgo(s.geo.asn.updated) }) : t('Not loaded'), t('Provider and datacenter detection'))}
              {s.geo.last_error && <div className="field-error">{ts(s.geo.last_error)}</div>}
              <div className="field-help">
                <Link to="/settings">{t('Geo database settings')}</Link>
              </div>
            </section>

            <section className="card sts-card">
              <h3>{t('Serving')}</h3>
              {row(t('Active campaigns'), 'ok', fmtInt(s.stats.campaigns))}
              {row(t('Active domains'), s.stats.domains > 0 ? 'ok' : 'warn', fmtInt(s.stats.domains))}
              {row(t('PHP whitepages'), s.php_enabled ? 'ok' : 'warn', s.php_enabled ? t('Sandbox available') : t('Sandbox not available'))}
              {s.panel && row(t('Panel on a domain'), s.panel.admin_domain_ok ? 'ok' : 'warn', s.panel.admin_domain_ok ? `/${s.panel.admin_path}/` : t('No panel domain yet'), s.panel.ip_access ? t('The panel also answers on ip:port') : undefined)}
            </section>
          </div>
        </>
      )}
    </div>
  )
}
