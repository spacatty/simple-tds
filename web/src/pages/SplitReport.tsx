import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { BarChart3, Download, RefreshCw } from 'lucide-react'
import { get } from '../api'
import type { Params } from '../api'
import { useLoad } from '../hooks'
import type { Campaign, SplitRow, Stream } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { DateRangePicker, currentRange, rememberRange } from '../components/DateRangePicker'
import type { DateRange } from '../components/DateRangePicker'
import { BarList } from '../components/charts'
import { FilterPanel } from '../components/Filters'
import type { FilterItem } from '../components/Filters'
import { Card, Empty, ErrorBox, PageHeader, SearchInput, Segmented, Skeleton } from '../components/ui'
import { rangeParams } from '../reports'
import { buildSearch, rangeFromSearch, urlFilterParams, writeRange } from '../filters'
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

/** A conversion rate over a handful of clicks says nothing: the CR ranking skips smaller rows. */
export const MIN_CR_CLICKS = 10
const TOP = 10

export interface SplitTile {
  label: string
  value: string
  sub?: string
}

/** The figures of the rows that have a name; the row without one is kept apart. */
export interface SplitSummary {
  count: number
  clicks: number
  /** Clicks of the row with an empty key: no referrer, no known country. */
  blank: number
  all: number
}

export interface SplitLinks {
  clicks: string
  breakdown: string
}

/** What tells one report by a dimension from another: its texts, its filters and what a row unfolds into. */
export interface SplitSpec {
  /** Names the page for the filter panel and the export file. */
  id: string
  title: string
  sub: string
  endpoint: string
  /** The dimension the rows are values of. */
  dim: string
  column: string
  /** A row's name as plain text: what the search looks through. */
  name: (key: string) => string
  cell?: (key: string) => ReactNode
  main: FilterItem[]
  more: FilterItem[]
  /** The tiles that are the report's own; the device split and the conversions follow them. */
  tiles: (s: SplitSummary) => SplitTile[]
  topTitle: (metric: string) => string
  allTitle: string
  searchPlaceholder: string
  count: (n: number) => string
  crEmpty: string
  crNote: string
  expand: (row: SplitRow, params: Params, links: SplitLinks) => ReactNode
}

/** A report by one dimension with the device split of its clicks: a ranking, then every row. */
export default function SplitReport({ spec }: { spec: SplitSpec }) {
  const [sp, setSp] = useSearchParams()
  const spKey = sp.toString()
  const [search, setSearch] = useState('')

  // The selection lives in the URL, like on the other report pages.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const range = useMemo(() => rangeFromSearch(sp, currentRange('7d')), [spKey])
  const by = sp.get('by')
  const rank = RANKS.find((r) => r.key === by) ?? RANKS[0]

  const update = (fn: (n: URLSearchParams) => void, replace = false) => {
    const n = new URLSearchParams(sp)
    fn(n)
    setSp(n, { replace })
  }
  const setRange = (r: DateRange) => {
    rememberRange(r)
    update((n) => writeRange(n, r))
  }

  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])
  const streams = useLoad(() => get<Stream[]>('streams'), [])

  const filterKey = JSON.stringify(urlFilterParams(sp))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const params = useMemo<Params>(() => ({ ...rangeParams(range), ...urlFilterParams(sp) }), [range.from, range.to, filterKey])
  const rep = useLoad(async () => (await get<{ rows: SplitRow[] | null }>(spec.endpoint, params)).rows ?? [], [params, spec.endpoint])
  const rows = useMemo(() => rep.data ?? [], [rep.data])

  const named = useMemo(() => rows.filter((r) => r.key !== ''), [rows])
  const blank = rows.find((r) => r.key === '')
  const sum = useMemo(() => {
    const s = { clicks: 0, uniques: 0, bots: 0, mobile: 0, desktop: 0, conversions: 0, revenue: 0 }
    for (const r of named) {
      s.clicks += r.clicks
      s.uniques += r.uniques
      s.bots += r.bots
      s.mobile += r.mobile
      s.desktop += r.desktop
      s.conversions += r.conversions
      s.revenue += r.revenue
    }
    return s
  }, [named])
  const sumReal = sum.clicks - sum.bots

  const links = (key?: string): SplitLinks => {
    const filters: Params = { ...urlFilterParams(sp) }
    if (key !== undefined) filters['f.' + spec.dim] = key
    return {
      clicks: '/clicks' + buildSearch({ range, filters }),
      breakdown: '/reports' + buildSearch({ range, group: key === undefined ? spec.dim : 'campaign', filters }),
    }
  }

  const top = useMemo(() => {
    const pool = rank.key === 'cr' ? named.filter((r) => r.clicks - r.bots >= MIN_CR_CLICKS) : named
    return [...pool]
      .filter((r) => r[rank.key] > 0)
      .sort((a, b) => b[rank.key] - a[rank.key] || b.clicks - a.clicks)
      .slice(0, TOP)
  }, [named, rank.key])

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase()
    return s ? rows.filter((r) => spec.name(r.key).toLowerCase().includes(s) || r.key.toLowerCase() === s) : rows
  }, [rows, search, spec])

  const cell = (key: string) => spec.cell?.(key) ?? spec.name(key)
  const num = (key: 'clicks' | 'uniques' | 'mobile' | 'desktop' | 'bots' | 'conversions', title: string, headTitle?: string): Column<SplitRow> => ({
    key,
    title,
    headTitle,
    align: 'right',
    sort: (r) => r[key],
    className: key === rank.key ? 'col-active' : '',
    render: (r) => <span className={r[key] === 0 ? 'muted' : ''}>{fmtInt(r[key])}</span>,
  })
  const columns: Column<SplitRow>[] = [
    { key: 'key', title: spec.column, sort: (r) => spec.name(r.key).toLowerCase(), render: (r) => <span className={r.key === '' ? 'muted' : ''}>{cell(r.key)}</span> },
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
    const head = [spec.dim, 'clicks', 'uniques', 'mobile', 'desktop', 'bots', 'conversions', 'cr', 'revenue']
    const lines = [head.join(',')]
    for (const r of rows) lines.push([r.key, r.clicks, r.uniques, r.mobile, r.desktop, r.bots, r.conversions, r.cr, r.revenue].map(csvEscape).join(','))
    downloadText(`${spec.id}-${ymd(new Date(range.from * 1000))}_${ymd(new Date(range.to * 1000 - 1000))}.csv`, '﻿' + lines.join('\r\n'), 'text/csv')
  }

  const tiles: SplitTile[] = [
    ...spec.tiles({ count: named.length, clicks: sum.clicks, blank: blank?.clicks ?? 0, all: sum.clicks + (blank?.clicks ?? 0) }),
    { label: t('Mobile'), value: ratioPct(sum.mobile, sum.clicks), sub: tn(sum.mobile, '{n} click', '{n} clicks', { n: fmtInt(sum.mobile) }) },
    { label: t('Desktop'), value: ratioPct(sum.desktop, sum.clicks), sub: tn(sum.desktop, '{n} click', '{n} clicks', { n: fmtInt(sum.desktop) }) },
    { label: t('Conversions'), value: fmtInt(sum.conversions), sub: t('CR {pct}', { pct: fmtPct(sumReal > 0 ? (sum.conversions / sumReal) * 100 : 0) }) },
  ]

  return (
    <div className="page">
      <PageHeader title={spec.title} sub={spec.sub}>
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

      <FilterPanel id={spec.id} sp={sp} update={update} main={spec.main} more={spec.more} lookup={rangeParams(range)} campaigns={camps.data} streams={streams.data} />

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
        title={spec.topTitle(rank.title ? `${rank.label} — ${rank.title}` : rank.label)}
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
            empty={rank.key === 'cr' ? spec.crEmpty : t('No data for this period')}
            items={top.map((r) => ({
              key: r.key,
              label: (
                <Link className="top-link" to={links(r.key).clicks} title={t('Show these clicks')}>
                  {cell(r.key)}
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
        {rank.key === 'cr' && top.length > 0 && <div className="muted small ref-note">{spec.crNote}</div>}
      </Card>

      <Card title={spec.allTitle} actions={<SearchInput value={search} onChange={setSearch} placeholder={spec.searchPlaceholder} />} pad={false}>
        <DataTable
          key={rank.key}
          columns={columns}
          rows={rep.data ? shown : undefined}
          rowKey={(r) => r.key}
          loading={rep.loading}
          defaultSort={{ key: rank.key, dir: 'desc' }}
          maxHeight="calc(100vh - 200px)"
          empty={<Empty title={t('No data for this selection')}>{t('Try a wider date range or fewer filters.')}</Empty>}
          expand={(r) => spec.expand(r, params, links(r.key))}
          footer={
            <tr>
              <td />
              <td>{spec.count(named.length)}</td>
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
