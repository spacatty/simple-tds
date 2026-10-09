import { useEffect, useMemo, useState } from 'react'
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { del, errMsg, get, post, put } from '../api'
import { canEdit, useApp, useLoad } from '../hooks'
import type { Campaign, Row, SuppressRule } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { Card, Empty, ErrorBox, Field, Modal, MultiSelect, PageHeader, Pagination, SearchInput, Segmented, Select, confirmDialog, toast, useBusy } from '../components/ui'
import { fmtAgo, fmtDateTime, fmtInt, num } from '../format'
import { t, tn, tx } from '../i18n'

type Kind = 'ip' | 'referer'
type Store = 'off' | 'count' | 'log'

const LOG_LIMIT = 100
// A user can keep thousands of rules; the table shows this many of the ones that match the search.
const SHOWN = 500
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))

const TEXT = {
  ip: {
    title: t('Suppress IPs'),
    sub: t('Requests from these addresses never reach your campaigns: they get a 404 and stay out of clicks, uniqueness and every report.'),
    entry: t('Address or network'),
    add: t('Add addresses'),
    addHelp: t('One IP address or CIDR network per line, IPv4 or IPv6.'),
    placeholder: '203.0.113.7\n198.51.100.0/24\n2001:db8::/32',
    empty: t('No suppressed addresses'),
    emptyHelp: t('Add your own office, monitoring services or anyone else whose visits should not count as traffic.'),
  },
  referer: {
    title: t('Suppress referrers'),
    sub: t('Requests arriving from these sites never reach your campaigns: they get a 404 and stay out of clicks, uniqueness and every report.'),
    entry: t('Referrer domain'),
    add: t('Add referrers'),
    addHelp: t('One domain per line. A domain also covers its subdomains: example.com suppresses www.example.com and m.example.com.'),
    placeholder: 'example.com\nspam-traffic.net',
    empty: t('No suppressed referrers'),
    emptyHelp: t('Add the sites whose visitors should not count as traffic.'),
  },
}

const STORES: { value: Store; label: string }[] = [
  { value: 'count', label: t('Counter only') },
  { value: 'log', label: t('Counter and request log') },
  { value: 'off', label: t('Nothing') },
]
const storeHelp = () => t('A counter costs one number per entry and day. The request log also keeps the time, address, referrer, domain, campaign and User-Agent of each request. Everything is deleted after the data retention period.')

interface Entry extends SuppressRule {
  week: number
  total: number
  last: unknown
}

/** The viewer's suppress rules of one kind: sources whose requests are refused before they become clicks. */
export default function Suppress({ kind }: { kind: Kind }) {
  const text = TEXT[kind]
  const { user } = useApp()
  const rules = useLoad(() => get<SuppressRule[]>('suppress-rules'), [])
  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])
  const stats = useLoad(() => get<Row[] | null>(`suppress/${kind}/stats`), [kind])
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<SuppressRule | 'new' | null>(null)
  const [offset, setOffset] = useState(0)
  const [busy, run] = useBusy()
  const log = useLoad(() => get<{ rows: Row[] | null; total: number }>(`suppress/${kind}/log`, { limit: LOG_LIMIT, offset }), [kind, offset])
  useEffect(() => {
    setSearch('')
    setOffset(0)
  }, [kind])

  // Rules are personal: an administrator's list holds their own, like everyone else's.
  const entries: Entry[] = useMemo(() => {
    const byRule = new Map((stats.data ?? []).map((r) => [num(r.rule_id), r]))
    return (rules.data ?? [])
      .filter((r) => r.kind === kind && r.owner_id === user.id)
      .map((r) => {
        const s = byRule.get(r.id)
        return { ...r, week: num(s?.week), total: num(s?.total), last: s?.last }
      })
  }, [rules.data, stats.data, kind, user.id])
  const found = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? entries.filter((e) => e.value.includes(q)) : entries
  }, [entries, search])

  const campName = (id: unknown) => camps.data?.find((c) => c.id === Number(id))?.name ?? `#${str(id)}`
  const refresh = () => {
    stats.reload()
    log.reload()
  }
  const remove = (e: Entry) =>
    run(async () => {
      try {
        await del(`suppress-rules/${e.id}`)
        rules.setData((all) => all?.filter((r) => r.id !== e.id))
        toast.ok(t('{name} is no longer suppressed', { name: e.value }))
      } catch (err) {
        toast.err(err)
      }
    })
  const clear = async () => {
    if (!(await confirmDialog({ title: t('Clear the numbers?'), message: t('The counters and the request log of this list will be deleted. The list itself stays.'), danger: true, confirmLabel: t('Clear') }))) return
    run(async () => {
      try {
        await post(`suppress/${kind}/clear`)
        toast.ok(t('Numbers cleared'))
        setOffset(0)
        refresh()
      } catch (err) {
        toast.err(err)
      }
    })
  }

  const setStore = async (e: Entry, store: Store) => {
    // The choice shows at once and goes back if the server refuses.
    const swap = (s: Store) => rules.setData((all) => all?.map((r) => (r.id === e.id ? { ...r, store: s } : r)))
    swap(store)
    try {
      await put(`suppress-rules/${e.id}`, { store })
    } catch (err) {
      swap(e.store)
      toast.err(err)
    }
  }
  // The log card stays while there is something to show, even after the last logging rule is gone.
  const logging = entries.some((e) => e.store === 'log') || (log.data?.total ?? 0) > 0

  const scope = (e: SuppressRule) => {
    const ids = e.campaign_ids ?? []
    if (ids.length === 0) return <span className="muted">{t('All my campaigns')}</span>
    const names = ids.map(campName)
    return (
      <span className="ellipsis" style={{ maxWidth: 320, display: 'inline-block', verticalAlign: 'bottom' }} title={names.join(', ')}>
        {names.join(', ')}
      </span>
    )
  }
  const columns: Column<Entry>[] = [
    { key: 'value', title: text.entry, sort: (e) => e.value, render: (e) => <span className="mono">{e.value}</span> },
    { key: 'scope', title: t('Applies to'), sort: (e) => (e.campaign_ids ?? []).length, render: scope },
    { key: 'store', title: t('What is kept'), width: 230, headTitle: storeHelp(), render: (e) => <Select value={e.store} onChange={(v) => setStore(e, v as Store)} options={STORES} /> },
    { key: 'week', title: t('Requests, 7 days'), align: 'right', sort: (e) => e.week, render: (e) => (e.store === 'off' && !e.total ? <span className="muted">—</span> : fmtInt(e.week)) },
    { key: 'total', title: t('Requests, total'), align: 'right', sort: (e) => e.total, render: (e) => (e.store === 'off' && !e.total ? <span className="muted">—</span> : fmtInt(e.total)) },
    { key: 'last', title: t('Last request'), sort: (e) => str(e.last), render: (e) => (e.total ? <span title={fmtDateTime(e.last)}>{fmtAgo(e.last)}</span> : <span className="muted">—</span>) },
    {
      key: 'actions',
      title: '',
      align: 'right',
      width: 90,
      render: (e) => (
        <div className="row-actions">
          <button className="icon-btn" title={t('Edit')} onClick={() => setEditing(e)}>
            <Pencil size={15} />
          </button>
          <button className="icon-btn danger" title={t('Remove from the list')} disabled={busy} onClick={() => remove(e)}>
            <Trash2 size={15} />
          </button>
        </div>
      ),
    },
  ]

  const dash = <span className="muted">—</span>
  const clipped = (v: unknown, width: number) =>
    v ? (
      <span className="ellipsis" style={{ maxWidth: width, display: 'inline-block', verticalAlign: 'bottom' }} title={str(v)}>
        {str(v)}
      </span>
    ) : (
      dash
    )
  const logColumns: Column<Row>[] = [
    { key: 'ts', title: t('Time'), render: (r) => <span className="nowrap">{fmtDateTime(r.ts)}</span> },
    { key: 'rule', title: t('Matched entry'), render: (r) => <span className="mono">{str(r.rule)}</span> },
    { key: 'ip', title: t('IP address'), render: (r) => <span className="mono">{str(r.ip)}</span> },
    { key: 'referer', title: t('Referrer'), render: (r) => clipped(r.referer, 320) },
    { key: 'domain', title: t('Domain'), render: (r) => str(r.domain) || dash },
    { key: 'campaign', title: t('Campaign'), render: (r) => (Number(r.campaign_id) ? <span className="ellipsis cell-w">{campName(r.campaign_id)}</span> : dash) },
    { key: 'ua', title: 'User-Agent', render: (r) => clipped(r.ua, 360) },
  ]

  return (
    <div className="page">
      <PageHeader title={text.title} sub={text.sub}>
        <button className="btn" onClick={refresh} title={t('Refresh')} aria-label={t('Refresh')}>
          <RefreshCw size={14} className={stats.loading ? 'spin' : ''} />
        </button>
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Plus size={15} /> {text.add}
        </button>
      </PageHeader>
      <ErrorBox error={rules.error} retry={rules.reload} />
      <ErrorBox error={stats.error} retry={stats.reload} />

      <div className="stack">
        <div className="card">
          <div className="toolbar wrap" style={{ padding: '12px 16px 0' }}>
            <SearchInput value={search} onChange={setSearch} />
            <span className="muted grow">
              {found.length > SHOWN
                ? t('Showing {shown} of {total} — search to narrow the list', { shown: fmtInt(SHOWN), total: fmtInt(found.length) })
                : tn(entries.length, '{count} entry', '{count} entries', { count: fmtInt(entries.length) })}
            </span>
            <button className="btn small ghost" disabled={busy} onClick={clear}>
              {t('Clear the numbers')}
            </button>
          </div>
          <DataTable
            columns={columns}
            rows={rules.data ? found.slice(0, SHOWN) : undefined}
            rowKey={(e) => e.id}
            loading={rules.loading}
            maxHeight="calc(100vh - 300px)"
            empty={<Empty title={entries.length ? t('Nothing matches the search') : text.empty}>{entries.length ? undefined : text.emptyHelp}</Empty>}
          />
        </div>

        {logging && (
          <Card title={t('Recent suppressed requests')} pad={false}>
            <ErrorBox error={log.error} retry={log.reload} />
            <DataTable
              columns={logColumns}
              rows={log.data ? log.data.rows ?? [] : undefined}
              rowKey={(r, i) => `${str(r.ts)}|${i}`}
              loading={log.loading}
              empty={<Empty title={t('No suppressed requests yet')}>{t('Requests refused by the entries that keep a request log appear here a second or two later.')}</Empty>}
            />
            <Pagination total={log.data?.total ?? 0} limit={LOG_LIMIT} offset={offset} onChange={setOffset} />
          </Card>
        )}
      </div>

      {editing && (
        <RuleEditor
          kind={kind}
          rule={editing === 'new' ? null : editing}
          campaigns={camps.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            rules.reload()
          }}
        />
      )}
    </div>
  )
}

/** Adds rules in bulk, or changes which campaigns an existing rule applies to. */
function RuleEditor({ kind, rule, campaigns, onClose, onSaved }: { kind: Kind; rule: SuppressRule | null; campaigns: Campaign[]; onClose: () => void; onSaved: () => void }) {
  const text = TEXT[kind]
  const [values, setValues] = useState('')
  const [ids, setIds] = useState<string[]>((rule?.campaign_ids ?? []).map(String))
  const [scope, setScope] = useState<'all' | 'some'>(ids.length ? 'some' : 'all')
  const [store, setStore] = useState<Store>(rule?.store ?? 'count')
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const lines = values.split(/[\s,;]+/).filter(Boolean).length
  // Campaigns the rule may be pointed at, plus the ones it already names.
  const options = campaigns.filter((c) => canEdit(c) || ids.includes(String(c.id))).map((c) => ({ value: String(c.id), label: c.name }))
  const ready = (rule || lines > 0) && (scope === 'all' || ids.length > 0)

  const save = () =>
    run(async () => {
      setError('')
      const campaign_ids = scope === 'all' ? [] : ids.map(Number)
      try {
        if (rule) {
          await put(`suppress-rules/${rule.id}`, { campaign_ids, store })
          toast.ok(t('Saved'))
        } else {
          const res = await post<{ added: number }>('suppress-rules/bulk', { kind, values, campaign_ids, store })
          toast.ok(tn(res.added, '{count} entry added', '{count} entries added', { count: fmtInt(res.added) }))
        }
        onSaved()
      } catch (e) {
        setError(errMsg(e))
      }
    })

  return (
    <Modal
      title={rule ? rule.value : text.add}
      onClose={onClose}
      footer={
        <>
          {error && <div className="field-error grow">{error}</div>}
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !ready} onClick={save}>
            {busy ? t('Saving…') : rule ? t('Save') : t('Add')}
          </button>
        </>
      }
    >
      <div className="stack">
        {!rule && (
          <Field help={text.addHelp}>
            <textarea className="input mono" rows={8} autoFocus spellCheck={false} value={values} onChange={(e) => setValues(e.target.value)} placeholder={text.placeholder} />
          </Field>
        )}
        <Field label={t('Applies to')} help={scope === 'all' ? t('Every campaign you own, including the ones you create later.') : t('Only the campaigns picked here. You can pick any campaign you are allowed to edit.')}>
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: t('All my campaigns') },
              { value: 'some', label: t('Only selected') },
            ]}
          />
        </Field>
        {scope === 'some' && (
          <Field>
            <MultiSelect values={ids} onChange={setIds} options={options} placeholder={t('Pick campaigns…')} chipLabel={(v) => options.find((o) => o.value === v)?.label ?? `#${v}`} />
          </Field>
        )}
        <Field label={t('What is kept about suppressed requests')} help={storeHelp()}>
          <Select value={store} onChange={(v) => setStore(v as Store)} options={STORES} />
        </Field>
        {!rule && kind === 'ip' && <p className="muted small">{tx('Requests already recorded as clicks stay in the reports. To remove them, use <b>Delete data by IP</b> in the campaign.', { b: (c) => <b>{c}</b> })}</p>}
      </div>
    </Modal>
  )
}
