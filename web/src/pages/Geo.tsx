import { useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, MousePointerClick } from 'lucide-react'
import { get } from '../api'
import type { Params } from '../api'
import { useLoad } from '../hooks'
import type { SplitRow } from '../types'
import { ErrorBox, Segmented, Skeleton } from '../components/ui'
import { Country } from '../components/icons'
import { countryName } from '../countries'
import { fmtInt, fmtPct, ratioPct } from '../format'
import { t, tn } from '../i18n'
import SplitReport, { MIN_CR_CLICKS } from './SplitReport'
import type { SplitLinks, SplitSpec } from './SplitReport'

const SPEC: SplitSpec = {
  id: 'geo',
  title: t('Geo'),
  sub: t('Where the traffic comes from, and how well each country converts.'),
  endpoint: 'reports/geo',
  dim: 'country',
  column: t('Country'),
  name: (k) => (k === '' ? t('(unknown location)') : `${countryName(k)} (${k})`),
  cell: (k) => (k === '' ? t('(unknown location)') : <Country code={k} show="both" />),
  main: ['campaign', 'device_type', 'os', 'ref_domain', 'bots'],
  more: ['stream', 'domain', 'action', 'country', 'region', 'city', 'isp', 'lang', 'browser', 'keyword', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'bot_reason'],
  tiles: (s) => [
    { label: t('Countries'), value: fmtInt(s.count) },
    { label: t('Clicks with a known country'), value: fmtInt(s.clicks), sub: t('{pct} of clicks', { pct: ratioPct(s.clicks, s.all) }) },
    { label: t('Unknown location'), value: fmtInt(s.blank), sub: t('{pct} of clicks', { pct: ratioPct(s.blank, s.all) }) },
  ],
  topTitle: (metric) => t('Top countries by {metric}', { metric }),
  allTitle: t('All countries'),
  searchPlaceholder: t('Search countries…'),
  count: (n) => tn(n, 'From {n} country', 'From {n} countries', { n: fmtInt(n) }),
  crEmpty: t('No country with at least {n} non-bot clicks has converted in this period.', { n: MIN_CR_CLICKS }),
  crNote: t('Only countries with at least {n} non-bot clicks are ranked.', { n: MIN_CR_CLICKS }),
  expand: (r, params, links) => <Places country={r.key} params={params} links={links} />,
}

export default function Geo() {
  return <SplitReport spec={SPEC} />
}

type Level = 'city' | 'region'
const MAX_PLACES = 50

/** The cities or regions of one country that sent clicks, under its row. */
function Places({ country, params, links }: { country: string; params: Params; links: SplitLinks }) {
  const [by, setBy] = useState<Level>('city')
  const rep = useLoad(async () => (await get<{ rows: SplitRow[] | null }>('reports/geo', { ...params, by, 'f.country': country })).rows ?? [], [country, params, by])
  const all = rep.data ?? []
  const rows = all.slice(0, MAX_PLACES)
  return (
    <div className="ref-pages">
      <div className="row gap-s">
        <Segmented
          small
          value={by}
          onChange={setBy}
          options={[
            { value: 'city', label: t('Cities') },
            { value: 'region', label: t('Regions') },
          ]}
        />
        <span className="muted grow">{all.length > rows.length ? t('The {n} that sent the most clicks, of {total}', { n: rows.length, total: fmtInt(all.length) }) : ''}</span>
        <Link className="btn small" to={links.clicks}>
          <MousePointerClick size={13} /> {t('Clicks')}
        </Link>
        <Link className="btn small" to={links.breakdown}>
          <BarChart3 size={13} /> {t('Breakdown')}
        </Link>
      </div>
      <ErrorBox error={rep.error} retry={rep.reload} />
      {!rep.data && !rep.error && <Skeleton rows={3} />}
      {rows.length > 0 && (
        <table className={'table' + (rep.loading ? ' reloading' : '')}>
          <thead>
            <tr>
              <th>{by === 'city' ? t('City') : t('Region')}</th>
              <th style={{ textAlign: 'right' }}>{t('Clicks')}</th>
              <th style={{ textAlign: 'right' }}>{t('Uniques')}</th>
              <th style={{ textAlign: 'right' }}>{t('Mobile')}</th>
              <th style={{ textAlign: 'right' }}>{t('Desktop')}</th>
              <th style={{ textAlign: 'right' }}>{t('Bots')}</th>
              <th style={{ textAlign: 'right' }} title={t('Conversions (excluding rejected)')}>
                {t('Conv.')}
              </th>
              <th style={{ textAlign: 'right' }} title={t('Conversions / non-bot clicks')}>
                {t('CR')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className={r.key === '' ? 'muted' : ''}>{r.key === '' ? t('(unknown)') : r.key}</td>
                {[r.clicks, r.uniques, r.mobile, r.desktop, r.bots, r.conversions].map((v, i) => (
                  <td key={i} style={{ textAlign: 'right' }} className={v === 0 ? 'muted' : ''}>
                    {fmtInt(v)}
                  </td>
                ))}
                <td style={{ textAlign: 'right' }} className={r.cr === 0 ? 'muted' : ''}>
                  {fmtPct(r.cr)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
