import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { BarChart3, Download, MousePointerClick, RefreshCw } from 'lucide-react'
import { get } from '../api'
import type { Params } from '../api'
import { useLoad } from '../hooks'
import type { Campaign, ReferrerRow } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { DateRangePicker, currentRange, rememberRange } from '../components/DateRangePicker'
import type { DateRange } from '../components/DateRangePicker'
import { BarList } from '../components/charts'
import { Card, Empty, ErrorBox, FilterBar, FilterField, PageHeader, SearchInput, Segmented, Select, Skeleton } from '../components/ui'
import { rangeParams } from '../reports'
import { buildSearch, rangeFromSearch, writeRange } from '../filters'
import { csvEscape, downloadText, fmtInt, fmtMoney, fmtPct, ratioPct, ymd } from '../format'
import { t, tn } from '../i18n'

type RankKey = 'clicks' | 'uniques' | 'mobile' | 'desktop' | 'conversions' | 'cr'

interface Rank {
  key: RankKey
  label: string
  title?: string
  fmt: (v: number) => string
}

const RANKS: Rank[] = [
  { key: 'clicks', label: t('Clicks'), fmt: fmtInt },
  { key: 'uniques', label: t('Uniques'), fmt: fmtInt },
  { key: 'mobile', label: t('Mobile'), title: t('Clicks from phones and tablets'), fmt: fmtInt },
  { key: 'desktop', label: t('Desktop'), title: t('Clicks from desktop browsers'), fmt: fmtInt },
  { key: 'conversions', label: t('Conv.'), title: t('Conversions (excluding rejected)'), fmt: fmtInt },
  { key: 'cr', label: t('CR'), title: t('Conversions / non-bot clicks'), fmt: (v) => fmtPct(v) },
]
const isRank = (v: string | null): v is RankKey => RANKS.some((r) => r.key === v)

// A conversion rate over a handful of clicks says nothing: the CR ranking skips smaller referrers.
const MIN_CR_CLICKS = 10
const TOP = 10

const refName = (k: string) => (k === '' ? t('(direct / no referrer)') : k)

export default function Referrers() {
  const [sp, setSp] = useSearchParams()
  const spKey = sp.toString()
  const [search, setSearch] = useState('')

  // The selection lives in the URL, like on the other report pages.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const range = useMemo(() => rangeFromSearch(sp, currentRange('7d')), [spKey])
  const campaignId = sp.get('campaign_id') ?? ''
  const bots = sp.get('bots') === 'only' || sp.get('bots') === 'exclude' ? (sp.get('bots') as string) : ''
  const by = sp.get('by')
  const rank = RANKS.find((r) => r.key === by) ?? RANKS[0]

  const update = (fn: (n: URLSearchParams) => void) => {
    const n = new URLSearchParams(sp)
    fn(n)
    setSp(n)
  }
  const setRange = (r: DateRange) => {
    rememberRange(r)
    update((n) => writeRange(n, r))
  }

  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])

  const params = useMemo(() => {
    const p: Params = { ...rangeParams(range) }
    if (campaignId) p.campaign_id = campaignId
    if (bots) p.bots = bots
    return p
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to, campaignId, bots])
  const rep = useLoad(async () => (await get<{ rows: ReferrerRow[] | null }>('reports/referrers', params)).rows ?? [], [params])
  const rows = useMemo(() => rep.data ?? [], [rep.data])

  const sites = useMemo(() => rows.filter((r) => r.key !== ''), [rows])
  const direct = rows.find((r) => r.key === '')
  const sum = useMemo(() => {
    const s = { clicks: 0, uniques: 0, bots: 0, mobile: 0, desktop: 0, conversions: 0, revenue: 0 }
    for (const r of sites) {
      s.clicks += r.clicks
      s.uniques += r.uniques
      s.bots += r.bots
      s.mobile += r.mobile
      s.desktop += r.desktop
      s.conversions += r.conversions
      s.revenue += r.revenue
    }
    return s
  }, [sites])
  const allClicks = sum.clicks + (direct?.clicks ?? 0)
  const sumReal = sum.clicks - sum.bots

  const links = (domain?: string) => {
    const filters: Record<string, string> = {}
    if (campaignId) filters.campaign_id = campaignId
    if (domain !== undefined) filters['f.ref_domain'] = domain
    return {
      clicks: '/clicks' + buildSearch({ range, filters, bots }),
      breakdown: '/reports' + buildSearch({ range, group: domain === undefined ? 'ref_domain' : 'campaign', filters, bots }),
    }
  }

  const top = useMemo(() => {
    const pool = rank.key === 'cr' ? sites.filter((r) => r.clicks - r.bots >= MIN_CR_CLICKS) : sites
    return [...pool]
      .filter((r) => r[rank.key] > 0)
      .sort((a, b) => b[rank.key] - a[rank.key] || b.clicks - a.clicks)
      .slice(0, TOP)
  }, [sites, rank.key])

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase()
    return s ? rows.filter((r) => refName(r.key).toLowerCase().includes(s)) : rows
  }, [rows, search])

  const num = (key: 'clicks' | 'uniques' | 'mobile' | 'desktop' | 'bots' | 'conversions', title: string, headTitle?: string): Column<ReferrerRow> => ({
    key,
    title,
    headTitle,
    align: 'right',
    sort: (r) => r[key],
    className: key === rank.key ? 'col-active' : '',
    render: (r) => <span className={r[key] === 0 ? 'muted' : ''}>{fmtInt(r[key])}</span>,
  })
  const columns: Column<ReferrerRow>[] = [
    { key: 'key', title: t('Referrer'), sort: (r) => r.key, render: (r) => <span className={r.key === '' ? 'muted' : ''}>{refName(r.key)}</span> },
    num('clicks', t('Clicks')),
    num('uniques', t('Uniques')),
    num('mobile', t('Mobile'), t('Clicks from phones and tablets')),
    num('desktop', t('Desktop'), t('Clicks from desktop browsers')),
    num('bots', t('Bots')),
    num('conversions', t('Conv.'), t('Conversions (excluding rejected)')),
    {
      key: 'cr',
      title: t('CR'),
      headTitle: t('Conversions / non-bot clicks'),
      align: 'right',
      sort: (r) => r.cr,
      className: rank.key === 'cr' ? 'col-active' : '',
      render: (r) => <span className={r.cr === 0 ? 'muted' : ''}>{fmtPct(r.cr)}</span>,
    },
    { key: 'revenue', title: t('Revenue'), align: 'right', sort: (r) => r.revenue, render: (r) => <span className={r.revenue === 0 ? 'muted' : ''}>{fmtMoney(r.revenue)}</span> },
  ]

  const exportCSV = () => {
    const head = ['referrer', 'clicks', 'uniques', 'mobile', 'desktop', 'bots', 'conversions', 'cr', 'revenue']
    const lines = [head.join(',')]
    for (const r of rows) lines.push([r.key, r.clicks, r.uniques, r.mobile, r.desktop, r.bots, r.conversions, r.cr, r.revenue].map(csvEscape).join(','))
    downloadText(`referrers-${ymd(new Date(range.from * 1000))}_${ymd(new Date(range.to * 1000 - 1000))}.csv`, '﻿' + lines.join('\r\n'), 'text/csv')
  }

  const tiles: { label: string; value: string; sub?: string }[] = [
    { label: t('Referring sites'), value: fmtInt(sites.length) },
    { label: t('Clicks with a referrer'), value: fmtInt(sum.clicks), sub: t('{pct} of clicks', { pct: ratioPct(sum.clicks, allClicks) }) },
    { label: t('Direct / no referrer'), value: fmtInt(direct?.clicks ?? 0), sub: t('{pct} of clicks', { pct: ratioPct(direct?.clicks ?? 0, allClicks) }) },
    { label: t('Mobile'), value: ratioPct(sum.mobile, sum.clicks), sub: tn(sum.mobile, '{n} click', '{n} clicks', { n: fmtInt(sum.mobile) }) },
    { label: t('Desktop'), value: ratioPct(sum.desktop, sum.clicks), sub: tn(sum.desktop, '{n} click', '{n} clicks', { n: fmtInt(sum.desktop) }) },
    { label: t('Conversions'), value: fmtInt(sum.conversions), sub: t('CR {pct}', { pct: fmtPct(sumReal > 0 ? (sum.conversions / sumReal) * 100 : 0) }) },
  ]

  return (
    <div className="page">
      <PageHeader title={t('Referrers')} sub={t('Which sites send the traffic, and how well it converts.')}>
        <Link className="btn" to={links().breakdown} title={t('Open Reports with the same filters')}>
          <BarChart3 size={14} /> {t('Breakdown')}
        </Link>
        <button className="btn" disabled={!rows.length} onClick={exportCSV}>
          <Download size={14} /> {t('Export CSV')}
        </button>
        <DateRangePicker value={range} onChange={setRange} />
        <button className="btn" onClick={() => rep.reload()} title={t('Refresh')} aria-label={t('Refresh')}>
          <RefreshCw size={14} className={rep.loading ? 'spin' : ''} />
        </button>
      </PageHeader>

      <FilterBar>
        <FilterField label={t('Campaign')} active={!!campaignId}>
          <Select
            value={campaignId}
            onChange={(v) =>
              update((n) => {
                if (v) n.set('campaign_id', v)
                else n.delete('campaign_id')
              })
            }
            placeholder={t('All campaigns')}
            options={(camps.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
          />
        </FilterField>
        <FilterField label={t('Traffic')} size="auto">
          <Segmented
            small
            className="bots"
            value={bots}
            onChange={(v) =>
              update((n) => {
                if (v) n.set('bots', v)
                else n.delete('bots')
              })
            }
            options={[
              { value: '', label: t('All traffic') },
              { value: 'exclude', label: t('No bots') },
              { value: 'only', label: t('Bots only') },
            ]}
          />
        </FilterField>
      </FilterBar>

      <ErrorBox error={rep.error} retry={rep.reload} />

      <div className="tiles compact">
        {tiles.map((x) => (
          <div className="tile" key={x.label}>
            {rep.data ? (
              <>
                <div className="tile-label">{x.label}</div>
                <div className="tile-value">{x.value}</div>
                {x.sub && <div className="tile-sub">{x.sub}</div>}
              </>
            ) : (
              <Skeleton rows={2} />
            )}
          </div>
        ))}
      </div>

      <Card
        title={t('Top referrers by {metric}', { metric: rank.title ? `${rank.label} — ${rank.title}` : rank.label })}
        actions={
          <Segmented
            small
            value={rank.key}
            onChange={(v) =>
              update((n) => {
                if (isRank(v) && v !== 'clicks') n.set('by', v)
                else n.delete('by')
              })
            }
            options={RANKS.map((r) => ({ value: r.key, label: r.label }))}
          />
        }
      >
        {!rep.data ? (
          <Skeleton rows={5} />
        ) : (
          <BarList
            fmt={rank.fmt}
            empty={rank.key === 'cr' ? t('No referrer with at least {n} non-bot clicks has converted in this period.', { n: MIN_CR_CLICKS }) : t('No data for this period')}
            items={top.map((r) => ({
              key: r.key,
              label: (
                <Link className="top-link" to={links(r.key).clicks} title={t('Show these clicks')}>
                  {r.key}
                </Link>
              ),
              value: r[rank.key],
              extra:
                rank.key === 'cr'
                  ? t('{conv} of {clicks}', { conv: fmtInt(r.conversions), clicks: fmtInt(r.clicks - r.bots) })
                  : rank.key === 'conversions'
                    ? fmtPct(r.cr)
                    : ratioPct(r[rank.key], sum[rank.key]),
            }))}
          />
        )}
        {rank.key === 'cr' && top.length > 0 && <div className="muted small ref-note">{t('Only referrers with at least {n} non-bot clicks are ranked.', { n: MIN_CR_CLICKS })}</div>}
      </Card>

      <Card title={t('All referrers')} actions={<SearchInput value={search} onChange={setSearch} placeholder={t('Search referrers…')} />} pad={false}>
        <DataTable
          key={rank.key}
          columns={columns}
          rows={rep.data ? shown : undefined}
          rowKey={(r) => r.key}
          loading={rep.loading}
          defaultSort={{ key: rank.key, dir: 'desc' }}
          maxHeight="calc(100vh - 200px)"
          empty={<Empty title={t('No data for this selection')}>{t('Try a wider date range or fewer filters.')}</Empty>}
          expand={(r) => <Pages domain={r.key} params={params} links={links(r.key)} />}
          footer={
            <tr>
              <td />
              <td>{tn(sites.length, 'From {n} site', 'From {n} sites', { n: fmtInt(sites.length) })}</td>
              {[sum.clicks, sum.uniques, sum.mobile, sum.desktop, sum.bots, sum.conversions].map((v, i) => (
                <td key={i} style={{ textAlign: 'right' }}>
                  {fmtInt(v)}
                </td>
              ))}
              <td style={{ textAlign: 'right' }}>{fmtPct(sumReal > 0 ? (sum.conversions / sumReal) * 100 : 0)}</td>
              <td style={{ textAlign: 'right' }}>{fmtMoney(sum.revenue)}</td>
            </tr>
          }
        />
      </Card>
    </div>
  )
}

/** The pages of one referring site that sent clicks, under its row. */
function Pages({ domain, params, links }: { domain: string; params: Params; links: { clicks: string; breakdown: string } }) {
  // Clicks without a referrer have no pages to list.
  const rep = useLoad(async () => (domain === '' ? [] : ((await get<{ rows: ReferrerRow[] | null }>('reports/referrers/urls', { ...params, 'f.ref_domain': domain })).rows ?? [])), [domain, params])
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
