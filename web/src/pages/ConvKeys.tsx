import { useEffect, useMemo, useState } from 'react'
import { Eye, EyeOff, KeyRound, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { del, errMsg, get, post, put } from '../api'
import { useIsAdmin, useLoad, useMeta } from '../hooks'
import type { ConvKey, Domain, Rejected } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { Badge, Card, Chips, CodeBlock, CopyButton, Empty, ErrorBox, Field, Modal, Notice, NumberInput, Select, Toggle, confirmDialog, toast, useBusy } from '../components/ui'
import { fmtDateTime, fmtInt, humanize } from '../format'

const ATTRIBUTION: { value: string; label: string; help: string }[] = [
  {
    value: 'click_id',
    label: 'By click ID',
    help: 'The postback carries the click ID that the tracker put into your offer URL with the {click_id} macro. The most precise mode — use it with affiliate networks and anything that can pass a parameter through.',
  },
  {
    value: 'ip',
    label: 'By visitor IP',
    help: 'The conversion is attached to the most recent non-bot click from the same IP address. For installers and apps that cannot carry a click ID: they report from the visitor’s machine, or pass the address as &ip=.',
  },
  {
    value: 'none',
    label: 'No attribution',
    help: 'Every postback is stored as a standalone event that is not linked to any click or campaign. Use it to simply collect events with their parameters.',
  },
]
const attrLabel = (v: string) => ATTRIBUTION.find((a) => a.value === v)?.label ?? v

export default function ConvKeys() {
  const meta = useMeta()
  const isAdmin = useIsAdmin()
  const keys = useLoad(() => get<ConvKey[]>('conversion-keys'), [])
  const domains = useLoad(() => get<Domain[]>('domains'), [])
  const [domain, setDomain] = useState('')
  const [editing, setEditing] = useState<ConvKey | 'new' | null>(null)

  const sortedDomains = useMemo(() => [...(domains.data ?? [])].sort((a, b) => Number(b.status === 'ok') - Number(a.status === 'ok') || a.name.localeCompare(b.name)), [domains.data])
  useEffect(() => {
    if (!domain && sortedDomains.length) setDomain((sortedDomains.find((d) => d.enabled && d.status === 'ok') ?? sortedDomains[0]).name)
  }, [sortedDomains, domain])

  const patch = async (k: ConvKey, body: Partial<ConvKey>) => {
    try {
      const n = await put<ConvKey>(`conversion-keys/${k.id}`, body)
      keys.setData((keys.data ?? []).map((x) => (x.id === k.id ? n : x)))
    } catch (e) {
      toast.err(e)
    }
  }
  const regenerate = async (k: ConvKey) => {
    const ok = await confirmDialog({
      title: 'Regenerate key?',
      confirmLabel: 'Regenerate',
      message: (
        <>
          A new key{k.secret ? ' and signing secret' : ''} will be issued for <b>{k.name}</b>. Every postback URL that uses the current key stops working immediately and has to be updated at the sender.
        </>
      ),
    })
    if (!ok) return
    try {
      const n = await post<ConvKey>(`conversion-keys/${k.id}/regenerate`)
      keys.setData((keys.data ?? []).map((x) => (x.id === k.id ? n : x)))
      toast.ok('Key regenerated')
    } catch (e) {
      toast.err(e)
    }
  }
  const remove = async (k: ConvKey) => {
    if (!(await confirmDialog({ title: 'Delete key?', message: <>Postbacks sent with key <b>{k.name}</b> will be refused. Conversions already received are kept.</> }))) return
    try {
      await del(`conversion-keys/${k.id}`)
      toast.ok('Key deleted')
      keys.reload()
    } catch (e) {
      toast.err(e)
    }
  }

  const columns: Column<ConvKey>[] = [
    { key: 'name', title: 'Name', sort: (k) => k.name.toLowerCase(), render: (k) => <span className="strong">{k.name}</span> },
    { key: 'enabled', title: 'Enabled', width: 80, render: (k) => <Toggle checked={k.enabled} onChange={(enabled) => patch(k, { enabled })} /> },
    { key: 'attribution', title: 'Attribution', render: (k) => <Badge tone="info">{attrLabel(k.attribution)}</Badge> },
    {
      key: 'key',
      title: 'Key',
      render: (k) => (
        <span className="row gap-s">
          <code>{k.key.slice(0, 8)}…</code>
          <CopyButton text={k.key} className="icon-btn" title="Copy key" />
        </span>
      ),
    },
    {
      key: 'rules',
      title: 'Rules',
      render: (k) => (
        <span className="row gap-s wrap">
          {k.require_click && <Badge title="Postbacks without a matching click are refused">click required</Badge>}
          {k.dedupe && <Badge title="One conversion per click and type">dedupe</Badge>}
          {k.require_sig && <Badge tone="accent">signed</Badge>}
          {(k.ip_allow ?? []).length > 0 && <Badge title={(k.ip_allow ?? []).join(', ')}>IP allowlist</Badge>}
          {k.rate_limit > 0 && <Badge>{k.rate_limit}/min</Badge>}
        </span>
      ),
    },
    { key: 'default', title: 'Defaults', render: (k) => `${k.default_type}${k.default_revenue ? ' · ' + k.default_revenue : ''} · ${k.window_hours}h` },
    {
      key: 'actions',
      title: '',
      align: 'right',
      width: 120,
      render: (k) => (
        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" title="Edit" onClick={() => setEditing(k)}>
            <Pencil size={15} />
          </button>
          <button className="icon-btn" title="Regenerate key" onClick={() => regenerate(k)}>
            <KeyRound size={15} />
          </button>
          <button className="icon-btn danger" title="Delete" onClick={() => remove(k)}>
            <Trash2 size={15} />
          </button>
        </div>
      ),
    },
  ]

  return (
    <div className="stack">
      <div className="toolbar wrap">
        <span className="muted">Postback URLs for domain</span>
        <Select
          value={domain}
          onChange={setDomain}
          placeholder={sortedDomains.length ? undefined : 'YOUR-DOMAIN (no domains added)'}
          options={sortedDomains.map((d) => ({ value: d.name, label: d.name + (d.status !== 'ok' ? ` (${d.status})` : '') }))}
        />
        <span className="muted">Click a key to see its URLs.</span>
        <span className="grow" />
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Plus size={15} /> New key
        </button>
      </div>
      <ErrorBox error={keys.error} retry={keys.reload} />
      <div className="card">
        <DataTable
          columns={columns}
          rows={keys.data}
          rowKey={(k) => k.id}
          loading={keys.loading}
          expand={(k) => <PostbackInfo k={k} domain={domain || 'YOUR-DOMAIN'} path={meta.postback_path} />}
          empty={
            <Empty title="No conversion keys yet" action={<button className="btn primary" onClick={() => setEditing('new')}><Plus size={15} /> Create a key</button>}>
              A key authorises a sender to report conversions. Create one per network, app or installer.
            </Empty>
          }
        />
      </div>

      <RejectedTable all={isAdmin} />

      {editing && (
        <KeyEditor
          k={editing === 'new' ? null : editing}
          types={meta.conversion_types}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            keys.reload()
          }}
        />
      )}
    </div>
  )
}

function PostbackInfo({ k, domain, path }: { k: ConvKey; domain: string; path: string }) {
  const [show, setShow] = useState(false)
  const base = `https://${domain}${path}?key=${k.key}`
  const sigTail = k.require_sig ? '&ts=UNIX_TIME&sig=SIGNATURE' : ''
  const urls: { title: string; url: string; note: string }[] = []
  if (k.attribution === 'click_id') {
    urls.push({
      title: 'Postback URL (click ID)',
      url: `${base}&click_id={click_id}&type=sale&revenue=10&currency=USD&any_param=value${sigTail}`,
      note: 'Replace {click_id} with the network’s own macro for the value you passed from the tracker (the {click_id} macro in your offer URL). clickid, subid and cid are accepted as synonyms.',
    })
  } else if (k.attribution === 'ip') {
    urls.push({
      title: 'Postback URL for installers (attribution by IP)',
      url: `${base}&ip=VISITOR_IP&type=install&any_param=value${sigTail}`,
      note: 'Send the visitor’s address as ip when the request comes from your server. If the installer itself calls the URL from the visitor’s machine, drop &ip= and the sender address is used.',
    })
  } else {
    urls.push({ title: 'Postback URL (standalone event)', url: `${base}&type=${k.default_type}&any_param=value${sigTail}`, note: 'The event is stored without being linked to a click.' })
  }

  const sample = `<?php
// sig = hex(HMAC-SHA256(secret, "k1=v1&k2=v2...")) over every parameter
// except sig, sorted by name, raw (not URL-encoded) values. ts is required.
$p = [
    'key'      => '${k.key}',${k.attribution === 'click_id' ? "\n    'click_id' => $clickId," : k.attribution === 'ip' ? "\n    'ip'       => $visitorIp," : ''}
    'type'     => '${k.default_type}',
    'revenue'  => '10',
    'ts'       => time(),            // unix seconds, at most 10 minutes off
];
ksort($p);
$pairs = [];
foreach ($p as $name => $value) {
    $pairs[] = $name . '=' . $value;
}
$p['sig'] = hash_hmac('sha256', implode('&', $pairs), '${show ? k.secret : 'YOUR_SECRET'}');
file_get_contents('https://${domain}${path}?' . http_build_query($p));`

  return (
    <div className="detail">
      {!k.enabled && <Notice tone="warn">This key is disabled: its postbacks are refused.</Notice>}
      <p className="muted">{ATTRIBUTION.find((a) => a.value === k.attribution)?.help}</p>
      {urls.map((u) => (
        <div key={u.title} className="url-block">
          <div className="field-label">{u.title}</div>
          <div className="url-line">
            <code>{u.url}</code>
            <CopyButton text={u.url} label="Copy" />
          </div>
          <div className="field-help">{u.note}</div>
        </div>
      ))}
      <div className="field-help">
        Parameters: <code>type</code> (one of the conversion types; default <b>{k.default_type}</b>), <code>revenue</code> or <code>payout</code>
        {k.default_revenue > 0 && <> (default {k.default_revenue})</>}, <code>currency</code>. Any other parameter is stored and shown as its own column in the log. GET and POST (form or JSON body) both work; the key may also be sent in the{' '}
        <code>X-TDS-Key</code> header. The answer is <code>OK</code>, or <code>DUPLICATE</code> when deduplication dropped it.
      </div>
      {k.require_sig && (
        <div className="url-block">
          <div className="field-label">
            Signing secret{' '}
            <button className="link" onClick={() => setShow(!show)}>
              {show ? <EyeOff size={13} /> : <Eye size={13} />} {show ? 'hide' : 'show'}
            </button>
          </div>
          <div className="url-line">
            <code>{show ? k.secret : '•'.repeat(24)}</code>
            <CopyButton text={k.secret} label="Copy" />
          </div>
          <div className="field-help">
            Signed postbacks need <code>ts</code> (unix seconds, within 10 minutes of now) and <code>sig</code> (or the <code>X-TDS-Signature</code> header). Example:
          </div>
          <CodeBlock text={sample} maxHeight={300} />
        </div>
      )}
    </div>
  )
}

function KeyEditor({ k, types, onClose, onSaved }: { k: ConvKey | null; types: string[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: k?.name ?? '',
    enabled: k?.enabled ?? true,
    attribution: k?.attribution ?? 'click_id',
    require_click: k?.require_click ?? true,
    window_hours: (k?.window_hours ?? 72) as number | '',
    dedupe: k?.dedupe ?? true,
    default_type: k?.default_type ?? 'lead',
    default_revenue: (k?.default_revenue ?? 0) as number | '',
    rate_limit: (k?.rate_limit ?? 0) as number | '',
    ip_allow: k?.ip_allow ?? [],
    require_sig: k?.require_sig ?? false,
    note: k?.note ?? '',
  })
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }))
  const attr = ATTRIBUTION.find((a) => a.value === f.attribution)

  const save = () =>
    run(async () => {
      setError('')
      const body = {
        ...f,
        name: f.name.trim(),
        window_hours: f.window_hours === '' ? 72 : f.window_hours,
        default_revenue: f.default_revenue === '' ? 0 : f.default_revenue,
        rate_limit: f.rate_limit === '' ? 0 : f.rate_limit,
        require_click: f.attribution === 'none' ? false : f.require_click,
      }
      try {
        if (k) await put(`conversion-keys/${k.id}`, body)
        else await post('conversion-keys', body)
        toast.ok(k ? 'Key saved' : 'Key created')
        onSaved()
      } catch (e) {
        setError(errMsg(e))
      }
    })

  return (
    <Modal
      title={k ? `Key: ${k.name}` : 'New conversion key'}
      size="lg"
      onClose={onClose}
      footer={
        <>
          {error && <div className="field-error grow">{error}</div>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !f.name.trim()} onClick={save}>
            {k ? 'Save' : 'Create key'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name">
          <input className="input" autoFocus={!k} value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. AdNetwork X, Windows installer" />
        </Field>
        <Field label="Status">
          <Toggle checked={f.enabled} onChange={(enabled) => set({ enabled })} label={f.enabled ? 'Enabled' : 'Disabled'} />
        </Field>

        <Field label="Attribution" className="span-2">
          <div className="radio-cards">
            {ATTRIBUTION.map((a) => (
              <label key={a.value} className={'radio-card' + (f.attribution === a.value ? ' active' : '')}>
                <input type="radio" name="attribution" checked={f.attribution === a.value} onChange={() => set({ attribution: a.value })} />
                <div>
                  <b>{a.label}</b>
                  <div className="muted small">{a.help}</div>
                </div>
              </label>
            ))}
          </div>
        </Field>

        {f.attribution !== 'none' && (
          <>
            <Field help={`Refuse the postback when no matching click is found${f.attribution === 'click_id' ? ' (missing, forged or expired click ID)' : ''}. Off: store it anyway as an unattributed conversion.`}>
              <Toggle checked={f.require_click} onChange={(require_click) => set({ require_click })} label="Require a matching click" />
            </Field>
            <Field label="Attribution window, hours" help={`How long after the click a conversion is still attributed to it (${attr?.label.toLowerCase()}).`}>
              <NumberInput value={f.window_hours} min={1} onChange={(window_hours) => set({ window_hours })} />
            </Field>
            <Field className="span-2" help="Keep only the first conversion of each type per click; repeats are answered with DUPLICATE and not stored.">
              <Toggle checked={f.dedupe} onChange={(dedupe) => set({ dedupe })} label="Deduplicate by click + type" />
            </Field>
          </>
        )}

        <Field label="Default type" help="Used when the postback has no type parameter.">
          <Select value={f.default_type} onChange={(default_type) => set({ default_type })} options={types.map((t) => ({ value: t, label: humanize(t) }))} />
        </Field>
        <Field label="Default revenue" help="Used when the postback has no revenue / payout parameter.">
          <NumberInput value={f.default_revenue} min={0} step="any" onChange={(default_revenue) => set({ default_revenue })} />
        </Field>

        <Field label="Rate limit per sender IP, per minute" help="0 = unlimited. Extra postbacks are refused with 429.">
          <NumberInput value={f.rate_limit} min={0} onChange={(rate_limit) => set({ rate_limit })} />
        </Field>
        <Field label="Sender IP allowlist" help="IPs or CIDRs allowed to use this key. Empty = anyone who knows the key. Do not use with attribution by IP from visitors’ machines.">
          <Chips mono values={f.ip_allow} onChange={(ip_allow) => set({ ip_allow })} placeholder="203.0.113.7 or 198.51.100.0/24" />
        </Field>

        <Field className="span-2" help="The sender must sign every postback with HMAC-SHA256 using a secret, and include a timestamp. The secret and a code sample are shown under the key after saving.">
          <Toggle checked={f.require_sig} onChange={(require_sig) => set({ require_sig })} label="Require a signature" />
        </Field>
        <Field label="Note" className="span-2">
          <input className="input" value={f.note} onChange={(e) => set({ note: e.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}

function RejectedTable({ all }: { all: boolean }) {
  const res = useLoad(() => get<{ rows: Rejected[] | null; total: number }>('postbacks/rejected'), [])
  const columns: Column<Rejected>[] = [
    { key: 'at', title: 'Time', width: 170, render: (r) => <span className="nowrap">{fmtDateTime(r.at)}</span> },
    { key: 'ip', title: 'Sender IP', render: (r) => <span className="mono">{r.ip}</span> },
    {
      key: 'key',
      title: 'Key',
      render: (r) =>
        r.key_name ? (
          <span className="strong" title={r.key ? `Key starts with ${r.key}` : undefined}>
            {r.key_name}
          </span>
        ) : r.key ? (
          <span title="No key with this value exists (prefix shown)">
            <code>{r.key}…</code> <span className="muted small">unknown</span>
          </span>
        ) : (
          <span className="muted">none</span>
        ),
    },
    { key: 'reason', title: 'Reason', render: (r) => <Badge tone="err">{r.reason}</Badge> },
    { key: 'query', title: 'Parameters', render: (r) => <span className="mono small break">{r.query}</span> },
  ]
  return (
    <Card
      title={`Rejected postbacks${res.data ? ` (${fmtInt(res.data.total)} since start)` : ''}`}
      pad={false}
      actions={
        <button className="btn small" onClick={() => res.reload()}>
          <RefreshCw size={14} className={res.loading ? 'spin' : ''} /> Refresh
        </button>
      }
    >
      <ErrorBox error={res.error} />
      <DataTable
        columns={columns}
        rows={res.data ? res.data.rows ?? [] : undefined}
        rowKey={(_, i) => i}
        loading={res.loading}
        maxHeight={360}
        empty={<Empty title="No rejected postbacks">{all ? 'Refused postbacks (wrong key, bad signature, missing click…) show up here with the reason.' : 'Postbacks refused for your keys (bad signature, missing click, rate limit…) show up here with the reason.'} The list is kept in memory and resets on restart.</Empty>}
      />
    </Card>
  )
}
