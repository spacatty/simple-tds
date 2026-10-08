import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { BarChart3, Bot, FlaskConical, RefreshCw, X } from 'lucide-react'
import { get } from '../api'
import type { Params } from '../api'
import { canRead, useDebounced, useLoad } from '../hooks'
import type { Campaign, Row, Stream } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { DateRangePicker, currentRange, rememberRange } from '../components/DateRangePicker'
import type { DateRange } from '../components/DateRangePicker'
import { Badge, CopyButton, Empty, ErrorBox, PageHeader, Pagination, Segmented, Select } from '../components/ui'
import { COUNTRY_SELECT_OPTIONS } from '../components/CountrySelect'
import { buildSearch, dimLabel, filterParams, parseFilters, rangeApiParams, rangeFromSearch, writeRange } from '../filters'
import { fmtDateTime, num } from '../format'
import { countryName } from '../countries'
import { Browser, BrowserIcon, Country, Device, DeviceIcon, Flag, Os, OsIcon } from '../components/icons'
import { t, ts } from '../i18n'

const LIMIT = 100
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
  const urlIP = sp.get('ip') ?? ''
  const urlClick = sp.get('click_id') ?? ''

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

  // Free-text fields are typed locally and pushed to the URL once the user pauses.
  const [text, setText] = useState({ ip: urlIP, click_id: urlClick })
  useEffect(() => setText({ ip: urlIP, click_id: urlClick }), [urlIP, urlClick])
  const debounced = useDebounced(text, 400)
  useEffect(() => {
    if (debounced.ip.trim() !== urlIP || debounced.click_id.trim() !== urlClick) {
      update((n) => {
        n.delete('ip')
        n.delete('click_id')
        if (debounced.ip.trim()) n.set('ip', debounced.ip.trim())
        if (debounced.click_id.trim()) n.set('click_id', debounced.click_id.trim())
      }, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced])

  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])
  const streams = useLoad(() => get<Stream[]>('streams'), [])

  const query: Params = useMemo(() => ({ ...rangeApiParams(range), ...filterParams(filters), ip: urlIP, click_id: urlClick }), [range, filters, urlIP, urlClick])
  const queryKey = JSON.stringify(query)
  useEffect(() => setOffset(0), [queryKey])

  const res = useLoad(() => get<{ rows: Row[] | null; total: number }>('clicks', { ...query, limit: LIMIT, offset }), [queryKey, offset])

  const campById = (id: unknown) => camps.data?.find((c) => c.id === Number(id))
  const campName = (id: unknown) => campById(id)?.name ?? (Number(id) ? `#${id}` : '—')
  const streamName = (id: unknown) => streams.data?.find((s) => s.id === Number(id))?.name ?? (Number(id) ? `#${id}` : '—')

  const crumb = (dim: string) => filters.crumbs.find((c) => c.dim === dim)?.value
  const campaignId = crumb('campaign') ?? ''
  const streamId = crumb('stream') ?? ''
  const streamOptions = (streams.data ?? []).filter((s) => !campaignId || String(s.campaign_id) === campaignId).map((s) => ({ value: String(s.id), label: campaignId ? s.name : `${s.name} · ${campName(s.campaign_id)}` }))

  const crumbText = (dim: string, v: string) => (dim === 'campaign' ? campName(v) : dim === 'stream' ? streamName(v) : dim === 'country' ? (v ? `${countryName(v)} (${v})` : t('(unknown)')) : v === '' ? t('(empty)') : dim === 'action' ? ts(v) : v)
  const anyFilter = filters.crumbs.length > 0 || !!filters.bots || !!urlIP || !!urlClick

  const columns: Column<Row>[] = [
    { key: 'ts', title: t('Time'), render: (r) => <span className="nowrap">{fmtDateTime(r.ts)}</span> },
    { key: 'campaign', title: t('Campaign'), render: (r) => <span className="ellipsis cell-w">{campName(r.campaign_id)}</span> },
    { key: 'stream', title: t('Stream'), render: (r) => <span className="ellipsis cell-w">{streamName(r.stream_id)}</span> },
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
          <span className="with-icon" title={[str(r.device_type), [str(r.os), str(r.os_version)].filter(Boolean).join(' '), [str(r.browser), str(r.browser_version)].filter(Boolean).join(' ')].filter(Boolean).join(' · ')}>
            {str(r.device_type) && <DeviceIcon type={str(r.device_type)} />}
            {str(r.os) && <OsIcon os={str(r.os)} />}
            {str(r.os)}
            {str(r.browser) && <BrowserIcon browser={str(r.browser)} />}
            {str(r.browser)}
            {!r.os && !r.browser && str(r.device_type)}
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
    { key: 'ref', title: t('Referrer'), render: (r) => (r.ref_domain ? <span className="ellipsis cell-w">{str(r.ref_domain)}</span> : <span className="muted">—</span>) },
  ]

  const reportFilters: Record<string, string> = {}
  for (const c of filters.crumbs) reportFilters[c.param] = c.value

  return (
    <div className="page">
      <PageHeader title={t('Clicks')} sub={t('Raw click log, newest first. Click a row to see every recorded field.')}>
        <DateRangePicker value={range} onChange={setRange} />
        <button className="btn" onClick={() => res.reload()} title={t('Refresh')} aria-label={t('Refresh')}>
          <RefreshCw size={14} className={res.loading ? 'spin' : ''} />
        </button>
      </PageHeader>

      <div className="toolbar wrap">
        <Select
          value={campaignId}
          onChange={(v) =>
            update((n) => {
              n.delete('campaign_id')
              n.delete('stream_id')
              if (v) n.set('campaign_id', v)
            })
          }
          placeholder={t('All campaigns')}
          options={(camps.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
        />
        <Select value={streamId} onChange={(v) => setParam('stream_id', v)} placeholder={t('All streams')} options={streamOptions} />
        <Select value={crumb('country') ?? ''} onChange={(v) => setParam('f.country', v)} placeholder={t('All countries')} options={COUNTRY_SELECT_OPTIONS} />
        <input className="input mono" style={{ width: 160 }} placeholder={t('IP address (exact)')} value={text.ip} onChange={(e) => setText({ ...text, ip: e.target.value })} />
        <input className="input mono" style={{ width: 220 }} placeholder={t('Click ID')} value={text.click_id} onChange={(e) => setText({ ...text, click_id: e.target.value })} />
        <Segmented
          small
          value={filters.bots}
          onChange={(v) => setParam('bots', v)}
          options={[
            { value: '', label: t('All') },
            { value: 'exclude', label: t('Humans') },
            { value: 'only', label: t('Bots') },
          ]}
        />
        <span className="grow" />
        <Link className="btn" to={'/reports' + buildSearch({ range, filters: reportFilters, bots: filters.bots })} title={t('Open Reports with the same filters')}>
          <BarChart3 size={14} /> {t('Report')}
        </Link>
      </div>

      {anyFilter && (
        <nav className="crumbs" aria-label={t('Active filters')}>
          <span className="muted">{t('Filtered by')}</span>
          {filters.crumbs.map((c) => (
            <span className="crumb" key={c.param}>
              <span className="muted">{dimLabel(c.dim)}:</span> <b>{crumbText(c.dim, c.value)}</b>
              <button aria-label={t('Remove filter {name}', { name: dimLabel(c.dim) })} onClick={() => update((n) => n.delete(c.param))}>
                <X size={12} />
              </button>
            </span>
          ))}
          {filters.bots && (
            <span className="crumb">
              <b>{filters.bots === 'only' ? t('Bots only') : t('No bots')}</b>
              <button aria-label={t('Remove bots filter')} onClick={() => setParam('bots', '')}>
                <X size={12} />
              </button>
            </span>
          )}
          {urlIP && (
            <span className="crumb">
              <span className="muted">IP:</span> <b className="mono">{urlIP}</b>
              <button aria-label={t('Remove IP filter')} onClick={() => setParam('ip', '')}>
                <X size={12} />
              </button>
            </span>
          )}
          {urlClick && (
            <span className="crumb">
              <span className="muted">{t('Click ID')}:</span> <b className="mono">{urlClick}</b>
              <button aria-label={t('Remove click id filter')} onClick={() => setParam('click_id', '')}>
                <X size={12} />
              </button>
            </span>
          )}
          <button
            className="btn small ghost"
            onClick={() =>
              update((n) => {
                filters.crumbs.forEach((c) => n.delete(c.param))
                n.delete('bots')
                n.delete('ip')
                n.delete('click_id')
              })
            }
          >
            {t('Clear all')}
          </button>
        </nav>
      )}

      <ErrorBox error={res.error} retry={res.reload} />
      <div className="card">
        <DataTable
          columns={columns}
          rows={res.data ? res.data.rows ?? [] : undefined}
          rowKey={(r, i) => str(r.click_id) || i}
          loading={res.loading}
          maxHeight="calc(100vh - 250px)"
          expand={(r) => <ClickDetail r={r} campaign={campName(r.campaign_id)} stream={streamName(r.stream_id)} canSimulate={canRead(campById(r.campaign_id))} />}
          empty={<Empty title={t('No clicks for this selection')}>{t('Clicks appear here a few seconds after they happen.')}</Empty>}
        />
        <Pagination total={res.data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />
      </div>
    </div>
  )
}

function ClickDetail({ r, campaign, stream, canSimulate }: { r: Row; campaign: string; stream: string; canSimulate: boolean }) {
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
          {item(t('Language'), str(r.lang))}
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
