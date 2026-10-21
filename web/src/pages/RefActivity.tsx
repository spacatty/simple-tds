import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { BarChart3, MousePointerClick, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react'
import { get } from '../api'
import type { Params } from '../api'
import { useDebounced, useLoad } from '../hooks'
import type { Campaign, RefActivity as Activity, RefProfile, RefRow, RefStatus, ReportRow, SplitRow, Stream } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { BarList, CategoryBarChart, Spark, TimeChart } from '../components/charts'
import { FilterPanel } from '../components/Filters'
import { Badge, Card, Drawer, Empty, ErrorBox, FilterField, PageHeader, SearchInput, Segmented, Select, Skeleton, Tabs } from '../components/ui'
import type { Tone } from '../components/ui'
import { dimIcon } from '../components/icons'
import { buildSearch, urlFilterParams, valueText } from '../filters'
import { browserTZ, fmtAgo, fmtDateTime, fmtInt, fmtMoney, fmtPct, fmtSpan, humanize, ratioPct, ymd, ymdh } from '../format'
import { t, ts } from '../i18n'

const MAIN_FILTERS = ['campaign', 'country', 'device_type', 'bots', 'banned']
const MORE_FILTERS = ['stream', 'domain', 'os', 'browser', 'lang', 'isp', 'keyword', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5']

const LOOKBACKS = [
  { value: '30', label: t('30 days') },
  { value: '90', label: t('90 days') },
  { value: '365', label: t('1 year') },
  { value: '0', label: t('All time') },
]
const IDLES = [
  { value: '1', label: t('1 hour') },
  { value: '6', label: t('6 hours') },
  { value: '24', label: t('24 hours') },
  { value: '72', label: t('3 days') },
]
const DEAD_DAYS = 7

const STATUS: Record<RefStatus, { label: string; tone: Tone; color: string }> = {
  active: { label: t('Active'), tone: 'ok', color: 'var(--ok)' },
  recent: { label: t('Recently dead'), tone: 'warn', color: 'var(--warn)' },
  dead: { label: t('Dead'), tone: 'err', color: 'var(--err)' },
}
const isStatus = (v: string | null): v is RefStatus => v === 'active' || v === 'recent' || v === 'dead'

const ms = (v: string) => new Date(v).getTime()

/**
 * Whether a living referrer is fading or growing: its last 24 hours against
 * the daily average of the 7 days before them. Null when there is too little
 * to tell.
 */
function trend(r: RefRow): number | null {
  const avg = r.week / 7
  if (avg < 5 && r.day < 5) return null
  if (avg === 0) return null
  return (r.day / avg - 1) * 100
}

/** Referrer domains by the age of their last click: who still sends traffic, who stopped and when. */
export default function RefActivity() {
  const [sp, setSp] = useSearchParams()
  const days = LOOKBACKS.some((l) => l.value === sp.get('days')) ? (sp.get('days') as string) : '90'
  const idle = IDLES.some((l) => l.value === sp.get('idle')) ? (sp.get('idle') as string) : '24'
  const status = isStatus(sp.get('status')) ? (sp.get('status') as RefStatus) : ''
  const open = sp.get('ref')

  const update = (fn: (n: URLSearchParams) => void, replace = false) => {
    const n = new URLSearchParams(sp)
    fn(n)
    setSp(n, { replace })
  }
  const setParam = (k: string, v: string, fallback = '') => update((n) => (v === fallback ? n.delete(k) : n.set(k, v)))

  // The search is typed fast and kept in the URL a moment later.
  const [search, setSearch] = useState(sp.get('q') ?? '')
  const debounced = useDebounced(search.trim(), 300)
  useEffect(() => {
    if (debounced !== (sp.get('q') ?? '')) update((n) => (debounced ? n.set('q', debounced) : n.delete('q')), true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced])

  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])
  const streams = useLoad(() => get<Stream[]>('streams'), [])

  const filterKey = JSON.stringify(urlFilterParams(sp))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const params = useMemo<Params>(() => ({ days, tz: browserTZ, ...urlFilterParams(sp) }), [days, filterKey])
  const q = sp.get('q') ?? ''
  const rep = useLoad(() => get<Activity>('reports/referrers/activity', { ...params, idle, status, search: q }), [params, idle, status, q])
  const rows = useMemo(() => rep.data?.rows ?? [], [rep.data])
  const counts = rep.data?.counts ?? { active: 0, recent: 0, dead: 0 }
  const all = counts.active + counts.recent + counts.dead
  const lookbackFrom = days === '0' ? 0 : Date.now() - Number(days) * 86400_000
  // What the value lists of the filters count over.
  const lookup = useMemo<Params>(() => ({ from: lookbackFrom ? Math.floor(lookbackFrom / 1000) : undefined, tz: browserTZ }), [days]) // eslint-disable-line react-hooks/exhaustive-deps

  const idleText = IDLES.find((i) => i.value === idle)?.label ?? ''
  const tabs = [
    { value: '' as const, label: tabLabel(t('All'), all) },
    ...(['active', 'recent', 'dead'] as RefStatus[]).map((s) => ({ value: s, label: tabLabel(STATUS[s].label, counts[s]) })),
  ]

  // The lifespan bars share one axis: from the oldest first click shown to now.
  const axisFrom = useMemo(() => (rows.length ? Math.min(...rows.map((r) => ms(r.first))) : 0), [rows])

  const columns: Column<RefRow>[] = [
    {
      key: 'ref',
      title: t('Referrer'),
      sort: (r) => r.ref,
      render: (r) => (
        <span className="with-icon">
          <span className={'dot ' + STATUS[r.status].tone} title={STATUS[r.status].label} />
          <span className="ellipsis">{r.ref}</span>
          {r.new && (
            <span className="tag info" title={t('The first click came within the idle time')}>
              {t('new')}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'last',
      title: t('Last click'),
      sort: (r) => ms(r.last),
      align: 'right',
      render: (r) => (
        <span title={fmtDateTime(r.last)} className={r.status === 'active' ? '' : STATUS[r.status].tone === 'err' ? 'neg' : 'tone-warn'}>
          {fmtAgo(r.last)}
        </span>
      ),
    },
    {
      key: 'life',
      title: t('Lifespan'),
      headTitle: t('From the first click to the last, on one scale for every row: the bar ends at now'),
      sort: (r) => ms(r.last) - ms(r.first),
      render: (r) => <LifeBar row={r} from={axisFrom} />,
    },
    {
      key: 'spark',
      title: t('Last 14 days'),
      render: (r) => <Spark values={r.spark ?? []} color={STATUS[r.status].color} width={96} height={24} />,
    },
    {
      key: 'day',
      title: t('24h'),
      headTitle: t('Clicks in the last 24 hours, against the daily average of the 7 days before'),
      align: 'right',
      sort: (r) => r.day,
      render: (r) => <DayCell row={r} />,
    },
    { key: 'clicks', title: t('Clicks'), align: 'right', sort: (r) => r.clicks, render: (r) => fmtInt(r.clicks) },
    { key: 'days', title: t('Days active'), headTitle: t('Days with at least one click'), align: 'right', sort: (r) => r.days, render: (r) => fmtInt(r.days) },
    {
      key: 'conversions',
      title: t('Conv.'),
      headTitle: t('Conversions (excluding rejected)'),
      align: 'right',
      sort: (r) => r.conversions,
      render: (r) => <span className={r.conversions === 0 ? 'muted' : ''}>{fmtInt(r.conversions)}</span>,
    },
    { key: 'revenue', title: t('Revenue'), align: 'right', sort: (r) => r.revenue, render: (r) => <span className={r.revenue === 0 ? 'muted' : ''}>{fmtMoney(r.revenue)}</span> },
  ]

  return (
    <div className="page">
      <PageHeader title={t('Referrer activity')} sub={t('When each referrer last sent a click: which still send traffic, which went quiet, and how long they lived.')}>
        <Segmented value={days} onChange={(v) => setParam('days', v, '90')} options={LOOKBACKS} />
        <button className="btn" onClick={() => rep.reload()} title={t('Refresh')} aria-label={t('Refresh')}>
          <RefreshCw size={14} className={rep.loading ? 'spin' : ''} />
        </button>
      </PageHeader>

      <FilterPanel
        sp={sp}
        update={update}
        main={[
          {
            key: 'idle',
            node: (
              <FilterField key="idle" label={t('Inactive after')}>
                <Select value={idle} onChange={(v) => setParam('idle', v, '24')} options={IDLES} />
              </FilterField>
            ),
          },
          ...MAIN_FILTERS,
        ]}
        more={MORE_FILTERS}
        lookup={lookup}
        campaigns={camps.data}
        streams={streams.data}
      />

      <ErrorBox error={rep.error} retry={rep.reload} />

      <div className="ref-health">
        {(['active', 'recent', 'dead'] as RefStatus[]).map((s) => (
          <button key={s} type="button" className={'tile ref-health-tile ' + s + (status === s ? ' selected' : '')} onClick={() => setParam('status', status === s ? '' : s)}>
            {rep.data ? (
              <>
                <div className="tile-label">
                  <span className={'dot ' + STATUS[s].tone} /> {STATUS[s].label}
                </div>
                <div className="tile-value">{fmtInt(counts[s])}</div>
                <div className="tile-sub">
                  {s === 'active'
                    ? t('a click within the last {idle}', { idle: idleText })
                    : s === 'recent'
                      ? t('silent for {idle} to {n} days', { idle: idleText, n: DEAD_DAYS })
                      : t('silent for more than {n} days', { n: DEAD_DAYS })}
                </div>
              </>
            ) : (
              <Skeleton rows={2} />
            )}
          </button>
        ))}
        <div className="ref-health-bar" aria-hidden="true">
          {all > 0 &&
            (['active', 'recent', 'dead'] as RefStatus[]).map((s) =>
              counts[s] ? <span key={s} style={{ flexGrow: counts[s], background: STATUS[s].color }} title={`${STATUS[s].label}: ${counts[s]} (${ratioPct(counts[s], all)})`} /> : null,
            )}
        </div>
      </div>

      <Card
        title={
          <Tabs
            value={status}
            onChange={(v) => setParam('status', v)}
            tabs={tabs}
          />
        }
        actions={<SearchInput value={search} onChange={setSearch} placeholder={t('Find a referrer…')} width={240} />}
        pad={false}
      >
        <DataTable
          key={status + (q ? '|q' : '')}
          columns={columns}
          rows={rep.data ? rows : undefined}
          rowKey={(r) => r.ref}
          loading={rep.loading}
          // A search keeps the server's order: the best match first.
          defaultSort={q ? undefined : status === 'active' ? { key: 'day', dir: 'desc' } : { key: 'last', dir: 'desc' }}
          maxHeight="calc(100vh - 200px)"
          onRowClick={(r) => update((n) => n.set('ref', r.ref))}
          empty={
            <Empty title={q ? t('No referrer matches “{q}”', { q }) : t('No referrers here')}>
              {status === 'dead' ? t('Every referrer of this period sent a click in the last {n} days.', { n: DEAD_DAYS }) : t('Try a longer lookback or fewer filters.')}
            </Empty>
          }
        />
        {rep.data && rep.data.total > rows.length && <div className="muted small pad-s">{t('The first {n} of {total}; search to narrow the list.', { n: fmtInt(rows.length), total: fmtInt(rep.data.total) })}</div>}
      </Card>

      {open && <Profile referrer={open} days={days} filters={urlFilterParams(sp)} idle={Number(idle)} campaigns={camps.data} onClose={() => update((n) => n.delete('ref'))} />}
    </div>
  )
}

function tabLabel(label: string, n: number): ReactNode {
  return (
    <>
      {label} <span className="tab-count">{fmtInt(n)}</span>
    </>
  )
}

/** The span of a referrer's life on the shared axis, and the silence after it. */
function LifeBar({ row, from }: { row: RefRow; from: number }) {
  const now = Date.now()
  const span = Math.max(1, now - from)
  const left = ((ms(row.first) - from) / span) * 100
  const width = Math.max(0.8, ((ms(row.last) - ms(row.first)) / span) * 100)
  return (
    <div className="lifebar" title={t('{first} → {last}: {span}', { first: fmtDateTime(row.first, false), last: fmtDateTime(row.last, false), span: fmtSpan((ms(row.last) - ms(row.first)) / 1000) })}>
      <span className="lifebar-life" style={{ left: `${left}%`, width: `${width}%`, background: STATUS[row.status].color }} />
      <span className="lifebar-text">{fmtSpan((ms(row.last) - ms(row.first)) / 1000)}</span>
    </div>
  )
}

function DayCell({ row }: { row: RefRow }) {
  const tr = row.status === 'active' ? trend(row) : null
  return (
    <span className="with-icon" style={{ justifyContent: 'flex-end' }}>
      <span className={row.day === 0 ? 'muted' : ''}>{fmtInt(row.day)}</span>
      {tr !== null && Math.abs(tr) >= 30 && (
        <span className={tr < 0 ? 'neg' : 'pos'} title={t('{pct} against the daily average of the 7 days before', { pct: (tr > 0 ? '+' : '') + fmtPct(tr, 0) })}>
          {tr < 0 ? <TrendingDown size={13} /> : <TrendingUp size={13} />}
        </span>
      )}
    </span>
  )
}

const WEEKDAYS = [t('Mon'), t('Tue'), t('Wed'), t('Thu'), t('Fri'), t('Sat'), t('Sun')]
const TOPS: { dim: string; title: string }[] = [
  { dim: 'country', title: t('Top countries') },
  { dim: 'device_type', title: t('Devices') },
  { dim: 'os', title: t('Operating systems') },
  { dim: 'browser', title: t('Browsers') },
  { dim: 'campaign', title: t('Campaigns') },
]

/** One referrer: its life on a line, when it sends, who it sends and what they bring. */
function Profile({ referrer, days, filters: pageFilters, idle, campaigns, onClose }: { referrer: string; days: string; filters: Params; idle: number; campaigns?: Campaign[]; onClose: () => void }) {
  const filterKey = JSON.stringify(pageFilters)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const filters = useMemo<Params>(() => ({ ...pageFilters, 'f.ref_domain': referrer }), [filterKey, referrer])
  const prof = useLoad(() => get<RefProfile>('reports/referrers/profile', { ...pageFilters, ref: referrer, days, tz: browserTZ }), [filters, days])
  const p = prof.data
  const now = Date.now()

  // The reports below cover the referrer's life, which the lookback may cut.
  const range = useMemo(() => {
    if (!p?.clicks) return null
    const first = new Date(p.first)
    const from = Math.floor(new Date(first.getFullYear(), first.getMonth(), first.getDate()).getTime() / 1000)
    return { from, to: Math.ceil(now / 1000), hourly: now - ms(p.first) < 3 * 86400_000 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.first, p?.clicks])
  const rq = useMemo<Params | null>(() => (range ? { ...filters, from: range.from, to: range.to, tz: browserTZ } : null), [range, filters])

  const timeline = useLoad(async () => (rq ? (await get<{ rows: ReportRow[] | null }>('reports', { ...rq, group: range!.hourly ? 'hour' : 'day' })).rows ?? [] : []), [rq])
  const total = useLoad(async () => (rq ? ((await get<{ rows: ReportRow[] | null }>('reports', { ...rq, group: 'total' })).rows ?? [])[0] : undefined), [rq])
  const tops = useLoad(async () => {
    if (!rq) return {}
    const out: Record<string, SplitRow[]> = {}
    await Promise.all([
      ...TOPS.map(async (x) => {
        out[x.dim] = (await get<{ rows: SplitRow[] | null }>('reports/split', { ...rq, dim: x.dim })).rows ?? []
      }),
      (async () => {
        out.pages = (await get<{ rows: SplitRow[] | null }>('reports/referrers/urls', rq)).rows ?? []
      })(),
    ])
    return out
  }, [rq])

  // Every day (or hour) of the life, the silent ones included: a gap must show as one.
  const series = useMemo(() => {
    if (!range || !timeline.data) return []
    const by = new Map(timeline.data.map((r) => [r.key, r]))
    const out: Record<string, string | number>[] = []
    // Days are stepped by the calendar, so a DST change neither skips nor repeats one.
    for (const d = new Date(range.from * 1000); d.getTime() < range.to * 1000; range.hourly ? d.setTime(d.getTime() + 3600_000) : d.setDate(d.getDate() + 1)) {
      const key = range.hourly ? ymdh(d) : ymd(d)
      const r = by.get(key)
      out.push({ key, clicks: r?.clicks ?? 0, conversions: r?.conversions ?? 0 })
    }
    return out
  }, [range, timeline.data])

  const status: RefStatus | null = p?.clicks ? (now - ms(p.last) < idle * 3600_000 ? 'active' : now - ms(p.last) < DEAD_DAYS * 86400_000 ? 'recent' : 'dead') : null
  const campName = (k: string) => (k === '0' ? t('(no campaign)') : campaigns?.find((c) => String(c.id) === k)?.name ?? `#${k}`)
  const tot = total.data
  const peak = p ? p.hours.indexOf(Math.max(...p.hours)) : 0
  const real = (tot?.clicks ?? 0) - (tot?.bots ?? 0)
  const types = tot ? [...Object.entries(tot.types ?? {}), ...(tot.rejected ? [['rejected', tot.rejected] as [string, number]] : [])].sort((a, b) => b[1] - a[1]) : []

  const links = range ? { from: range.from, to: range.to } : null

  return (
    <Drawer
      title={
        <span className="with-icon">
          {status && <span className={'dot ' + STATUS[status].tone} />}
          {referrer}
        </span>
      }
      onClose={onClose}
      size="xl"
      footer={
        links && (
          <>
            <Link className="btn" to={'/clicks' + buildSearch({ range: { preset: 'custom', ...links }, filters })}>
              <MousePointerClick size={14} /> {t('Clicks')}
            </Link>
            <Link className="btn" to={'/reports' + buildSearch({ range: { preset: 'custom', ...links }, group: range?.hourly ? 'hour' : 'day', filters })}>
              <BarChart3 size={14} /> {t('Breakdown')}
            </Link>
          </>
        )
      }
    >
      <ErrorBox error={prof.error} retry={prof.reload} />
      {!p && !prof.error && <Skeleton rows={6} />}
      {p && !p.clicks && <Empty title={t('No clicks from this referrer')}>{t('Try a longer lookback or fewer filters.')}</Empty>}
      {p && p.clicks > 0 && status && (
        <div className="ref-profile">
          <Lifeline p={p} status={status} />

          <div className="tiles compact">
            <Tile label={t('Status')} value={<Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>} sub={t('last click {ago}', { ago: fmtAgo(p.last) })} />
            <Tile label={t('Lived')} value={fmtSpan((ms(p.last) - ms(p.first)) / 1000)} sub={t('since {date}', { date: fmtDateTime(p.first, false) })} />
            <Tile label={t('Days active')} value={fmtInt(p.days)} sub={t('of {n} calendar days', { n: fmtInt(Math.max(1, Math.round((ms(p.last) - ms(p.first)) / 86400_000) + 1)) })} />
            <Tile label={t('Longest silence')} value={p.longest_gap ? fmtSpan(p.longest_gap) : '—'} sub={p.longest_gap ? fmtDateTime(p.gap_from, false) : t('no gap of an hour or more')} />
            <Tile label={t('Clicks')} value={fmtInt(p.clicks)} sub={t('{u} unique · {b} bots', { u: fmtInt(p.uniques), b: fmtInt(p.bots) })} />
            <Tile label={t('Conversions')} value={tot ? fmtInt(tot.conversions) : '…'} sub={tot ? t('CR {pct}', { pct: fmtPct(real > 0 ? (tot.conversions / real) * 100 : 0) }) : undefined} />
            <Tile label={t('Peak hour')} value={`${String(peak).padStart(2, '0')}:00`} sub={t('{pct} of clicks', { pct: ratioPct(p.hours[peak], p.clicks) })} />
            <Tile label={t('Revenue')} value={tot ? fmtMoney(tot.revenue) : '…'} sub={tot && real > 0 ? t('EPC {v}', { v: (tot.revenue / real).toFixed(4) }) : undefined} />
          </div>

          <Card title={range?.hourly ? t('Clicks by hour') : t('Clicks by day')}>
            {!timeline.data ? (
              <Skeleton rows={5} />
            ) : (
              <TimeChart
                area
                height={200}
                data={series}
                series={[
                  { key: 'clicks', label: t('Clicks'), color: 'var(--series-1)' },
                  { key: 'conversions', label: t('Conversions'), color: 'var(--series-3)' },
                ]}
              />
            )}
          </Card>

          <div className="grid-2">
            <Card title={t('Hour of the day')}>
              <CategoryBarChart height={160} data={p.hours.map((n, h) => ({ key: String(h).padStart(2, '0'), clicks: n }))} series={{ key: 'clicks', label: t('Clicks'), color: 'var(--series-1)' }} />
            </Card>
            <Card title={t('Day of the week')}>
              <CategoryBarChart height={160} data={p.weekdays.map((n, d) => ({ key: WEEKDAYS[d], clicks: n }))} series={{ key: 'clicks', label: t('Clicks'), color: 'var(--series-2)' }} />
            </Card>
          </div>

          <div className="grid-2">
            <Card title={t('Conversions by type')}>
              {!tot ? <Skeleton rows={3} /> : <BarList items={types.map(([k, n]) => ({ key: k, label: ts(humanize(k)), value: n, extra: ratioPct(n, real) }))} color="var(--series-3)" empty={t('No conversions from this referrer')} />}
            </Card>
            {TOPS.map((x) => (
              <Card key={x.dim} title={x.title}>
                {!tops.data ? (
                  <Skeleton rows={3} />
                ) : (
                  <BarList
                    items={(tops.data[x.dim] ?? []).slice(0, 6).map((r) => ({
                      key: r.key,
                      label: (
                        <span className="with-icon">
                          {dimIcon(x.dim, r.key, r.country)}
                          {x.dim === 'campaign' ? campName(r.key) : valueText(x.dim, r.key)}
                        </span>
                      ),
                      value: r.clicks,
                      extra: r.conversions ? t('{pct} · {n} conv.', { pct: ratioPct(r.clicks, p.clicks), n: fmtInt(r.conversions) }) : ratioPct(r.clicks, p.clicks),
                    }))}
                  />
                )}
              </Card>
            ))}
            <Card title={t('Referring pages')}>
              {!tops.data ? (
                <Skeleton rows={3} />
              ) : (
                <BarList items={(tops.data.pages ?? []).slice(0, 6).map((r) => ({ key: r.key, label: <span className="mono small">{r.key || t('(empty)')}</span>, value: r.clicks, extra: ratioPct(r.clicks, p.clicks) }))} color="var(--series-2)" />
              )}
            </Card>
          </div>
        </div>
      )}
    </Drawer>
  )
}

function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  )
}

/** First click, last click and now on one line: the life of the referrer, then its silence. */
function Lifeline({ p, status }: { p: RefProfile; status: RefStatus }) {
  const first = ms(p.first)
  const last = ms(p.last)
  const now = Date.now()
  const span = Math.max(1, now - first)
  const life = Math.max(1, ((last - first) / span) * 100)
  const silent = (now - last) / 1000
  return (
    <div className="lifeline">
      <div className="lifeline-track">
        <span className="lifeline-life" style={{ width: `${life}%`, background: STATUS[status].color }} />
        <span className="lifeline-silence" style={{ left: `${life}%` }} />
      </div>
      <div className="lifeline-labels">
        <span>
          <b>{t('First click')}</b> {fmtDateTime(p.first, false)}
        </span>
        <span style={{ textAlign: 'center' }}>
          <b>{t('Last click')}</b> {fmtDateTime(p.last, false)}
        </span>
        <span style={{ textAlign: 'right' }}>
          <b>{status === 'active' ? t('Sending now') : t('Silent for {span}', { span: fmtSpan(silent) })}</b>
        </span>
      </div>
    </div>
  )
}
