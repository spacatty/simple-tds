import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { get } from '../api'
import type { Params } from '../api'
import { useDebounced, useLoad, useMeta } from '../hooks'
import type { Campaign, ConvKey, Row } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { DateRangePicker, currentRange, rememberRange } from '../components/DateRangePicker'
import type { DateRange } from '../components/DateRangePicker'
import { Badge, CopyButton, Empty, ErrorBox, FilterBar, FilterField, PageHeader, Pagination, Select } from '../components/ui'
import type { Tone } from '../components/ui'
import { rangeApiParams, rangeFromSearch, writeRange } from '../filters'
import { fmtDateTime, fmtMoney, humanize, num } from '../format'
import { stageName } from '../components/Journey'
import { t, ts } from '../i18n'

const LIMIT = 100
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))

const STATUS: { value: string; label: string; tone: Tone; help: string }[] = [
  { value: 'ok', label: t('Accepted'), tone: 'ok', help: t('A conversion was stored.') },
  { value: 'duplicate', label: t('Duplicate'), tone: 'warn', help: t('The click already had an event of this type, so nothing was stored.') },
  { value: 'rejected', label: t('Refused'), tone: 'err', help: t('The request was refused; the reason says why.') },
  { value: 'failed', label: t('Not stored'), tone: 'err', help: t('The request was valid, but the conversion could not be saved and the sender was asked to retry.') },
]
const statusOf = (v: unknown) => STATUS.find((s) => s.value === str(v))

// Filters that are typed rather than picked.
const TEXT = ['ip', 'click_id', 'q'] as const
type TextKey = (typeof TEXT)[number]

/** Every request the postback URL received and what became of it, newest first. */
export default function PostbackLog() {
  const meta = useMeta()
  const [sp, setSp] = useSearchParams()
  const spKey = sp.toString()
  const [offset, setOffset] = useState(0)

  // Filters live in the URL so a key or a conversion can link to its postbacks.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const range = useMemo(() => rangeFromSearch(sp, currentRange()), [spKey])
  const url = (k: string) => sp.get(k) ?? ''
  const keyId = url('key_id')
  const campaignId = url('campaign_id')
  const status = url('status')
  const type = url('type')
  const urlText: Record<TextKey, string> = { ip: url('ip'), click_id: url('click_id'), q: url('q') }

  const update = (fn: (n: URLSearchParams) => void, replace = false) => {
    const n = new URLSearchParams(sp)
    fn(n)
    setSp(n, { replace })
  }
  const setParam = (k: string, v: string) =>
    update((n) => {
      n.delete(k)
      if (v !== '') n.set(k, v)
    })
  const setRange = (r: DateRange) => {
    rememberRange(r)
    update((n) => writeRange(n, r))
  }

  // Free-text fields are typed locally and pushed to the URL once the user pauses.
  const [text, setText] = useState(urlText)
  useEffect(() => setText({ ip: urlText.ip, click_id: urlText.click_id, q: urlText.q }), [urlText.ip, urlText.click_id, urlText.q])
  const debounced = useDebounced(text, 400)
  useEffect(() => {
    if (TEXT.some((k) => debounced[k].trim() !== urlText[k])) {
      update((n) => {
        for (const k of TEXT) {
          n.delete(k)
          if (debounced[k].trim()) n.set(k, debounced[k].trim())
        }
      }, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced])

  const keys = useLoad(() => get<ConvKey[]>('conversion-keys'), [])
  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])

  const query: Params = useMemo(
    () => ({ ...rangeApiParams(range), key_id: keyId, campaign_id: campaignId, status, type, ip: urlText.ip, click_id: urlText.click_id, q: urlText.q }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, keyId, campaignId, status, type, urlText.ip, urlText.click_id, urlText.q],
  )
  const queryKey = JSON.stringify(query)
  useEffect(() => setOffset(0), [queryKey])

  const res = useLoad(() => get<{ rows: Row[] | null; total: number }>('postbacks', { ...query, limit: LIMIT, offset }), [queryKey, offset])

  const campById = (id: unknown) => camps.data?.find((c) => c.id === Number(id))
  const campName = (id: unknown) => campById(id)?.name ?? (Number(id) ? `#${id}` : '')
  const keyById = (id: unknown) => keys.data?.find((k) => k.id === Number(id))
  // Built-in types plus the funnel stages of the campaigns in view.
  const typeOptions = useMemo(() => {
    const stages = (camps.data ?? []).filter((c) => !campaignId || String(c.id) === campaignId).flatMap((c) => c.stages ?? [])
    const extra = new Set(stages.map((s) => s.key).filter((k) => !meta.conversion_types.includes(k)))
    return [...meta.conversion_types.map((ty) => ({ value: ty, label: ts(humanize(ty)) })), ...[...extra].sort().map((k) => ({ value: k, label: k }))]
  }, [camps.data, campaignId, meta.conversion_types])

  const keyCell = (r: Row) => {
    const k = keyById(r.key_id)
    if (k) return <span className="strong nowrap">{k.name}</span>
    if (Number(r.key_id)) return <span title={t('This key has been deleted')}>#{str(r.key_id)}</span>
    return r.key_prefix ? (
      <span className="nowrap" title={t('No key with this value exists (prefix shown)')}>
        <code>{str(r.key_prefix)}…</code> <span className="muted small">{t('unknown')}</span>
      </span>
    ) : (
      <span className="muted">{t('none')}</span>
    )
  }
  const pick = (k: string, v: unknown, title: string) => (
    <button
      className="link mono"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        setParam(k, str(v))
      }}
    >
      {str(v)}
    </button>
  )
  const dash = <span className="muted">—</span>

  const columns: Column<Row>[] = [
    { key: 'ts', title: t('Time'), render: (r) => <span className="nowrap">{fmtDateTime(r.ts)}</span> },
    {
      key: 'status',
      title: t('Result'),
      render: (r) => {
        const s = statusOf(r.status)
        return (
          <Badge tone={s?.tone ?? 'neutral'} title={`${s?.help ?? ''} HTTP ${str(r.http_status)}`.trim()}>
            {s?.label ?? str(r.status)}
          </Badge>
        )
      },
    },
    { key: 'key', title: t('Key'), render: keyCell },
    { key: 'type', title: t('Type'), render: (r) => (r.type ? <span className="nowrap" title={str(r.type)}>{stageName(campById(r.campaign_id)?.stages, str(r.type))}</span> : dash) },
    { key: 'campaign', title: t('Campaign'), render: (r) => (Number(r.campaign_id) ? <span className="ellipsis cell-w">{campName(r.campaign_id)}</span> : dash) },
    { key: 'click_id', title: t('Click ID'), render: (r) => (r.click_id ? <span className="ellipsis cell-w">{pick('click_id', r.click_id, t('Filter by this click'))}</span> : dash) },
    { key: 'sender_ip', title: t('Sender IP'), render: (r) => pick('ip', r.sender_ip, t('Filter by this sender')) },
    {
      key: 'details',
      title: t('Reason / parameters'),
      render: (r) => (
        <span className="ellipsis" style={{ maxWidth: 420, display: 'inline-block', verticalAlign: 'bottom' }} title={str(r.query)}>
          {r.reason ? <b>{ts(str(r.reason))}</b> : null}
          {r.reason && r.query ? ' · ' : null}
          <span className="mono small">{str(r.query)}</span>
        </span>
      ),
    },
  ]

  const anyFilter = !!(status || keyId || campaignId || type || urlText.ip || urlText.click_id || urlText.q)
  const resetFilters = () => {
    setText({ ip: '', click_id: '', q: '' })
    update((n) => ['status', 'key_id', 'campaign_id', 'type', ...TEXT].forEach((k) => n.delete(k)))
  }

  return (
    <>
      <PageHeader title={t('Postback log')} sub={t('Every request to the postback URL and what became of it. Click a row for the full request.')}>
        <DateRangePicker value={range} onChange={setRange} />
        <button className="btn" onClick={() => res.reload()} title={t('Refresh')} aria-label={t('Refresh')}>
          <RefreshCw size={14} className={res.loading ? 'spin' : ''} />
        </button>
      </PageHeader>

      <FilterBar onReset={anyFilter ? resetFilters : undefined}>
        <FilterField label={t('Result')} size="sm" active={!!status}>
          <Select value={status} onChange={(v) => setParam('status', v)} placeholder={t('Any result')} options={STATUS.map((s) => ({ value: s.value, label: s.label }))} />
        </FilterField>
        <FilterField label={t('Key')} active={!!keyId}>
          <Select value={keyId} onChange={(v) => setParam('key_id', v)} placeholder={t('All keys')} options={(keys.data ?? []).map((k) => ({ value: String(k.id), label: k.name }))} />
        </FilterField>
        <FilterField label={t('Campaign')} active={!!campaignId}>
          <Select value={campaignId} onChange={(v) => setParam('campaign_id', v)} placeholder={t('All campaigns')} options={(camps.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))} />
        </FilterField>
        <FilterField label={t('Type')} size="sm" active={!!type}>
          <Select value={type} onChange={(v) => setParam('type', v)} placeholder={t('All types')} options={typeOptions} />
        </FilterField>
        <FilterField label={t('Click ID')} active={!!urlText.click_id}>
          <input className="input mono" placeholder={t('Exact match')} value={text.click_id} onChange={(e) => setText({ ...text, click_id: e.target.value })} />
        </FilterField>
        <FilterField label={t('Sender IP')} size="sm" active={!!urlText.ip}>
          <input className="input mono" placeholder={t('Exact match')} value={text.ip} onChange={(e) => setText({ ...text, ip: e.target.value })} />
        </FilterField>
        <FilterField label={t('Contains')} size="lg" active={!!urlText.q}>
          <input className="input" placeholder={t('Search parameters and reasons')} value={text.q} onChange={(e) => setText({ ...text, q: e.target.value })} />
        </FilterField>
      </FilterBar>

      <ErrorBox error={res.error} retry={res.reload} />
      <div className="card">
        <DataTable
          columns={columns}
          rows={res.data ? res.data.rows ?? [] : undefined}
          rowKey={(r, i) => `${str(r.ts)}|${i}`}
          loading={res.loading}
          maxHeight="calc(100vh - 270px)"
          expand={(r) => <PostbackDetail r={r} keyCell={keyCell(r)} campaign={campName(r.campaign_id)} />}
          empty={<Empty title={t('No postbacks for this selection')}>{t('Requests appear here a second or two after they arrive. If the sender says it fired and nothing shows up, the request never reached this server: check the domain and the path of the postback URL.')}</Empty>}
        />
        <Pagination total={res.data?.total ?? 0} limit={LIMIT} offset={offset} onChange={setOffset} />
      </div>
    </>
  )
}

function PostbackDetail({ r, keyCell, campaign }: { r: Row; keyCell: ReactNode; campaign: string }) {
  const item = (label: string, value: ReactNode, mono?: boolean) => (
    <>
      <dt>{label}</dt>
      <dd className={mono ? 'mono break' : 'break'}>{value === '' || value === undefined || value === null ? <span className="muted">—</span> : value}</dd>
    </>
  )
  const s = statusOf(r.status)
  const query = str(r.query)
  const params = [...new URLSearchParams(query).entries()]
  const clickId = str(r.click_id)
  const attributed = Number(r.campaign_id) > 0

  return (
    <div className="detail">
      {r.conv_id && clickId ? (
        <div className="detail-actions">
          <Link className="btn small" to={'/conversions?' + new URLSearchParams({ click_id: clickId }).toString()} title={t('Conversions attributed to this click')}>
            {t('Conversions of this click')}
          </Link>
        </div>
      ) : null}
      <div className="detail-cols">
        <dl className="kv">
          {item(t('Time'), fmtDateTime(r.ts))}
          {item(t('Result'), s ? <Badge tone={s.tone}>{s.label}</Badge> : str(r.status))}
          {item(t('What happened'), s?.help)}
          {item(t('Reason'), ts(str(r.reason)))}
          {item(t('HTTP status answered'), str(r.http_status), true)}
        </dl>
        <dl className="kv">
          {item(t('Key'), keyCell)}
          {item(t('Sender IP'), str(r.sender_ip), true)}
          {item(t('Type'), str(r.type), true)}
          {item(t('Revenue'), num(r.revenue) ? fmtMoney(r.revenue) : '')}
          {item(t('Conversion ID'), str(r.conv_id), true)}
        </dl>
        <dl className="kv">
          {item(t('Click ID'), clickId, true)}
          {item(t('Attributed to a click'), clickId || attributed ? (attributed ? t('yes') : t('no')) : '')}
          {item(t('Campaign'), attributed ? `${campaign} (#${str(r.campaign_id)})` : '')}
          {item(t('Stream ID'), Number(r.stream_id) ? str(r.stream_id) : '')}
        </dl>
        <dl className="kv wide">
          {item(
            t('Parameters'),
            params.length ? (
              <span className="journey-params">
                {params.map(([k, v], i) => (
                  <span className="chip" key={i}>
                    <span className="muted">{k}</span> = {v}
                  </span>
                ))}
              </span>
            ) : (
              ''
            ),
          )}
          {item(
            t('As received'),
            query ? (
              <span className="row gap-s">
                {query} <CopyButton text={query} className="icon-btn" />
              </span>
            ) : (
              ''
            ),
            true,
          )}
        </dl>
      </div>
    </div>
  )
}
