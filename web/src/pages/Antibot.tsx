import { useEffect, useRef, useState } from 'react'
import { FlaskConical, Pencil, Plus, RefreshCw, Trash2, Upload } from 'lucide-react'
import { del, errMsg, get, post, put, upload } from '../api'
import { useLoad, useMeta } from '../hooks'
import type { GeoPreset, GeoStatus, IPList, Integration, IntegrationTestResult, Settings } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { Badge, Card, Chips, Empty, ErrorBox, Field, Modal, Notice, NumberInput, PageHeader, Select, Skeleton, Tabs, Toggle, confirmDialog, toast, useBusy } from '../components/ui'
import type { Tone } from '../components/ui'
import { CountrySelect } from '../components/CountrySelect'
import { fmtAgo, fmtBytes, fmtDateTime, fmtInt } from '../format'
import { flag } from '../countries'

type Tab = 'detection' | 'lists' | 'integrations' | 'geo' | 'presets'

export default function Antibot() {
  const [tab, setTab] = useState<Tab>('detection')
  return (
    <div className="page">
      <PageHeader title="Anti-bot" sub="How visitors are classified as bots or datacenter traffic, and where geo data comes from." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'detection', label: 'Detection' },
          { value: 'lists', label: 'IP lists' },
          { value: 'integrations', label: 'External integrations' },
          { value: 'geo', label: 'Geo database' },
          { value: 'presets', label: 'Geo presets' },
        ]}
      />
      {tab === 'detection' && <Detection />}
      {tab === 'lists' && <Lists />}
      {tab === 'integrations' && <Integrations />}
      {tab === 'geo' && <GeoDB />}
      {tab === 'presets' && <Presets />}
    </div>
  )
}

// ---- detection --------------------------------------------------------------

const asnCheck = (v: string) => (/^(AS)?\d{1,10}$/i.test(v) ? null : `“${v}” is not an AS number`)
const toASNs = (list: string[]) => list.map((v) => Number(v.replace(/^AS/i, ''))).filter((n) => Number.isFinite(n) && n > 0)

function Detection() {
  const res = useLoad(() => get<Settings>('settings'), [])
  const [f, setF] = useState<{
    datacenter_is_bot: boolean
    header_checks: boolean
    tls_checks: boolean
    bot_threshold: number | ''
    js_pass_hours: number | ''
    bot_asns: string[]
    datacenter_asns: string[]
    bot_ua_patterns: string
    ja3_block: string[]
    ja4_block: string[]
  } | null>(null)
  const [error, setError] = useState('')
  const [busy, run] = useBusy()

  useEffect(() => {
    const s = res.data
    if (!s) return
    setF({
      datacenter_is_bot: s.datacenter_is_bot,
      header_checks: s.header_checks,
      tls_checks: s.tls_checks,
      bot_threshold: s.bot_threshold,
      js_pass_hours: s.js_pass_hours,
      bot_asns: (s.bot_asns ?? []).map(String),
      datacenter_asns: (s.datacenter_asns ?? []).map(String),
      bot_ua_patterns: (s.bot_ua_patterns ?? []).join('\n'),
      ja3_block: s.ja3_block ?? [],
      ja4_block: s.ja4_block ?? [],
    })
  }, [res.data])

  if (!f) return res.error ? <ErrorBox error={res.error} retry={res.reload} /> : <Skeleton rows={8} height={18} />
  const set = (p: Partial<NonNullable<typeof f>>) => setF((x) => (x ? { ...x, ...p } : x))

  const save = () =>
    run(async () => {
      setError('')
      try {
        const s = await put<Settings>('settings', {
          datacenter_is_bot: f.datacenter_is_bot,
          header_checks: f.header_checks,
          tls_checks: f.tls_checks,
          bot_threshold: f.bot_threshold === '' ? 100 : f.bot_threshold,
          js_pass_hours: f.js_pass_hours === '' ? 24 : f.js_pass_hours,
          bot_asns: toASNs(f.bot_asns),
          datacenter_asns: toASNs(f.datacenter_asns),
          bot_ua_patterns: f.bot_ua_patterns
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean),
          ja3_block: f.ja3_block,
          ja4_block: f.ja4_block,
        })
        res.setData(s)
        toast.ok('Detection settings saved')
      } catch (e) {
        setError(errMsg(e))
      }
    })

  return (
    <div className="stack">
      <Card title="Signals">
        <div className="form-grid">
          <Field help="Visitors from hosting, VPN and proxy networks (datacenter IP lists and ASNs below) are flagged as bots, not just as “datacenter”. Turn off to only mark them, and route them yourself with the Datacenter filter.">
            <Toggle checked={f.datacenter_is_bot} onChange={(datacenter_is_bot) => set({ datacenter_is_bot })} label="Treat datacenter / VPN traffic as bots" />
          </Field>
          <Field help="Compare the request headers with what the claimed browser really sends (missing or inconsistent headers add to the bot score).">
            <Toggle checked={f.header_checks} onChange={(header_checks) => set({ header_checks })} label="HTTP header consistency checks" />
          </Field>
          <Field help="Compare the TLS fingerprint (JA3 / JA4) with the claimed browser and apply the block lists below. Only available where this server terminates TLS (TLS mode “Auto”).">
            <Toggle checked={f.tls_checks} onChange={(tls_checks) => set({ tls_checks })} label="TLS fingerprint checks" />
          </Field>
          <div />
          <Field label="Bot score threshold" help="Every suspicious signal adds points; a visitor whose score reaches this value is a bot. Lower = stricter. Default 100.">
            <NumberInput value={f.bot_threshold} min={1} onChange={(bot_threshold) => set({ bot_threshold })} />
          </Field>
          <Field label="JS check pass lifetime, hours" help="How long a browser that passed a stream's JS check is remembered (cookie) before it is challenged again.">
            <NumberInput value={f.js_pass_hours} min={1} onChange={(js_pass_hours) => set({ js_pass_hours })} />
          </Field>
        </div>
      </Card>

      <Card title="Networks (ASN)">
        <div className="form-grid">
          <Field label="Bot ASNs" help="Networks that only ever send crawlers (ad platforms, search engines). Always a bot." className="span-2">
            <Chips mono values={f.bot_asns} onChange={(bot_asns) => set({ bot_asns })} validate={asnCheck} placeholder="15169, AS32934…" />
          </Field>
          <Field label="Datacenter ASNs" help="Hosting and cloud providers. Marked as datacenter (and as bots when the switch above is on)." className="span-2">
            <Chips mono values={f.datacenter_asns} onChange={(datacenter_asns) => set({ datacenter_asns })} validate={asnCheck} placeholder="16509, AS14061…" />
          </Field>
        </div>
      </Card>

      <Card title="Fingerprints">
        <div className="form-grid">
          <Field label="Bot User-Agent patterns" help="One per line, in addition to the built-in crawler list. A visitor whose User-Agent matches is a bot. Max 200 characters each." className="span-2">
            <textarea className="input mono" rows={5} spellCheck={false} value={f.bot_ua_patterns} onChange={(e) => set({ bot_ua_patterns: e.target.value })} placeholder={'HeadlessChrome\npython-requests'} />
          </Field>
          <Field label="Blocked JA3 fingerprints" help="TLS client fingerprints (MD5 hashes) that are always bots.">
            <Chips mono values={f.ja3_block} onChange={(ja3_block) => set({ ja3_block })} placeholder="e7d705a3286e19ea42f587b344ee6865" />
          </Field>
          <Field label="Blocked JA4 fingerprints" help="JA4 strings that are always bots.">
            <Chips mono values={f.ja4_block} onChange={(ja4_block) => set({ ja4_block })} placeholder="t13d1516h2_8daaf6152771_02713d6af862" />
          </Field>
        </div>
      </Card>

      {error && <div className="field-error">{error}</div>}
      <div className="form-actions sticky-actions">
        <button className="btn primary" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save detection settings'}
        </button>
      </div>
    </div>
  )
}

// ---- IP lists ---------------------------------------------------------------

const LIST_KINDS: { value: string; label: string; tone: Tone; help: string }[] = [
  { value: 'bot', label: 'Bot', tone: 'err', help: 'Crawlers and ad reviewers: always a bot.' },
  { value: 'datacenter', label: 'Datacenter', tone: 'warn', help: 'Hosting / VPN ranges: marked as datacenter.' },
  { value: 'block', label: 'Block', tone: 'err', help: 'Your own blocklist: always a bot.' },
  { value: 'allow', label: 'Allow', tone: 'ok', help: 'Never a bot — overrides every other signal.' },
]

function Lists() {
  const res = useLoad(() => get<IPList[]>('ip-lists'), [])
  const [editing, setEditing] = useState<IPList | 'new' | null>(null)
  const [refreshing, setRefreshing] = useState<number | null>(null)
  const lists = res.data ?? []

  const patch = async (l: IPList, body: Partial<IPList>) => {
    try {
      const n = await put<IPList>(`ip-lists/${l.id}`, body)
      res.setData(lists.map((x) => (x.id === l.id ? n : x)))
    } catch (e) {
      toast.err(e)
    }
  }
  const refresh = async (l: IPList) => {
    setRefreshing(l.id)
    try {
      const n = await post<IPList>(`ip-lists/${l.id}/refresh`)
      res.setData(lists.map((x) => (x.id === l.id ? n : x)))
      toast.ok(`${l.name}: ${fmtInt(n.entries)} entries`)
    } catch (e) {
      toast.err(e)
      res.reload()
    } finally {
      setRefreshing(null)
    }
  }
  const remove = async (l: IPList) => {
    if (!(await confirmDialog({ title: 'Delete IP list?', message: <>List <b>{l.name}</b> ({fmtInt(l.entries)} entries) will be deleted.</> }))) return
    try {
      await del(`ip-lists/${l.id}`)
      toast.ok('List deleted')
      res.reload()
    } catch (e) {
      toast.err(e)
    }
  }

  const columns: Column<IPList>[] = [
    {
      key: 'name',
      title: 'Name',
      sort: (l) => l.name.toLowerCase(),
      render: (l) => (
        <span className="row gap-s">
          <span className="strong">{l.name}</span>
          {l.builtin && <Badge>built-in</Badge>}
        </span>
      ),
    },
    {
      key: 'kind',
      title: 'Kind',
      sort: (l) => l.kind,
      render: (l) => {
        const k = LIST_KINDS.find((x) => x.value === l.kind)
        return (
          <Badge tone={k?.tone ?? 'neutral'} title={k?.help}>
            {k?.label ?? l.kind}
          </Badge>
        )
      },
    },
    {
      key: 'url',
      title: 'Source',
      render: (l) =>
        l.url ? (
          <a href={l.url} target="_blank" rel="noreferrer noopener" className="ellipsis mono small" style={{ maxWidth: 340, display: 'inline-block' }} title={l.url}>
            {l.url}
          </a>
        ) : (
          <span className="muted">manual entries</span>
        ),
    },
    { key: 'entries', title: 'Entries', align: 'right', sort: (l) => l.entries, render: (l) => fmtInt(l.entries) },
    { key: 'updated', title: 'Updated', render: (l) => <span title={fmtDateTime(l.updated_at)}>{fmtAgo(l.updated_at)}{l.url ? <span className="muted"> · every {l.refresh_hours}h</span> : null}</span> },
    { key: 'error', title: 'Last error', render: (l) => (l.last_error ? <span className="field-error ellipsis" style={{ maxWidth: 260, display: 'inline-block' }} title={l.last_error}>{l.last_error}</span> : <span className="muted">—</span>) },
    { key: 'enabled', title: 'Enabled', width: 80, render: (l) => <Toggle checked={l.enabled} onChange={(enabled) => patch(l, { enabled })} /> },
    {
      key: 'actions',
      title: '',
      align: 'right',
      width: 120,
      render: (l) => (
        <div className="row-actions">
          <button className="icon-btn" title="Refresh now" disabled={refreshing === l.id} onClick={() => refresh(l)}>
            <RefreshCw size={15} className={refreshing === l.id ? 'spin' : ''} />
          </button>
          <button className="icon-btn" title="Edit" onClick={() => setEditing(l)}>
            <Pencil size={15} />
          </button>
          <button className="icon-btn danger" title={l.builtin ? 'Built-in lists cannot be deleted; disable instead' : 'Delete'} disabled={l.builtin} onClick={() => remove(l)}>
            <Trash2 size={15} />
          </button>
        </div>
      ),
    },
  ]

  return (
    <div className="stack">
      <div className="toolbar">
        <span className="muted grow">IP and CIDR lists checked on every click. “Allow” wins over everything; “Bot” and “Block” always mean bot.</span>
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Plus size={15} /> Add custom list
        </button>
      </div>
      <ErrorBox error={res.error} retry={res.reload} />
      <div className="card">
        <DataTable columns={columns} rows={res.data} rowKey={(l) => l.id} loading={res.loading} rowClass={(l) => (l.enabled ? '' : 'dim')} empty={<Empty title="No IP lists" />} />
      </div>
      {editing && (
        <ListEditor
          list={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            res.reload()
            // The server downloads and parses the list in the background after a save.
            setTimeout(() => res.reload(), 2500)
          }}
        />
      )}
    </div>
  )
}

function ListEditor({ list, onClose, onSaved }: { list: IPList | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: list?.name ?? '',
    kind: list?.kind ?? 'block',
    url: list?.url ?? '',
    content: list?.content ?? '',
    refresh_hours: (list?.refresh_hours ?? 24) as number | '',
    enabled: list?.enabled ?? true,
  })
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }))
  const save = () =>
    run(async () => {
      setError('')
      const body = { ...f, name: f.name.trim(), url: f.url.trim(), refresh_hours: f.refresh_hours === '' ? 24 : f.refresh_hours }
      try {
        if (list) await put(`ip-lists/${list.id}`, body)
        else await post('ip-lists', body)
        toast.ok(list ? 'List saved' : 'List created')
        onSaved()
      } catch (e) {
        setError(errMsg(e))
      }
    })
  const lines = f.content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length
  return (
    <Modal
      title={list ? `IP list: ${list.name}` : 'New IP list'}
      size="lg"
      onClose={onClose}
      footer={
        <>
          {error && <div className="field-error grow">{error}</div>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !f.name.trim()} onClick={save}>
            {list ? 'Save' : 'Create list'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name">
          <input className="input" autoFocus={!list} value={f.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Kind" help={LIST_KINDS.find((k) => k.value === f.kind)?.help}>
          <Select value={f.kind} onChange={(kind) => set({ kind })} options={LIST_KINDS} />
        </Field>
        <Field label="Source URL (optional)" help="A text file with one IP or CIDR per line, downloaded periodically. Leave empty for a purely manual list." className="span-2">
          <input className="input mono" value={f.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://example.com/ranges.txt" />
        </Field>
        <Field label="Refresh every, hours">
          <NumberInput value={f.refresh_hours} min={1} disabled={!f.url.trim()} onChange={(refresh_hours) => set({ refresh_hours })} />
        </Field>
        <Field label="Status">
          <Toggle checked={f.enabled} onChange={(enabled) => set({ enabled })} label={f.enabled ? 'Enabled' : 'Disabled'} />
        </Field>
        <Field label={`Manual entries${lines ? ` (${fmtInt(lines)})` : ''}`} help="One IP address or CIDR per line. Used in addition to the downloaded source, if any." className="span-2">
          <textarea className="input mono" rows={10} spellCheck={false} value={f.content} onChange={(e) => set({ content: e.target.value })} placeholder={'203.0.113.0/24\n2001:db8::/32\n198.51.100.7'} />
        </Field>
      </div>
    </Modal>
  )
}

// ---- external integrations --------------------------------------------------

const GEO_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: 'country', label: 'Country code *', hint: 'countryCode' },
  { key: 'region', label: 'Region', hint: 'regionName' },
  { key: 'city', label: 'City', hint: 'city' },
  { key: 'asn', label: 'ASN', hint: 'asn' },
  { key: 'isp', label: 'ISP / organisation', hint: 'isp' },
]
const BOT_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: 'bot', label: 'Bot flag or score *', hint: 'is_bot or fraud_score' },
  { key: 'threshold', label: 'Score threshold', hint: 'empty for a boolean flag, e.g. 85 for a score' },
]

function Integrations() {
  const res = useLoad(() => get<Integration[]>('integrations'), [])
  const [editing, setEditing] = useState<Integration | 'new' | null>(null)
  const items = res.data ?? []

  const patch = async (it: Integration, enabled: boolean) => {
    try {
      const n = await put<Integration>(`integrations/${it.id}`, { enabled })
      res.setData(items.map((x) => (x.id === it.id ? n : x)))
    } catch (e) {
      toast.err(e)
    }
  }
  const remove = async (it: Integration) => {
    if (!(await confirmDialog({ title: 'Delete integration?', message: <>Integration <b>{it.name}</b> will be removed.</> }))) return
    try {
      await del(`integrations/${it.id}`)
      toast.ok('Integration deleted')
      res.reload()
    } catch (e) {
      toast.err(e)
    }
  }

  const columns: Column<Integration>[] = [
    { key: 'name', title: 'Name', render: (it) => <span className="strong">{it.name}</span> },
    { key: 'kind', title: 'Kind', render: (it) => <Badge tone={it.kind === 'geo' ? 'info' : 'accent'}>{it.kind === 'geo' ? 'Geo lookup' : 'Bot check'}</Badge> },
    { key: 'url', title: 'URL', render: (it) => <span className="mono small ellipsis" style={{ maxWidth: 420, display: 'inline-block' }} title={it.url}>{it.url}</span> },
    { key: 'timing', title: 'Timeout / cache', render: (it) => `${it.timeout_ms} ms / ${it.cache_minutes} min` },
    { key: 'enabled', title: 'Enabled', width: 80, render: (it) => <Toggle checked={it.enabled} onChange={(v) => patch(it, v)} /> },
    {
      key: 'actions',
      title: '',
      align: 'right',
      width: 90,
      render: (it) => (
        <div className="row-actions">
          <button className="icon-btn" title="Edit / test" onClick={() => setEditing(it)}>
            <Pencil size={15} />
          </button>
          <button className="icon-btn danger" title="Delete" onClick={() => remove(it)}>
            <Trash2 size={15} />
          </button>
        </div>
      ),
    },
  ]

  return (
    <div className="stack">
      <div className="toolbar">
        <span className="muted grow">Optional HTTP JSON APIs queried on each click: geo lookups override the local database; bot checks add an external verdict.</span>
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Plus size={15} /> Add integration
        </button>
      </div>
      <Notice tone="warn">An enabled integration is called during the click (results are cached per IP). A slow API slows every uncached visitor by up to its timeout — keep timeouts low.</Notice>
      <ErrorBox error={res.error} retry={res.reload} />
      <div className="card">
        <DataTable
          columns={columns}
          rows={res.data}
          rowKey={(it) => it.id}
          loading={res.loading}
          rowClass={(it) => (it.enabled ? '' : 'dim')}
          empty={<Empty title="No external integrations">The built-in detection and the local geo database work without any. Add one to plug in a paid geo or fraud-scoring API.</Empty>}
        />
      </div>
      {editing && (
        <IntegrationEditor
          item={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            res.reload()
          }}
        />
      )}
    </div>
  )
}

function IntegrationEditor({ item, onClose, onSaved }: { item: Integration | null; onClose: () => void; onSaved: () => void }) {
  const meta = useMeta()
  const [f, setF] = useState({
    name: item?.name ?? '',
    kind: item?.kind ?? 'geo',
    enabled: item?.enabled ?? true,
    url: item?.url ?? '',
    timeout_ms: (item?.timeout_ms ?? 300) as number | '',
    cache_minutes: (item?.cache_minutes ?? 60) as number | '',
  })
  const [headers, setHeaders] = useState<[string, string][]>(Object.entries(item?.headers ?? {}))
  const [mapping, setMapping] = useState<Record<string, string>>({ ...(item?.mapping ?? {}) })
  const [testIP, setTestIP] = useState('8.8.8.8')
  const [test, setTest] = useState<IntegrationTestResult | null>(null)
  const [testErr, setTestErr] = useState('')
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }))
  const fields = f.kind === 'geo' ? GEO_FIELDS : BOT_FIELDS

  const build = () => {
    const h: Record<string, string> = {}
    for (const [k, v] of headers) if (k.trim()) h[k.trim()] = v
    const m: Record<string, string> = {}
    for (const fl of fields) if ((mapping[fl.key] ?? '').trim()) m[fl.key] = mapping[fl.key].trim()
    return { ...f, name: f.name.trim(), url: f.url.trim(), timeout_ms: f.timeout_ms === '' ? 300 : f.timeout_ms, cache_minutes: f.cache_minutes === '' ? 60 : f.cache_minutes, headers: h, mapping: m }
  }

  const applyPreset = (name: string) => {
    const p = meta.integration_presets.find((x) => x.name === name)
    if (!p) return
    set({ name: f.name || p.name, kind: p.kind, url: p.url })
    setMapping({ ...p.mapping })
    setTest(null)
  }

  const save = () =>
    run(async () => {
      setError('')
      const body = build()
      try {
        // headers and mapping are always sent whole: PUT replaces maps that are present in the body.
        if (item) await put(`integrations/${item.id}`, body)
        else await post('integrations', body)
        toast.ok(item ? 'Integration saved' : 'Integration created')
        onSaved()
      } catch (e) {
        setError(errMsg(e))
      }
    })

  const runTest = async () => {
    setTesting(true)
    setTestErr('')
    try {
      setTest(await post<IntegrationTestResult>('integrations/test', { integration: build(), ip: testIP.trim() }))
    } catch (e) {
      setTest(null)
      setTestErr(errMsg(e))
    } finally {
      setTesting(false)
    }
  }

  const preset = meta.integration_presets.find((p) => p.url === f.url)

  return (
    <Modal
      title={item ? `Integration: ${item.name}` : 'New integration'}
      size="xl"
      onClose={onClose}
      footer={
        <>
          {error && <div className="field-error grow">{error}</div>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !f.name.trim() || !f.url.trim()} onClick={save}>
            {item ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Start from a preset" className="span-2" help={preset?.description ?? 'Fills the URL and mapping; replace the placeholder keys afterwards.'}>
          <Select value="" onChange={applyPreset} placeholder="Choose a preset…" options={meta.integration_presets.map((p) => ({ value: p.name, label: p.name, group: p.kind === 'geo' ? 'Geo lookup' : 'Bot check' }))} />
        </Field>
        <Field label="Name">
          <input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Kind">
          <Select
            value={f.kind}
            onChange={(kind) => set({ kind })}
            options={[
              { value: 'geo', label: 'Geo lookup — overrides country / city / ISP' },
              { value: 'antibot', label: 'Bot check — external verdict or score' },
            ]}
          />
        </Field>
        <Field label="Request URL" className="span-2" help="GET request expected to return JSON. {ip} is required and is replaced by the visitor address; {ua} by the URL-encoded User-Agent.">
          <input className="input mono" spellCheck={false} value={f.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://api.example.com/v1/{ip}?key=…" />
        </Field>
        <Field label="Timeout, ms" help="Max 5000. On timeout the click proceeds without this integration.">
          <NumberInput value={f.timeout_ms} min={50} max={5000} onChange={(timeout_ms) => set({ timeout_ms })} />
        </Field>
        <Field label="Cache, minutes" help="Answers are cached per IP for this long.">
          <NumberInput value={f.cache_minutes} min={1} onChange={(cache_minutes) => set({ cache_minutes })} />
        </Field>
        <Field className="span-2">
          <Toggle checked={f.enabled} onChange={(enabled) => set({ enabled })} label="Enabled" />
        </Field>
      </div>

      <div className="section-head">
        <h4>Request headers</h4>
        <span className="muted grow">For API keys sent as headers.</span>
        <button className="btn small" onClick={() => setHeaders([...headers, ['', '']])}>
          <Plus size={14} /> Add header
        </button>
      </div>
      {headers.length === 0 && <div className="muted small">No extra headers.</div>}
      {headers.map(([k, v], i) => (
        <div className="row gap kv-row" key={i}>
          <input className="input mono" style={{ width: 240 }} placeholder="Header name" value={k} onChange={(e) => setHeaders(headers.map((h, j) => (j === i ? [e.target.value, h[1]] : h)))} />
          <input className="input mono grow" placeholder="Value" value={v} onChange={(e) => setHeaders(headers.map((h, j) => (j === i ? [h[0], e.target.value] : h)))} />
          <button className="icon-btn danger" title="Remove header" onClick={() => setHeaders(headers.filter((_, j) => j !== i))}>
            <Trash2 size={15} />
          </button>
        </div>
      ))}

      <div className="section-head">
        <h4>Response mapping</h4>
        <span className="muted grow">
          Dot-separated JSON paths into the response, e.g. <code>data.location.country_code</code>.
        </span>
      </div>
      <div className="form-grid">
        {fields.map((fl) => (
          <Field key={fl.key} label={fl.label} help={fl.key === 'threshold' ? 'Leave empty when the path is a true/false flag. With a number, the path is treated as a score and values at or above it mean bot.' : undefined}>
            <input className="input mono" spellCheck={false} placeholder={fl.hint} value={mapping[fl.key] ?? ''} onChange={(e) => setMapping({ ...mapping, [fl.key]: e.target.value })} />
          </Field>
        ))}
      </div>

      <div className="section-head">
        <h4>Test</h4>
        <span className="muted grow">Sends one real request with the settings above (unsaved changes included).</span>
      </div>
      <div className="row gap">
        <input className="input mono" style={{ width: 220 }} value={testIP} onChange={(e) => setTestIP(e.target.value)} placeholder="IP to look up" />
        <button className="btn" disabled={testing || !f.url.trim()} onClick={runTest}>
          <FlaskConical size={14} /> {testing ? 'Testing…' : 'Test request'}
        </button>
      </div>
      {testErr && <div className="field-error">{testErr}</div>}
      {test && (
        <div className="test-result">
          <div>
            <div className="field-label">Mapped values</div>
            <dl className="kv">
              {Object.entries(test.mapped ?? {}).map(([k, v]) => (
                <span key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd className="mono">{v === null || v === undefined ? <span className="field-error">not found in the response</span> : JSON.stringify(v)}</dd>
                </span>
              ))}
              {test.is_bot !== undefined && (
                <>
                  <dt>Verdict</dt>
                  <dd>{test.is_bot ? <Badge tone="err">bot</Badge> : <Badge tone="ok">not a bot</Badge>}</dd>
                </>
              )}
            </dl>
          </div>
          <div>
            <div className="field-label">Raw response</div>
            <pre className="params-json">{JSON.stringify(test.response, null, 2)}</pre>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ---- geo database -----------------------------------------------------------

function GeoDB() {
  const status = useLoad(() => get<GeoStatus>('geo/status'), [])
  const settings = useLoad(() => get<Settings>('settings'), [])
  const [f, setF] = useState<{ geo_city_url: string; geo_asn_url: string; maxmind_key: string; geo_refresh_days: number | '' } | null>(null)
  const [kind, setKind] = useState('city')
  const [file, setFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    const s = settings.data
    if (s) setF({ geo_city_url: s.geo_city_url, geo_asn_url: s.geo_asn_url, maxmind_key: s.maxmind_key, geo_refresh_days: s.geo_refresh_days })
  }, [settings.data])

  const refresh = async () => {
    setRefreshing(true)
    try {
      status.setData(await post<GeoStatus>('geo/refresh'))
      toast.ok('Geo databases refreshed')
    } catch (e) {
      toast.err(e)
      status.reload()
    } finally {
      setRefreshing(false)
    }
  }
  const doUpload = () =>
    run(async () => {
      if (!file) return
      const fd = new FormData()
      // Text fields go first so the server sees them before the (large) file part.
      fd.append('kind', kind)
      fd.append('file', file)
      status.setData(await upload<GeoStatus>('geo/upload', fd))
      setFile(null)
      if (fileRef.current) fileRef.current.value = ''
      toast.ok(`${kind === 'city' ? 'City' : 'ASN'} database installed`)
    })
  const save = () =>
    run(async () => {
      if (!f) return
      setError('')
      try {
        settings.setData(await put<Settings>('settings', { ...f, geo_city_url: f.geo_city_url.trim(), geo_asn_url: f.geo_asn_url.trim(), maxmind_key: f.maxmind_key.trim(), geo_refresh_days: f.geo_refresh_days === '' ? 7 : f.geo_refresh_days }))
        toast.ok('Geo settings saved — changed sources are downloaded in the background')
        setTimeout(() => status.reload(), 4000)
      } catch (e) {
        setError(errMsg(e))
      }
    })

  const st = status.data
  const dbRow = (label: string, s: GeoStatus['city'] | undefined, what: string) => (
    <div className="geo-db">
      <span className={'dot ' + (s?.loaded ? 'ok' : 'err')} />
      <div className="grow">
        <b>{label}</b>
        <div className="muted small">{what}</div>
      </div>
      {s?.loaded ? (
        <div className="right">
          <Badge tone="ok">loaded</Badge>
          <div className="muted small">
            {fmtBytes(s.size)} · updated {fmtDateTime(s.updated, false)}
          </div>
        </div>
      ) : (
        <Badge tone="err">not loaded</Badge>
      )}
    </div>
  )

  return (
    <div className="stack">
      <Card
        title="Database status"
        actions={
          <button className="btn small" disabled={refreshing} onClick={refresh}>
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Downloading…' : 'Refresh now'}
          </button>
        }
      >
        <ErrorBox error={status.error} retry={status.reload} />
        {!st && !status.error ? (
          <Skeleton rows={3} />
        ) : (
          <>
            {dbRow('City database', st?.city, 'Country, region and city of the visitor.')}
            {dbRow('ASN database', st?.asn, 'Network number and ISP — needed for the ASN lists and ISP filters.')}
            {st?.last_error && <Notice tone="err" title="Last download error">{st.last_error}</Notice>}
            {st && (!st.city.loaded || !st.asn.loaded) && <Notice tone="warn">Without the geo databases country filters match nobody and ASN-based bot detection is off. Refresh, or upload .mmdb files below.</Notice>}
          </>
        )}
      </Card>

      <Card title="Manual upload">
        <p className="muted">Upload a MaxMind-format <code>.mmdb</code> file (GeoLite2, DB-IP, IPinfo…) when the server cannot download one itself.</p>
        <div className="row gap wrap">
          <Select
            value={kind}
            onChange={setKind}
            options={[
              { value: 'city', label: 'City database' },
              { value: 'asn', label: 'ASN database' },
            ]}
          />
          <input ref={fileRef} type="file" className="input file" accept=".mmdb" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button className="btn" disabled={busy || !file} onClick={doUpload}>
            <Upload size={14} /> {busy ? 'Uploading…' : 'Install'}
          </button>
        </div>
      </Card>

      <Card title="Automatic download">
        {!f ? (
          settings.error ? <ErrorBox error={settings.error} retry={settings.reload} /> : <Skeleton rows={4} />
        ) : (
          <>
            <div className="form-grid">
              <Field label="City database URL" className="span-2" help="{YYYY} and {MM} are replaced by the current year and month (the previous month is tried as a fallback). .gz is unpacked automatically.">
                <input className="input mono" spellCheck={false} value={f.geo_city_url} disabled={!!f.maxmind_key.trim()} onChange={(e) => setF({ ...f, geo_city_url: e.target.value })} />
              </Field>
              <Field label="ASN database URL" className="span-2">
                <input className="input mono" spellCheck={false} value={f.geo_asn_url} disabled={!!f.maxmind_key.trim()} onChange={(e) => setF({ ...f, geo_asn_url: e.target.value })} />
              </Field>
              <Field label="MaxMind license key (optional)" help="When set, GeoLite2-City and GeoLite2-ASN are downloaded from MaxMind with this key and the two URLs above are ignored.">
                <input className="input mono" spellCheck={false} autoComplete="off" value={f.maxmind_key} onChange={(e) => setF({ ...f, maxmind_key: e.target.value })} />
              </Field>
              <Field label="Refresh every, days">
                <NumberInput value={f.geo_refresh_days} min={1} onChange={(geo_refresh_days) => setF({ ...f, geo_refresh_days })} />
              </Field>
            </div>
            {error && <div className="field-error">{error}</div>}
            <div className="form-actions">
              <button className="btn primary" disabled={busy} onClick={save}>
                Save geo settings
              </button>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}

// ---- geo presets ------------------------------------------------------------

function Presets() {
  const res = useLoad(() => get<GeoPreset[]>('geo-presets'), [])
  const [editing, setEditing] = useState<GeoPreset | 'new' | null>(null)

  const remove = async (p: GeoPreset) => {
    if (!(await confirmDialog({ title: 'Delete preset?', message: <>Preset <b>{p.name}</b> will be deleted. Streams that already used it keep their countries.</> }))) return
    try {
      await del(`geo-presets/${p.id}`)
      toast.ok('Preset deleted')
      res.reload()
    } catch (e) {
      toast.err(e)
    }
  }

  const columns: Column<GeoPreset>[] = [
    {
      key: 'name',
      title: 'Name',
      sort: (p) => p.name.toLowerCase(),
      render: (p) => (
        <span className="row gap-s">
          <span className="strong">{p.name}</span>
          {p.builtin && <Badge>built-in</Badge>}
        </span>
      ),
    },
    { key: 'count', title: 'Countries', align: 'right', width: 100, sort: (p) => p.countries.length, render: (p) => p.countries.length },
    {
      key: 'countries',
      title: '',
      render: (p) => (
        <span className="preset-countries" title={p.countries.join(', ')}>
          {p.countries.slice(0, 24).map((c) => (
            <span key={c} className="cc">
              {flag(c)} {c}
            </span>
          ))}
          {p.countries.length > 24 && <span className="muted">+{p.countries.length - 24}</span>}
        </span>
      ),
    },
    {
      key: 'actions',
      title: '',
      align: 'right',
      width: 90,
      render: (p) => (
        <div className="row-actions">
          <button className="icon-btn" title="Edit" onClick={() => setEditing(p)}>
            <Pencil size={15} />
          </button>
          <button className="icon-btn danger" title="Delete" onClick={() => remove(p)}>
            <Trash2 size={15} />
          </button>
        </div>
      ),
    },
  ]

  return (
    <div className="stack">
      <div className="toolbar">
        <span className="muted grow">Named country sets. In a stream's Country filter, “Presets” adds all countries of a preset at once.</span>
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Plus size={15} /> New preset
        </button>
      </div>
      <ErrorBox error={res.error} retry={res.reload} />
      <div className="card">
        <DataTable columns={columns} rows={res.data} rowKey={(p) => p.id} loading={res.loading} empty={<Empty title="No geo presets">Create sets such as “Tier 1” or “EU” to fill country filters with one click.</Empty>} />
      </div>
      {editing && (
        <PresetEditor
          preset={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            res.reload()
          }}
        />
      )}
    </div>
  )
}

function PresetEditor({ preset, onClose, onSaved }: { preset: GeoPreset | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(preset?.name ?? '')
  const [countries, setCountries] = useState<string[]>(preset?.countries ?? [])
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const save = () =>
    run(async () => {
      setError('')
      try {
        if (preset) await put(`geo-presets/${preset.id}`, { name, countries })
        else await post('geo-presets', { name, countries })
        toast.ok(preset ? 'Preset saved' : 'Preset created')
        onSaved()
      } catch (e) {
        setError(errMsg(e))
      }
    })
  return (
    <Modal
      title={preset ? `Preset: ${preset.name}` : 'New geo preset'}
      size="lg"
      onClose={onClose}
      footer={
        <>
          {error && <div className="field-error grow">{error}</div>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name.trim() || countries.length === 0} onClick={save}>
            {preset ? 'Save' : 'Create preset'}
          </button>
        </>
      }
    >
      <Field label="Name">
        <input className="input" autoFocus={!preset} value={name} onChange={(e) => setName(e.target.value)} placeholder="Tier 1" />
      </Field>
      <Field label={`Countries (${countries.length})`} help="Type a name or a two-letter code and press Enter.">
        <CountrySelect values={countries} onChange={setCountries} />
      </Field>
      <div style={{ height: 220 }} />
    </Modal>
  )
}
