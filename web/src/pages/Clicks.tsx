import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Bot, RefreshCw } from 'lucide-react'
import { get } from '../api'
import type { Params } from '../api'
import { useDebounced, useLoad } from '../hooks'
import type { Campaign, Row, Stream } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { DateRangePicker, useDateRange } from '../components/DateRangePicker'
import { Badge, CopyButton, Empty, ErrorBox, PageHeader, Pagination, Segmented, Select } from '../components/ui'
import { COUNTRY_SELECT_OPTIONS } from '../components/CountrySelect'
import { rangeParams } from '../reports'
import { fmtDateTime, num } from '../format'
import { countryLabel, flag } from '../countries'

const LIMIT = 100
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const truthy = (v: unknown) => v === true || num(v) > 0

export default function Clicks() {
  const [range, setRange] = useDateRange()
  const [f, setF] = useState({ campaign_id: '', country: '', ip: '', click_id: '', bots: '' })
  const [offset, setOffset] = useState(0)
  const text = useDebounced({ ip: f.ip.trim(), click_id: f.click_id.trim() }, 400)

  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])
  const streams = useLoad(() => get<Stream[]>('streams'), [])

  const query: Params = useMemo(() => ({ ...rangeParams(range), campaign_id: f.campaign_id, country: f.country, bots: f.bots, ip: text.ip, click_id: text.click_id }), [range, f.campaign_id, f.country, f.bots, text])
  const queryKey = JSON.stringify(query)
  useEffect(() => setOffset(0), [queryKey])

  const res = useLoad(() => get<{ rows: Row[] | null; total: number }>('clicks', { ...query, limit: LIMIT, offset }), [queryKey, offset])

  const campName = (id: unknown) => camps.data?.find((c) => c.id === Number(id))?.name ?? (Number(id) ? `#${id}` : '—')
  const streamName = (id: unknown) => streams.data?.find((s) => s.id === Number(id))?.name ?? (Number(id) ? `#${id}` : '—')

  const columns: Column<Row>[] = [
    { key: 'ts', title: 'Time', render: (r) => <span className="nowrap">{fmtDateTime(r.ts)}</span> },
    { key: 'campaign', title: 'Campaign', render: (r) => <span className="ellipsis cell-w">{campName(r.campaign_id)}</span> },
    { key: 'stream', title: 'Stream', render: (r) => <span className="ellipsis cell-w">{streamName(r.stream_id)}</span> },
    {
      key: 'ip',
      title: 'IP',
      render: (r) => (
        <button
          className="link mono"
          title="Filter by this IP"
          onClick={(e) => {
            e.stopPropagation()
            setF((x) => ({ ...x, ip: str(r.ip) }))
          }}
        >
          {str(r.ip)}
        </button>
      ),
    },
    { key: 'country', title: 'Geo', render: (r) => (r.country ? <span title={countryLabel(str(r.country))}>{flag(str(r.country))} {str(r.country)}{r.city ? ` · ${str(r.city)}` : ''}</span> : <span className="muted">—</span>) },
    { key: 'device', title: 'Device', render: (r) => [str(r.device_type), str(r.os), str(r.browser)].filter(Boolean).join(' · ') || <span className="muted">—</span> },
    {
      key: 'flags',
      title: 'Flags',
      render: (r) => (
        <span className="row gap-s">
          {truthy(r.is_bot) && (
            <Badge tone="err" title={str(r.bot_reason)}>
              <Bot size={12} /> bot
            </Badge>
          )}
          {truthy(r.is_dc) && <Badge tone="warn">DC</Badge>}
          {truthy(r.is_unique) && <Badge tone="ok">unique</Badge>}
        </span>
      ),
    },
    { key: 'action', title: 'Action', render: (r) => <Badge tone={r.action === 'error' || r.action === 'no_stream' ? 'err' : 'neutral'}>{str(r.action)}</Badge> },
    { key: 'ref', title: 'Referrer', render: (r) => (r.ref_domain ? <span className="ellipsis cell-w">{str(r.ref_domain)}</span> : <span className="muted">—</span>) },
  ]

  return (
    <div className="page">
      <PageHeader title="Clicks" sub="Raw click log, newest first. Click a row to see every recorded field.">
        <DateRangePicker value={range} onChange={setRange} />
        <button className="btn" onClick={() => res.reload()} title="Refresh">
          <RefreshCw size={14} className={res.loading ? 'spin' : ''} />
        </button>
      </PageHeader>

      <div className="toolbar wrap">
        <Select value={f.campaign_id} onChange={(campaign_id) => setF({ ...f, campaign_id })} placeholder="All campaigns" options={(camps.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))} />
        <Select value={f.country} onChange={(country) => setF({ ...f, country })} placeholder="All countries" options={COUNTRY_SELECT_OPTIONS} />
        <input className="input mono" style={{ width: 170 }} placeholder="IP address (exact)" value={f.ip} onChange={(e) => setF({ ...f, ip: e.target.value })} />
        <input className="input mono" style={{ width: 230 }} placeholder="Click ID" value={f.click_id} onChange={(e) => setF({ ...f, click_id: e.target.value })} />
        <Segmented
          small
          value={f.bots}
          onChange={(bots) => setF({ ...f, bots })}
          options={[
            { value: '', label: 'All' },
            { value: 'exclude', label: 'Humans' },
            { value: 'only', label: 'Bots' },
          ]}
        />
        {(f.ip || f.click_id || f.campaign_id || f.country || f.bots) && (
          <button className="btn small ghost" onClick={() => setF({ campaign_id: '', country: '', ip: '', click_id: '', bots: '' })}>
            Clear filters
          </button>
        )}
      </div>

      <ErrorBox error={res.error} retry={res.reload} />
      <div className="card">
        <DataTable
          columns={columns}
          rows={res.data ? res.data.rows ?? [] : undefined}
          rowKey={(r, i) => str(r.click_id) || i}
          loading={res.loading}
          maxHeight="calc(100vh - 250px)"
          expand={(r) => <ClickDetail r={r} campaign={campName(r.campaign_id)} stream={streamName(r.stream_id)} />}
          empty={<Empty title="No clicks for this selection">Clicks appear here a few seconds after they happen.</Empty>}
        />
        <Pagination total={res.data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />
      </div>
    </div>
  )
}

function ClickDetail({ r, campaign, stream }: { r: Row; campaign: string; stream: string }) {
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
  const yes = (v: unknown) => (truthy(v) ? 'yes' : 'no')
  const item = (label: string, value: ReactNode, mono?: boolean) => (
    <>
      <dt>{label}</dt>
      <dd className={mono ? 'mono break' : 'break'}>{value === '' || value === undefined || value === null ? <span className="muted">—</span> : value}</dd>
    </>
  )
  return (
    <div className="detail detail-cols">
      <dl className="kv">
        {item('Click ID', <span className="row gap-s">{str(r.click_id)} <CopyButton text={str(r.click_id)} className="icon-btn" /></span>, true)}
        {item('Time', fmtDateTime(r.ts))}
        {item('Campaign', `${campaign} (#${str(r.campaign_id)})`)}
        {item('Stream', `${stream} (#${str(r.stream_id)})`)}
        {item('Action', str(r.action))}
        {item('Integration', str(r.integration))}
        {item('Domain', str(r.domain), true)}
        {item('Cost', num(r.cost) ? num(r.cost).toFixed(4) : '')}
        {item('Unique', yes(r.is_unique))}
      </dl>
      <dl className="kv">
        {item('IP', str(r.ip), true)}
        {item('Country', r.country ? countryLabel(str(r.country)) : '')}
        {item('Region', str(r.region))}
        {item('City', str(r.city))}
        {item('ASN', num(r.asn) ? `AS${num(r.asn)}` : '', true)}
        {item('ISP', str(r.isp))}
        {item('Bot', truthy(r.is_bot) ? <Badge tone="err">yes</Badge> : 'no')}
        {item('Bot reason', str(r.bot_reason), true)}
        {item('Datacenter', yes(r.is_dc))}
      </dl>
      <dl className="kv">
        {item('Device', str(r.device_type))}
        {item('OS', [str(r.os), str(r.os_version)].filter(Boolean).join(' '))}
        {item('Browser', [str(r.browser), str(r.browser_version)].filter(Boolean).join(' '))}
        {item('Language', str(r.lang))}
        {item('JA3', str(r.ja3), true)}
        {item('JA4', str(r.ja4), true)}
        {item('Keyword', str(r.keyword))}
        {subs.map(([k, v]) => (
          <span key={k} style={{ display: 'contents' }}>
            {item(k, v, true)}
          </span>
        ))}
        {subs.length === 0 && item('Subs', '')}
      </dl>
      <dl className="kv wide">
        {item('User-Agent', str(r.ua), true)}
        {item('Referrer', str(r.referer), true)}
        {item('Referrer domain', str(r.ref_domain), true)}
        {item(
          'Params',
          Object.keys(params).length ? (
            <pre className="params-json">{paramsRaw}</pre>
          ) : (
            ''
          ),
        )}
      </dl>
    </div>
  )
}
