import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { Columns3, Download, RefreshCw, X } from 'lucide-react'
import { get, qs } from '../api'
import type { Params } from '../api'
import { useDebounced, useLoad, useMeta } from '../hooks'
import type { Campaign, ConvKey, ConvRow, Stage } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { DateRangePicker, useDateRange } from '../components/DateRangePicker'
import { Badge, CopyButton, Dropdown, Empty, ErrorBox, FilterBar, FilterField, PageHeader, Pagination, Select } from '../components/ui'
import type { Tone } from '../components/ui'
import { rangeParams } from '../reports'
import { fmtDateTime, fmtMoney, fmtSpan, humanize, num, secondsBetween } from '../format'
import { Browser, Country, Device, Os } from '../components/icons'
import { Journey, stageName } from '../components/Journey'
import { t, ts } from '../i18n'
import ConvKeys from './ConvKeys'
import PostbackLog from './Postbacks'

/** The three pages of the Conversions group in the sidebar: /conversions, /conversions/postbacks and /conversions/keys. */
export default function Conversions() {
  const { tab } = useParams()
  if (tab === 'keys') {
    return (
      <div className="page">
        <PageHeader title={t('Keys & postback URLs')} sub={t('A key authorises a sender to report conversions and sets the rules its postbacks are checked against.')} />
        <ConvKeys />
      </div>
    )
  }
  if (tab === 'postbacks') {
    return (
      <div className="page">
        <PostbackLog />
      </div>
    )
  }
  return (
    <div className="page">
      <ConvLog />
    </div>
  )
}

interface ConvResp {
  rows: ConvRow[] | null
  param_keys: string[] | null
  total: number
}

export const TYPE_TONE: Record<string, Tone> = { sale: 'ok', deposit: 'ok', lead: 'info', install: 'accent', registration: 'info', action: 'neutral', rejected: 'err' }

const FIXED: { key: string; label: string; def: boolean }[] = [
  { key: 'ts', label: t('Time'), def: true },
  { key: 'type', label: t('Type'), def: true },
  { key: 'key_id', label: t('Key'), def: true },
  { key: 'campaign_id', label: t('Campaign'), def: true },
  { key: 'click_id', label: t('Click ID'), def: true },
  { key: 'since', label: t('After the click'), def: true },
  { key: 'revenue', label: t('Revenue'), def: true },
  { key: 'cost', label: t('Cost'), def: false },
  { key: 'currency', label: t('Currency'), def: true },
  { key: 'sender_ip', label: t('Sender IP'), def: true },
  { key: 'country', label: t('Country'), def: true },
  { key: 'city', label: t('City'), def: false },
  { key: 'device_type', label: t('Device'), def: false },
  { key: 'os', label: t('OS'), def: false },
  { key: 'browser', label: t('Browser'), def: false },
  { key: 'domain', label: t('Domain'), def: false },
  { key: 'stream_id', label: t('Stream ID'), def: false },
  { key: 'sub1', label: 'Sub1', def: false },
  { key: 'sub2', label: 'Sub2', def: false },
  { key: 'sub3', label: 'Sub3', def: false },
  { key: 'sub4', label: 'Sub4', def: false },
  { key: 'sub5', label: 'Sub5', def: false },
  { key: 'conv_id', label: t('Conversion ID'), def: false },
]

const LS_COLS = 'tds_conv_cols'
function loadCols(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(LS_COLS) ?? '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

const LIMIT = 100

function ConvLog() {
  const meta = useMeta()
  const [range, setRange] = useDateRange()
  const [search] = useSearchParams()
  // The click log links here with ?click_id=… to show the conversions of one click, the funnel with ?type=… for one stage.
  const [f, setF] = useState({ key_id: '', campaign_id: search.get('campaign_id') ?? '', type: search.get('type') ?? '', click_id: search.get('click_id') ?? '', ip: '' })
  const [pf, setPf] = useState<Record<string, string>>({})
  const [offset, setOffset] = useState(0)
  const [cols, setCols] = useState<Record<string, boolean>>(loadCols)
  const [newP, setNewP] = useState({ key: '', value: '' })
  // Debounced one by one: an object would be new on every render and keep the timer running forever.
  const clickId = useDebounced(f.click_id.trim(), 400)
  const ip = useDebounced(f.ip.trim(), 400)

  const keys = useLoad(() => get<ConvKey[]>('conversion-keys'), [])
  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])

  const query: Params = useMemo(() => {
    const p: Params = { ...rangeParams(range), key_id: f.key_id, campaign_id: f.campaign_id, type: f.type, click_id: clickId, ip }
    for (const [k, v] of Object.entries(pf)) p['p.' + k] = v
    return p
  }, [range, f.key_id, f.campaign_id, f.type, clickId, ip, pf])
  const queryKey = JSON.stringify(query)

  useEffect(() => setOffset(0), [queryKey])
  const res = useLoad(() => get<ConvResp>('conversions', { ...query, limit: LIMIT, offset }), [queryKey, offset])

  const paramKeys = res.data?.param_keys ?? []
  const visible = (key: string, def: boolean) => cols[key] ?? def
  const toggleCol = (key: string, def: boolean) => {
    const next = { ...cols, [key]: !visible(key, def) }
    setCols(next)
    try {
      localStorage.setItem(LS_COLS, JSON.stringify(next))
    } catch {
      /* ignore */
    }
  }
  const addParam = (k: string, v: string) => {
    if (!k || v === '') return
    setPf((x) => ({ ...x, [k]: v }))
  }

  const keyName = (id: unknown) => keys.data?.find((k) => k.id === Number(id))?.name ?? (Number(id) ? `#${id}` : '—')
  // Built-in types plus the funnel stages of the campaigns in view.
  const typeOptions = useMemo(() => {
    const stages = (camps.data ?? []).filter((c) => !f.campaign_id || String(c.id) === f.campaign_id).flatMap((c) => c.stages ?? [])
    const extra = new Map(stages.filter((s) => !meta.conversion_types.includes(s.key)).map((s) => [s.key, s.key]))
    return [...meta.conversion_types.map((ty) => ({ value: ty, label: ts(humanize(ty)) })), ...[...extra.keys()].sort().map((k) => ({ value: k, label: k }))]
  }, [camps.data, f.campaign_id, meta.conversion_types])
  const campById = (id: unknown) => camps.data?.find((c) => c.id === Number(id))
  const stagesOf = (id: unknown): Stage[] => campById(id)?.stages ?? []
  const campName = (id: unknown) => camps.data?.find((c) => c.id === Number(id))?.name ?? (Number(id) ? `#${id}` : '—')

  const cell = (key: string, r: ConvRow) => {
    const v = r[key]
    switch (key) {
      case 'ts':
        return <span className="nowrap">{fmtDateTime(v)}</span>
      case 'type':
        return (
          <Badge tone={TYPE_TONE[String(v)] ?? (num(r.goal) ? 'ok' : 'neutral')} title={String(v)}>
            {stageName(stagesOf(r.campaign_id), String(v))}
          </Badge>
        )
      case 'since': {
        const after = r.click_id ? secondsBetween(r.click_ts, r.ts) : null
        return after === null ? <span className="muted">—</span> : <span className="nowrap">{fmtSpan(after)}</span>
      }
      case 'key_id':
        return keyName(v)
      case 'campaign_id':
        return campName(v)
      case 'click_id':
        return v ? (
          <button
            className="link mono"
            title={t('Filter by this click')}
            onClick={(e) => {
              e.stopPropagation()
              setF((x) => ({ ...x, click_id: String(v) }))
            }}
          >
            {String(v)}
          </button>
        ) : (
          <span className="muted" title={t('Not attributed to a click')}>
            —
          </span>
        )
      case 'revenue':
      case 'cost':
        return fmtMoney(v)
      case 'sender_ip':
        return (
          <button
            className="link mono"
            title={t('Filter by this sender')}
            onClick={(e) => {
              e.stopPropagation()
              setF((x) => ({ ...x, ip: String(v) }))
            }}
          >
            {String(v)}
          </button>
        )
      case 'country':
        return <Country code={String(v ?? '')} />
      case 'device_type':
        return <Device type={String(v ?? '')} />
      case 'os':
        return <Os os={String(v ?? '')} />
      case 'browser':
        return <Browser browser={String(v ?? '')} />
      case 'conv_id':
        return <span className="mono">{String(v)}</span>
      default:
        return v === '' || v === null || v === undefined || v === 0 ? <span className="muted">—</span> : String(v)
    }
  }

  const columns: Column<ConvRow>[] = [
    ...FIXED.filter((c) => visible(c.key, c.def)).map(
      (c): Column<ConvRow> => ({ key: c.key, title: c.label, align: c.key === 'revenue' || c.key === 'cost' ? 'right' : undefined, render: (r) => cell(c.key, r) }),
    ),
    ...paramKeys
      .filter((k) => visible('p.' + k, true))
      .map(
        (k): Column<ConvRow> => ({
          key: 'p.' + k,
          title: <span className="param-col">{k}</span>,
          headTitle: t('Postback parameter “{name}”', { name: k }),
          render: (r) => {
            const v = r.params?.[k]
            if (v === undefined || v === '') return <span className="muted">—</span>
            return (
              <button className="link ellipsis" style={{ maxWidth: 220 }} title={v + '\n' + t('Click to filter by {param}', { param: `${k}=${v}` })} onClick={(e) => {
                  e.stopPropagation()
                  addParam(k, v)
                }}
              >
                {v}
              </button>
            )
          },
        }),
      ),
  ]

  const csvHref = 'api/conversions' + qs({ format: 'csv', ...query })
  const activeFilters = Object.entries(pf)
  const anyFilter = activeFilters.length > 0 || Object.values(f).some(Boolean)

  return (
    <>
      <PageHeader title={t('Conversion log')} sub={t('Postbacks and funnel events received from affiliate networks, apps, installers and pages. Click a row to see everything it carried and the journey of its click.')}>
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
              <div className="menu-title">{t('Fixed')}</div>
              {FIXED.map((c) => (
                <label className="menu-item" key={c.key}>
                  <input type="checkbox" checked={visible(c.key, c.def)} onChange={() => toggleCol(c.key, c.def)} /> {c.label}
                </label>
              ))}
              {paramKeys.length > 0 && <div className="menu-title">{t('Postback parameters')}</div>}
              {paramKeys.map((k) => (
                <label className="menu-item" key={k}>
                  <input type="checkbox" checked={visible('p.' + k, true)} onChange={() => toggleCol('p.' + k, true)} /> {k}
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

      <FilterBar
        onReset={
          anyFilter
            ? () => {
                setPf({})
                setF({ key_id: '', campaign_id: '', type: '', click_id: '', ip: '' })
              }
            : undefined
        }
        chips={
          activeFilters.length > 0 && (
            <>
              <span className="muted">{t('Filtered by')}</span>
              {activeFilters.map(([k, v]) => (
                <span className="crumb" key={k}>
                  <span className="muted mono">{k}:</span> <b className="mono">{v}</b>
                  <button
                    aria-label={t('Remove filter {name}', { name: k })}
                    onClick={() =>
                      setPf((x) => {
                        const n = { ...x }
                        delete n[k]
                        return n
                      })
                    }
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </>
          )
        }
      >
        <FilterField label={t('Key')} active={!!f.key_id}>
          <Select value={f.key_id} onChange={(key_id) => setF({ ...f, key_id })} placeholder={t('All keys')} options={(keys.data ?? []).map((k) => ({ value: String(k.id), label: k.name }))} />
        </FilterField>
        <FilterField label={t('Campaign')} active={!!f.campaign_id}>
          <Select value={f.campaign_id} onChange={(campaign_id) => setF({ ...f, campaign_id })} placeholder={t('All campaigns')} options={(camps.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))} />
        </FilterField>
        <FilterField label={t('Type')} size="sm" active={!!f.type}>
          <Select value={f.type} onChange={(type) => setF({ ...f, type })} placeholder={t('All types')} options={typeOptions} />
        </FilterField>
        <FilterField label={t('Click ID')} active={!!f.click_id}>
          <input className="input mono" placeholder={t('Exact match')} value={f.click_id} onChange={(e) => setF({ ...f, click_id: e.target.value })} />
        </FilterField>
        <FilterField label={t('Sender IP')} size="sm" active={!!f.ip}>
          <input className="input mono" placeholder={t('Exact match')} value={f.ip} onChange={(e) => setF({ ...f, ip: e.target.value })} />
        </FilterField>
        <FilterField label={t('Postback parameter')} size="lg">
          <form
            className="ff-pair"
            onSubmit={(e) => {
              e.preventDefault()
              if (newP.key.trim() && newP.value !== '') {
                addParam(newP.key.trim(), newP.value)
                setNewP({ key: '', value: '' })
              }
            }}
          >
            <input className="input mono" list="conv-param-keys" placeholder={t('param')} value={newP.key} onChange={(e) => setNewP({ ...newP, key: e.target.value })} />
            <datalist id="conv-param-keys">
              {paramKeys.map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
            <span className="muted">=</span>
            <input className="input mono" placeholder={t('value')} value={newP.value} onChange={(e) => setNewP({ ...newP, value: e.target.value })} />
            <button className="btn" disabled={!newP.key.trim() || newP.value === ''}>
              {t('Add')}
            </button>
          </form>
        </FilterField>
      </FilterBar>

      <ErrorBox error={res.error} retry={res.reload} />
      <div className="card">
        <DataTable
          columns={columns}
          rows={res.data ? res.data.rows ?? [] : undefined}
          rowKey={(r, i) => String(r.conv_id ?? i)}
          loading={res.loading}
          maxHeight="calc(100vh - 270px)"
          expand={(r) => <ConvDetail r={r} campaign={campName(r.campaign_id)} keyName={keyName} stages={stagesOf(r.campaign_id)} currency={campById(r.campaign_id)?.currency} />}
          empty={<Empty title={t('No conversions for this selection')}>{t('Check the date range and filters, or look at the postback log: it lists every request received, including the refused ones.')}</Empty>}
        />
        <Pagination total={res.data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />
      </div>
    </>
  )
}

/** Everything one event carried, and where it sits in the journey of its click. */
function ConvDetail({ r, campaign, keyName, stages, currency }: { r: ConvRow; campaign: string; keyName: (id: unknown) => string; stages: Stage[]; currency?: string }) {
  const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))
  const item = (label: string, value: ReactNode, mono?: boolean) => (
    <>
      <dt>{label}</dt>
      <dd className={mono ? 'mono break' : 'break'}>{value === '' || value === undefined || value === null ? <span className="muted">—</span> : value}</dd>
    </>
  )
  const clickId = str(r.click_id)
  const after = clickId ? secondsBetween(r.click_ts, r.ts) : null
  const stage = stages.find((s) => s.key === r.type)
  const subs = [1, 2, 3, 4, 5].map((n) => [`sub${n}`, str(r[`sub${n}`])] as const).filter(([, v]) => v)
  const params = Object.keys(r.params ?? {}).length ? JSON.stringify(r.params, null, 2) : ''

  // The click log, narrowed to this click: its id plus the minute it happened in.
  const at = Math.floor(new Date(str(r.click_ts)).getTime() / 1000)
  const clickLink = new URLSearchParams({ click_id: clickId })
  if (Number(r.campaign_id) > 0) clickLink.set('campaign_id', str(r.campaign_id))
  if (at > 86400) {
    clickLink.set('from', String(at - 60))
    clickLink.set('to', String(at + 60))
  }

  return (
    <div className="detail">
      {clickId ? (
        <div className="detail-actions">
          <Link className="btn small" to={'/clicks?' + clickLink.toString()} title={t('Every field recorded for the click this event belongs to')}>
            {t('Open the click')}
          </Link>
        </div>
      ) : (
        <div className="field-help" style={{ margin: '0 0 12px' }}>
          {t('This event is not attributed to a click, so it has no journey and does not count in a funnel.')}
        </div>
      )}
      <div className="detail-cols">
        <dl className="kv">
          {item(t('Conversion ID'), <span className="row gap-s">{str(r.conv_id)} <CopyButton text={str(r.conv_id)} className="icon-btn" /></span>, true)}
          {item(t('Time'), fmtDateTime(r.ts))}
          {item(t('Type'), str(r.type), true)}
          {item(t('Funnel stage'), stage ? `${stage.name}${stage.goal ? ' ★' : ''}` : '')}
          {item(t('Counts as a conversion'), num(r.goal) ? t('yes') : t('no'))}
          {item(t('Revenue'), num(r.revenue) ? fmtMoney(r.revenue, str(r.currency)) : '')}
          {item(t('Cost'), num(r.cost) ? fmtMoney(r.cost) : '')}
        </dl>
        <dl className="kv">
          {item(t('Key'), keyName(r.key_id))}
          {item(t('Sender IP'), str(r.sender_ip), true)}
          {item(t('Campaign'), Number(r.campaign_id) ? `${campaign} (#${str(r.campaign_id)})` : '')}
          {item(t('Stream ID'), Number(r.stream_id) ? str(r.stream_id) : '')}
          {item(t('Click ID'), clickId, true)}
          {item(t('Click time'), clickId ? fmtDateTime(r.click_ts) : '')}
          {item(t('After the click'), after === null ? '' : fmtSpan(after))}
          {item(t('Click flagged as bot'), clickId ? num(r.is_bot) ? <Badge tone="err">{t('yes')}</Badge> : t('no') : '')}
        </dl>
        <dl className="kv">
          {item(t('Domain'), str(r.domain), true)}
          {item(t('Country'), r.country ? <Country code={str(r.country)} show="both" /> : '')}
          {item(t('City'), str(r.city))}
          {item(t('Device'), r.device_type ? <Device type={str(r.device_type)} /> : '')}
          {item(t('OS'), r.os ? <Os os={str(r.os)} /> : '')}
          {item(t('Browser'), r.browser ? <Browser browser={str(r.browser)} /> : '')}
          {subs.map(([k, v]) => (
            <span key={k} style={{ display: 'contents' }}>
              {item(k, v, true)}
            </span>
          ))}
        </dl>
        <dl className="kv wide">{item(t('Postback parameters'), params ? <pre className="params-json">{params}</pre> : '')}</dl>
      </div>
      {clickId && <Journey clickId={clickId} clickTs={r.click_ts} campaignId={Number(r.campaign_id)} stages={stages} currency={currency} keyName={keyName} current={str(r.conv_id)} />}
    </div>
  )
}
