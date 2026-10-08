import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Columns3, Download, Filter as FilterIcon, RefreshCw, X } from 'lucide-react'
import { get, qs } from '../api'
import type { Params } from '../api'
import { useDebounced, useLoad, useMeta } from '../hooks'
import type { Campaign, ConvKey, ConvRow } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { DateRangePicker, useDateRange } from '../components/DateRangePicker'
import { Badge, Dropdown, Empty, ErrorBox, PageHeader, Pagination, Select, Tabs } from '../components/ui'
import type { Tone } from '../components/ui'
import { rangeParams } from '../reports'
import { fmtDateTime, fmtMoney, humanize } from '../format'
import { countryLabel } from '../countries'
import ConvKeys from './ConvKeys'

type Tab = 'log' | 'keys'

export default function Conversions() {
  const params = useParams()
  const nav = useNavigate()
  const tab: Tab = params.tab === 'keys' ? 'keys' : 'log'
  return (
    <div className="page">
      <PageHeader title="Conversions" sub="Postbacks received from affiliate networks, apps and installers." />
      <Tabs
        value={tab}
        onChange={(t) => nav(t === 'log' ? '/conversions' : '/conversions/keys', { replace: true })}
        tabs={[
          { value: 'log', label: 'Log' },
          { value: 'keys', label: 'Keys & postback URLs' },
        ]}
      />
      {tab === 'log' ? <ConvLog /> : <ConvKeys />}
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
  { key: 'ts', label: 'Time', def: true },
  { key: 'type', label: 'Type', def: true },
  { key: 'key_id', label: 'Key', def: true },
  { key: 'campaign_id', label: 'Campaign', def: true },
  { key: 'click_id', label: 'Click ID', def: true },
  { key: 'revenue', label: 'Revenue', def: true },
  { key: 'cost', label: 'Cost', def: false },
  { key: 'currency', label: 'Currency', def: true },
  { key: 'sender_ip', label: 'Sender IP', def: true },
  { key: 'country', label: 'Country', def: true },
  { key: 'city', label: 'City', def: false },
  { key: 'device_type', label: 'Device', def: false },
  { key: 'os', label: 'OS', def: false },
  { key: 'browser', label: 'Browser', def: false },
  { key: 'domain', label: 'Domain', def: false },
  { key: 'stream_id', label: 'Stream ID', def: false },
  { key: 'sub1', label: 'Sub1', def: false },
  { key: 'sub2', label: 'Sub2', def: false },
  { key: 'sub3', label: 'Sub3', def: false },
  { key: 'sub4', label: 'Sub4', def: false },
  { key: 'sub5', label: 'Sub5', def: false },
  { key: 'conv_id', label: 'Conversion ID', def: false },
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
  const [f, setF] = useState({ key_id: '', campaign_id: '', type: '', click_id: '', ip: '' })
  const [pf, setPf] = useState<Record<string, string>>({})
  const [offset, setOffset] = useState(0)
  const [cols, setCols] = useState<Record<string, boolean>>(loadCols)
  const [newP, setNewP] = useState({ key: '', value: '' })
  const text = useDebounced({ click_id: f.click_id.trim(), ip: f.ip.trim() }, 400)

  const keys = useLoad(() => get<ConvKey[]>('conversion-keys'), [])
  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])

  const query: Params = useMemo(() => {
    const p: Params = { ...rangeParams(range), key_id: f.key_id, campaign_id: f.campaign_id, type: f.type, click_id: text.click_id, ip: text.ip }
    for (const [k, v] of Object.entries(pf)) p['p.' + k] = v
    return p
  }, [range, f.key_id, f.campaign_id, f.type, text, pf])
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
  const campName = (id: unknown) => camps.data?.find((c) => c.id === Number(id))?.name ?? (Number(id) ? `#${id}` : '—')

  const cell = (key: string, r: ConvRow) => {
    const v = r[key]
    switch (key) {
      case 'ts':
        return <span className="nowrap">{fmtDateTime(v)}</span>
      case 'type':
        return <Badge tone={TYPE_TONE[String(v)] ?? 'neutral'}>{String(v)}</Badge>
      case 'key_id':
        return keyName(v)
      case 'campaign_id':
        return campName(v)
      case 'click_id':
        return v ? (
          <button className="link mono" title="Filter by this click" onClick={() => setF((x) => ({ ...x, click_id: String(v) }))}>
            {String(v)}
          </button>
        ) : (
          <span className="muted" title="Not attributed to a click">
            —
          </span>
        )
      case 'revenue':
      case 'cost':
        return fmtMoney(v)
      case 'sender_ip':
        return (
          <button className="link mono" title="Filter by this sender" onClick={() => setF((x) => ({ ...x, ip: String(v) }))}>
            {String(v)}
          </button>
        )
      case 'country':
        return v ? countryLabel(String(v)) : <span className="muted">—</span>
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
          headTitle: `Postback parameter “${k}”`,
          render: (r) => {
            const v = r.params?.[k]
            if (v === undefined || v === '') return <span className="muted">—</span>
            return (
              <button className="link ellipsis" style={{ maxWidth: 220 }} title={`${v}\nClick to filter by ${k}=${v}`} onClick={() => addParam(k, v)}>
                {v}
              </button>
            )
          },
        }),
      ),
  ]

  const csvHref = 'api/conversions' + qs({ format: 'csv', ...query })
  const activeFilters = Object.entries(pf)

  return (
    <>
      <div className="toolbar wrap">
        <DateRangePicker value={range} onChange={setRange} />
        <span className="grow" />
        <button className="btn" onClick={() => res.reload()} title="Refresh">
          <RefreshCw size={14} className={res.loading ? 'spin' : ''} />
        </button>
        <Dropdown
          align="right"
          label={
            <>
              <Columns3 size={14} /> Columns
            </>
          }
        >
          {() => (
            <div className="menu menu-scroll">
              <div className="menu-title">Fixed</div>
              {FIXED.map((c) => (
                <label className="menu-item" key={c.key}>
                  <input type="checkbox" checked={visible(c.key, c.def)} onChange={() => toggleCol(c.key, c.def)} /> {c.label}
                </label>
              ))}
              {paramKeys.length > 0 && <div className="menu-title">Postback parameters</div>}
              {paramKeys.map((k) => (
                <label className="menu-item" key={k}>
                  <input type="checkbox" checked={visible('p.' + k, true)} onChange={() => toggleCol('p.' + k, true)} /> {k}
                </label>
              ))}
            </div>
          )}
        </Dropdown>
        <a className="btn" href={csvHref} download title="Download every matching row (not just this page) as CSV">
          <Download size={14} /> Download CSV
        </a>
      </div>

      <div className="toolbar wrap">
        <Select value={f.key_id} onChange={(key_id) => setF({ ...f, key_id })} placeholder="All keys" options={(keys.data ?? []).map((k) => ({ value: String(k.id), label: k.name }))} />
        <Select value={f.campaign_id} onChange={(campaign_id) => setF({ ...f, campaign_id })} placeholder="All campaigns" options={(camps.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))} />
        <Select value={f.type} onChange={(type) => setF({ ...f, type })} placeholder="All types" options={meta.conversion_types.map((t) => ({ value: t, label: humanize(t) }))} />
        <input className="input mono" style={{ width: 220 }} placeholder="Click ID" value={f.click_id} onChange={(e) => setF({ ...f, click_id: e.target.value })} />
        <input className="input mono" style={{ width: 150 }} placeholder="Sender IP" value={f.ip} onChange={(e) => setF({ ...f, ip: e.target.value })} />
        <form
          className="param-filter"
          onSubmit={(e) => {
            e.preventDefault()
            if (newP.key.trim() && newP.value !== '') {
              addParam(newP.key.trim(), newP.value)
              setNewP({ key: '', value: '' })
            }
          }}
        >
          <FilterIcon size={14} />
          <input className="input mono" list="conv-param-keys" placeholder="param" value={newP.key} onChange={(e) => setNewP({ ...newP, key: e.target.value })} style={{ width: 110 }} />
          <datalist id="conv-param-keys">
            {paramKeys.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
          <span className="muted">=</span>
          <input className="input mono" placeholder="value" value={newP.value} onChange={(e) => setNewP({ ...newP, value: e.target.value })} style={{ width: 120 }} />
          <button className="btn small" disabled={!newP.key.trim() || newP.value === ''}>
            Add
          </button>
        </form>
      </div>

      {(activeFilters.length > 0 || f.click_id || f.ip) && (
        <div className="active-filters">
          {f.click_id && (
            <span className="chip">
              click_id = {f.click_id}
              <button onClick={() => setF({ ...f, click_id: '' })} aria-label="Remove filter">
                <X size={12} />
              </button>
            </span>
          )}
          {f.ip && (
            <span className="chip">
              sender_ip = {f.ip}
              <button onClick={() => setF({ ...f, ip: '' })} aria-label="Remove filter">
                <X size={12} />
              </button>
            </span>
          )}
          {activeFilters.map(([k, v]) => (
            <span className="chip accent" key={k}>
              p.{k} = {v}
              <button
                aria-label="Remove filter"
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
          <button
            className="btn small ghost"
            onClick={() => {
              setPf({})
              setF({ ...f, click_id: '', ip: '' })
            }}
          >
            Clear
          </button>
        </div>
      )}

      <ErrorBox error={res.error} retry={res.reload} />
      <div className="card">
        <DataTable
          columns={columns}
          rows={res.data ? res.data.rows ?? [] : undefined}
          rowKey={(r, i) => String(r.conv_id ?? i)}
          loading={res.loading}
          maxHeight="calc(100vh - 330px)"
          empty={<Empty title="No conversions for this selection">Check the date range and filters, or look at rejected postbacks on the Keys tab.</Empty>}
        />
        <Pagination total={res.data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />
      </div>
    </>
  )
}
