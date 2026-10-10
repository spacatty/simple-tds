import { Link } from 'react-router-dom'
import { BarChart3, MousePointerClick } from 'lucide-react'
import { get } from '../api'
import type { Params } from '../api'
import { useLoad } from '../hooks'
import type { SplitRow } from '../types'
import { ErrorBox, Skeleton } from '../components/ui'
import { fmtInt, ratioPct } from '../format'
import { t, tn } from '../i18n'
import SplitReport, { MIN_CR_CLICKS } from './SplitReport'
import type { SplitLinks, SplitSpec } from './SplitReport'

const SPEC: SplitSpec = {
  id: 'referrers',
  title: t('Referrers'),
  sub: t('Which sites send the traffic, and how well it converts.'),
  endpoint: 'reports/referrers',
  dim: 'ref_domain',
  column: t('Referrer'),
  name: (k) => (k === '' ? t('(direct / no referrer)') : k),
  main: ['campaign', 'ref_domain', 'device_type', 'os', 'country', 'bots'],
  more: ['stream', 'domain', 'action', 'region', 'city', 'isp', 'lang', 'browser', 'keyword', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'bot_reason'],
  tiles: (s) => [
    { label: t('Referring sites'), value: fmtInt(s.count) },
    { label: t('Clicks with a referrer'), value: fmtInt(s.clicks), sub: t('{pct} of clicks', { pct: ratioPct(s.clicks, s.all) }) },
    { label: t('Direct / no referrer'), value: fmtInt(s.blank), sub: t('{pct} of clicks', { pct: ratioPct(s.blank, s.all) }) },
  ],
  topTitle: (metric) => t('Top referrers by {metric}', { metric }),
  allTitle: t('All referrers'),
  searchPlaceholder: t('Search referrers…'),
  count: (n) => tn(n, 'From {n} site', 'From {n} sites', { n: fmtInt(n) }),
  crEmpty: t('No referrer with at least {n} non-bot clicks has converted in this period.', { n: MIN_CR_CLICKS }),
  crNote: t('Only referrers with at least {n} non-bot clicks are ranked.', { n: MIN_CR_CLICKS }),
  expand: (r, params, links) => <Pages domain={r.key} params={params} links={links} />,
}

export default function Referrers() {
  return <SplitReport spec={SPEC} />
}

/** The pages of one referring site that sent clicks, under its row. */
function Pages({ domain, params, links }: { domain: string; params: Params; links: SplitLinks }) {
  // Clicks without a referrer have no pages to list.
  const rep = useLoad(async () => (domain === '' ? [] : ((await get<{ rows: SplitRow[] | null }>('reports/referrers/urls', { ...params, 'f.ref_domain': domain })).rows ?? [])), [domain, params])
  const rows = rep.data ?? []
  return (
    <div className="ref-pages">
      <div className="row gap-s">
        <span className="muted grow">{domain === '' ? t('Visitors who typed the address, used a bookmark or an app, or whose browser hides the referrer.') : t('Pages that sent the most clicks')}</span>
        <Link className="btn small" to={links.clicks}>
          <MousePointerClick size={13} /> {t('Clicks')}
        </Link>
        <Link className="btn small" to={links.breakdown}>
          <BarChart3 size={13} /> {t('Breakdown')}
        </Link>
      </div>
      <ErrorBox error={rep.error} retry={rep.reload} />
      {domain !== '' && !rep.data && !rep.error && <Skeleton rows={3} />}
      {rows.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>{t('Page')}</th>
              <th style={{ textAlign: 'right' }}>{t('Clicks')}</th>
              <th style={{ textAlign: 'right' }}>{t('Uniques')}</th>
              <th style={{ textAlign: 'right' }}>{t('Mobile')}</th>
              <th style={{ textAlign: 'right' }}>{t('Desktop')}</th>
              <th style={{ textAlign: 'right' }}>{t('Bots')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                {/* Text, not a link: the address comes from the visitor's browser. */}
                <td className="ref-url" title={r.key}>
                  {r.key}
                </td>
                {[r.clicks, r.uniques, r.mobile, r.desktop, r.bots].map((v, i) => (
                  <td key={i} style={{ textAlign: 'right' }} className={v === 0 ? 'muted' : ''}>
                    {fmtInt(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
