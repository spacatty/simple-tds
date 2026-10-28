import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { BarChart3, Bot, Columns3, Download, FlaskConical, RefreshCw } from 'lucide-react'
import { get, qs } from '../api'
import type { Params } from '../api'
import { canRead, useLoad } from '../hooks'
import type { Campaign, ClickEvent, ConvKey, Row, Stage, Stream } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { DateRangePicker, currentRange, rememberRange } from '../components/DateRangePicker'
import type { DateRange } from '../components/DateRangePicker'
import { Badge, CopyButton, Dropdown, Empty, ErrorBox, FilterField, PageHeader, Pagination, Select } from '../components/ui'
import { FilterPanel } from '../components/Filters'
import type { CustomFilter } from '../components/Filters'
import { buildSearch, filterParams, parseFilters, rangeApiParams, rangeFromSearch, urlFilterParams, writeRange } from '../filters'
import { fmtDateTime, fmtMoney, humanize, num } from '../format'
import { countryName } from '../countries'
import { Browser, BrowserIcon, Country, Device, DeviceIcon, Flag, Os, OsIcon, dimIcon } from '../components/icons'
import { Journey, StagePips } from '../components/Journey'
import { t, ts } from '../i18n'

const LIMIT = 100

// Columns the viewer can show or hide; the time is always there. Kept in this browser.
const COLS: { key: string; label: string; def: boolean }[] = [
  { key: 'campaign', label: t('Campaign'), def: true },
  { key: 'stream', label: t('Stream'), def: true },
  { key: 'funnel', label: t('Funnel'), def: true },
  { key: 'ip', label: 'IP', def: true },
  { key: 'country', label: t('Geo'), def: true },
  { key: 'device', label: t('Device'), def: true },
  { key: 'flags', label: t('Flags'), def: true },
  { key: 'action', label: t('Action'), def: true },
  { key: 'ref', label: t('Referrer'), def: true },
  { key: 'domain', label: t('Domain'), def: false },
  { key: 'isp', label: t('ISP'), def: false },
  { key: 'lang', label: t('Language'), def: false },
  { key: 'keyword', label: t('Keyword'), def: false },
  { key: 'sub1', label: 'Sub1', def: false },
  { key: 'sub2', label: 'Sub2', def: false },
  { key: 'sub3', label: 'Sub3', def: false },
  { key: 'sub4', label: 'Sub4', def: false },
  { key: 'sub5', label: 'Sub5', def: false },
  { key: 'cost', label: t('Cost'), def: false },
  { key: 'click_id', label: t('Click ID'), def: false },
  { key: 'ua', label: t('User-Agent@@column'), def: false },
]
const LS_COLS = 'tds_click_cols'
function loadCols(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(LS_COLS) ?? '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const truthy = (v: unknown) => v === true || num(v) > 0

export default function Clicks() {
  const [sp, setSp] = useSearchParams()
  const spKey = sp.toString()
  const [offset, setOffset] = useState(0)

  // Filters live in the URL so Reports, the stream funnel and shared links can open a pre-filtered log.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const range = useMemo(() => rangeFromSearch(sp, currentRange()), [spKey])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const filters = useMemo(() => parseFilters(sp), [spKey])
  const reached = sp.get('reached') ?? ''
  const notReached = sp.get('not_reached') ?? ''

  const update = (fn: (n: URLSearchParams) => void, replace = false) => {
    const n = new URLSearchParams(sp)
    fn(n)
    setSp(n, { replace })
  }
  const setParam = (k: string, v: string, replace = false) =>
    update((n) => {
      n.delete(k)
      if (v !== '') n.set(k, v)
    }, replace)
  const setRange = (r: DateRange) => {
    rememberRange(r)
    update((n) => writeRange(n, r))
  }

  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])
  const streams = useLoad(() => get<Stream[]>('streams'), [])
  const keys = useLoad(() => get<ConvKey[]>('conversion-keys'), [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const query: Params = useMemo(() => ({ ...rangeApiParams(range), ...urlFilterParams(sp), reached, not_reached: notReached }), [range, spKey])
  const queryKey = JSON.stringify(query)
  useEffect(() => setOffset(0), [queryKey])

  const res = useLoad(() => get<{ rows: Row[] | null; total: number }>('clicks', { ...query, limit: LIMIT, offset }), [queryKey, offset])
  const csvHref = 'api/clicks' + qs({ format: 'csv', ...query })

  const [cols, setCols] = useState<Record<string, boolean>>(loadCols)
  const visible = (key: string) => key === 'ts' || (cols[key] ?? COLS.find((c) => c.key === key)?.def ?? true)
  const toggleCol = (key: string) => {
    const next = { ...cols, [key]: !visible(key) }
    setCols(next)
    try {
      localStorage.setItem(LS_COLS, JSON.stringify(next))
    } catch {
      /* private mode: the choice holds until reload */
    }
  }
  const text = (key: string, mono = false) => (r: Row) => (str(r[key]) ? <span className={'ellipsis cell-w' + (mono ? ' mono' : '')} title={str(r[key])}>{str(r[key])}</span> : <span className="muted">—</span>)

  const campById = (id: unknown) => camps.data?.find((c) => c.id === Number(id))
  const campName = (id: unknown) => campById(id)?.name ?? (Number(id) ? `#${id}` : '—')
  const keyName = (id: unknown) => keys.data?.find((k) => k.id === Number(id))?.name ?? `#${id}`
  const stagesOf = (id: unknown): Stage[] => campById(id)?.stages ?? []
  const eventsOf = (r: Row) => (Array.isArray(r.events) ? (r.events as ClickEvent[]) : [])
  const streamName = (id: unknown) => streams.data?.find((s) => s.id === Number(id))?.name ?? (Number(id) ? `#${id}` : '—')

  const campaignId = sp.get('campaign_id') ?? ''

  // Funnel progress: "got to a stage" or "stopped right before it" (got to the one before, not to this one).
  const stages = stagesOf(campaignId)
  const progress = notReached ? 'n:' + notReached : reached ? 'r:' + reached : ''
  const setProgress = (v: string) =>
    update((n) => {
      n.delete('reached')
      n.delete('not_reached')
      const key = v.slice(2)
      if (v.startsWith('r:')) n.set('reached', key)
      if (v.startsWith('n:')) {
        n.set('not_reached', key)
        const i = stages.findIndex((s) => s.key === key)
        if (i > 0) n.set('reached', stages[i - 1].key)
      }
    })
  const progressOptions = [
    ...stages.flatMap((s) => [
      { value: 'r:' + s.key, label: t('Reached: {stage}', { stage: s.name }) },
      ...(s.outcomes ?? []).map((o) => ({ value: `r:${s.key}:${o.key}`, label: t('Reached: {stage}', { stage: `${s.name} · ${o.name}` }) })),
    ]),
    ...stages.map((s) => ({ value: 'n:' + s.key, label: t('Stopped before: {stage}', { stage: s.name }) })),
  ]
  const funnelFilters: CustomFilter[] = progress ? [{ key: 'funnel', label: t('Funnel'), text: progressOptions.find((o) => o.value === progress)?.label ?? progress.slice(2), params: ['reached', 'not_reached'] }] : []
  const showFunnel = (res.data?.rows ?? []).some((r) => stagesOf(r.campaign_id).length > 0 || eventsOf(r).length > 0)

  const allColumns: Column<Row>[] = [
    { key: 'ts', title: t('Time'), render: (r) => <span className="nowrap">{fmtDateTime(r.ts)}</span> },
    { key: 'campaign', title: t('Campaign'), render: (r) => <span className="ellipsis cell-w">{campName(r.campaign_id)}</span> },
    { key: 'stream', title: t('Stream'), render: (r) => <span className="ellipsis cell-w">{streamName(r.stream_id)}</span> },
    ...(showFunnel
      ? [
          {
            key: 'funnel',
            title: t('Funnel'),
            headTitle: t('How far the click got: one mark per stage of its campaign, filled once an event of that stage arrived'),
            render: (r: Row) => <StagePips stages={stagesOf(r.campaign_id)} events={eventsOf(r)} clickTs={r.ts} />,
          },
        ]
      : []),
    {
      key: 'ip',
      title: 'IP',
      render: (r) => (
        <button
          className="link mono"
          title={t('Filter by this IP')}
          onClick={(e) => {
            e.stopPropagation()
            setParam('ip', str(r.ip))
          }}
        >
          {str(r.ip)}
        </button>
      ),
    },
    { key: 'country', title: t('Geo'), render: (r) => (r.country ? <span className="with-icon" title={`${countryName(str(r.country))} (${str(r.country)})`}><Flag code={str(r.country)} />{str(r.country)}{r.city ? ` · ${str(r.city)}` : ''}</span> : <span className="muted">—</span>) },
    { key: 'device', title: t('Device'), render: (r) =>
        str(r.device_type) || str(r.os) || str(r.browser) ? (
          <span className="with-icon">
            {str(r.device_type) && <DeviceIcon type={str(r.device_type)} title={humanize(str(r.device_type))} />}
            {str(r.os) && <OsIcon os={str(r.os)} title={[str(r.os), str(r.os_version)].filter(Boolean).join(' ')} />}
            {str(r.browser) && <BrowserIcon browser={str(r.browser)} title={[str(r.browser), str(r.browser_version)].filter(Boolean).join(' ')} />}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      key: 'flags',
      title: t('Flags'),
      render: (r) => (
        <span className="row gap-s">
          {truthy(r.is_bot) && (
            <Badge tone="err" title={str(r.bot_reason)}>
              <Bot size={12} /> {t('bot')}
            </Badge>
          )}
          {truthy(r.is_dc) && <Badge tone="warn">{t('DC')}</Badge>}
          {truthy(r.is_unique) && <Badge tone="ok">{t('unique')}</Badge>}
        </span>
      ),
    },
    { key: 'action', title: t('Action'), render: (r) => <Badge tone={r.action === 'error' || r.action === 'no_stream' ? 'err' : 'neutral'}>{ts(str(r.action))}</Badge> },
    {
      key: 'ref',
      title: t('Referrer'),
      render: (r) =>
        r.ref_domain ? (
          <button
            className="link ellipsis cell-w"
            title={t('Filter by this referrer')}
            onClick={(e) => {
              e.stopPropagation()
              setParam('f.ref_domain', str(r.ref_domain))
            }}
          >
            {str(r.ref_domain)}
          </button>
        ) : (
          <span className="muted">—</span>
        ),
    },
    { key: 'domain', title: t('Domain'), render: text('domain') },
    { key: 'isp', title: t('ISP'), render: text('isp') },
    { key: 'lang', title: t('Language'), render: text('lang') },
    { key: 'keyword', title: t('Keyword'), render: text('keyword') },
    ...[1, 2, 3, 4, 5].map((n) => ({ key: 'sub' + n, title: 'Sub' + n, render: text('sub' + n) })),
    { key: 'cost', title: t('Cost'), align: 'right', render: (r) => (num(r.cost) ? <span className="nowrap">{fmtMoney(num(r.cost), campById(r.campaign_id)?.currency)}</span> : <span className="muted">—</span>) },
    { key: 'click_id', title: t('Click ID'), render: text('click_id', true) },
    { key: 'ua', title: t('User-Agent@@column'), render: text('ua') },
  ]
  const columns = allColumns.filter((c) => visible(c.key))

  return (
    <div className="page">
      <PageHeader title={t('Clicks')} sub={t('Raw click log, newest first. Click a row to see every recorded field and what the click went on to do.')}>
        <Link className="btn" to={'/reports' + buildSearch({ range, filters: filterParams(filters) })} title={t('Open Reports with the same filters')}>
          <BarChart3 size={14} /> {t('Report')}
        </Link>
        <Dropdown
          align="right"
          label={
            <>
              <Columns3 size={14} /> {t('Columns')}
            </>
          }
        >
          {() => (
            <div className="menu menu-scroll">
              {COLS.map((c) => (
                <label className="menu-item" key={c.key}>
                  <input type="checkbox" checked={visible(c.key)} onChange={() => toggleCol(c.key)} /> {c.label}
                </label>
              ))}
            </div>
          )}
        </Dropdown>
        <a className="btn" href={csvHref} download title={t('Download every matching row (not just this page) as CSV')}>
          <Download size={14} /> {t('Download CSV')}
        </a>
        <DateRangePicker value={range} onChange={setRange} />
        <button className="btn" onClick={() => res.reload()} title={t('Refresh')} aria-label={t('Refresh')}>
          <RefreshCw size={14} className={res.loading ? 'spin' : ''} />
        </button>
      </PageHeader>

      <FilterPanel
        sp={sp}
        update={update}
        lookup={rangeApiParams(range)}
        campaigns={camps.data}
        streams={streams.data}
        campaignDeps={['reached', 'not_reached']}
        custom={funnelFilters}
        main={[
          'campaign',
          'stream',
          ...(stages.length > 0 || progress
            ? [
                {
                  key: 'funnel',
                  node: (
                    <FilterField label={t('Funnel')} active={!!progress}>
                      <Select value={progress} onChange={setProgress} placeholder={t('Any funnel progress')} options={progressOptions} />
                    </FilterField>
                  ),
                },
              ]
            : []),
          'country',
          'device_type',
          'os',
          'ip',
          'bots',
          'banned',
        ]}
        more={['domain', 'action', 'region', 'city', 'isp', 'lang', 'browser', 'ua', 'ref_domain', 'keyword', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'bot_reason', 'unique', 'dc', 'click_id']}
      />

      <ErrorBox error={res.error} retry={res.reload} />
      <div className="card">
        <DataTable
          columns={columns}
          rows={res.data ? res.data.rows ?? [] : undefined}
          rowKey={(r, i) => str(r.click_id) || i}
          loading={res.loading}
          maxHeight="calc(100vh - 250px)"
          expand={(r) => <ClickDetail r={r} campaign={campName(r.campaign_id)} stream={streamName(r.stream_id)} canSimulate={canRead(campById(r.campaign_id))} stages={stagesOf(r.campaign_id)} currency={campById(r.campaign_id)?.currency} keyName={keyName} />}
          empty={<Empty title={t('No clicks for this selection')}>{t('Clicks appear here a few seconds after they happen.')}</Empty>}
        />
        <Pagination total={res.data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />
      </div>
    </div>
  )
}

function ClickDetail({ r, campaign, stream, canSimulate, stages, currency, keyName }: { r: Row; campaign: string; stream: string; canSimulate: boolean; stages: Stage[]; currency?: string; keyName: (id: unknown) => string }) {
  let params: Record<string, string> = {}
  let paramsRaw = str(r.params)
  try {
    const p = typeof r.params === 'string' ? JSON.parse(r.params || '{}') : r.params
    if (p && typeof p === 'object') {
      params = p as Record<string, string>
      paramsRaw = JSON.stringify(p, null, 2)
    }
  } catch {
    /* show the raw string */
  }
  const subs = [1, 2, 3, 4, 5].map((n) => [`sub${n}`, str(r[`sub${n}`])] as const).filter(([, v]) => v)
  const yes = (v: unknown) => (truthy(v) ? t('yes') : t('no'))
  const item = (label: string, value: ReactNode, mono?: boolean) => (
    <>
      <dt>{label}</dt>
      <dd className={mono ? 'mono break' : 'break'}>{value === '' || value === undefined || value === null ? <span className="muted">—</span> : value}</dd>
    </>
  )

  // Replays this visitor in the campaign's simulator: IP, UA, language, referrer and query string.
  const sim = new URLSearchParams()
  sim.set('ip', str(r.ip))
  sim.set('ua', str(r.ua))
  if (r.lang) sim.set('lang', str(r.lang))
  if (r.referer) sim.set('referer', str(r.referer))
  if (r.domain) sim.set('domain', str(r.domain))
  const qs = new URLSearchParams(params).toString()
  if (qs) sim.set('query', qs)

  return (
    <div className="detail">
      <div className="detail-actions">
        {canSimulate && Number(r.campaign_id) > 0 && (
          <Link className="btn small" to={`/campaigns/${str(r.campaign_id)}?tab=simulator&${sim.toString()}`} title={t("Open the campaign's simulator prefilled with this click's IP, User-Agent, language, referrer and query")}>
            <FlaskConical size={13} /> {t('Simulate this visitor')}
          </Link>
        )}
        <Link className="btn small" to={'/conversions?' + new URLSearchParams({ click_id: str(r.click_id) }).toString()} title={t('Conversions attributed to this click')}>
          {t('Conversions of this click')}
        </Link>
      </div>
      {str(r.click_id) && <Journey clickId={str(r.click_id)} clickTs={r.ts} campaignId={Number(r.campaign_id)} stages={stages} currency={currency} keyName={keyName} />}
      <div className="detail-cols">
        <dl className="kv">
          {item(t('Click ID'), <span className="row gap-s">{str(r.click_id)} <CopyButton text={str(r.click_id)} className="icon-btn" /></span>, true)}
          {item(t('Time'), fmtDateTime(r.ts))}
          {item(t('Campaign'), `${campaign} (#${str(r.campaign_id)})`)}
          {item(t('Stream'), `${stream} (#${str(r.stream_id)})`)}
          {item(t('Action'), ts(str(r.action)))}
          {item(t('Integration'), str(r.integration))}
          {item(t('Domain'), str(r.domain), true)}
          {item(t('Cost'), num(r.cost) ? num(r.cost).toFixed(4) : '')}
          {item(t('Unique'), yes(r.is_unique))}
        </dl>
        <dl className="kv">
          {item('IP', str(r.ip), true)}
          {item(t('Country'), r.country ? <Country code={str(r.country)} show="both" /> : '')}
          {item(t('Region'), str(r.region))}
          {item(t('City'), str(r.city))}
          {item('ASN', num(r.asn) ? `AS${num(r.asn)}` : '', true)}
          {item('ISP', str(r.isp))}
          {item(t('Bot'), truthy(r.is_bot) ? <Badge tone="err">{t('yes')}</Badge> : t('no'))}
          {item(t('Bot reason'), str(r.bot_reason), true)}
          {item(t('Datacenter'), yes(r.is_dc))}
        </dl>
        <dl className="kv">
          {item(t('Device'), r.device_type ? <Device type={str(r.device_type)} /> : '')}
          {item(t('OS'), r.os ? <Os os={str(r.os)} version={str(r.os_version)} /> : '')}
          {item(t('Browser'), r.browser ? <Browser browser={str(r.browser)} version={str(r.browser_version)} /> : '')}
          {item(t('Language'), r.lang ? <span className="with-icon">{dimIcon('lang', str(r.lang))}{str(r.lang)}</span> : '')}
          {item('JA3', str(r.ja3), true)}
          {item('JA4', str(r.ja4), true)}
          {item(t('Keyword'), str(r.keyword))}
          {subs.map(([k, v]) => (
            <span key={k} style={{ display: 'contents' }}>
              {item(k, v, true)}
            </span>
          ))}
          {subs.length === 0 && item(t('Subs'), '')}
        </dl>
        <dl className="kv wide">
          {item('User-Agent', str(r.ua), true)}
          {item(t('Referrer'), str(r.referer), true)}
          {item(t('Referrer domain'), str(r.ref_domain), true)}
          {item(t('Params'), Object.keys(params).length ? <pre className="params-json">{paramsRaw}</pre> : '')}
        </dl>
      </div>
    </div>
  )
}
