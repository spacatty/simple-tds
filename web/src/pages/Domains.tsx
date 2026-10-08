import { useMemo, useState } from 'react'
import { Check, FolderCog, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { del, errMsg, get, post, put } from '../api'
import { canEdit, useInterval, useIsAdmin, useLoad } from '../hooks'
import type { BulkAddResult, Campaign, Domain, DomainGroup, SystemInfo } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { Badge, CopyButton, Dropdown, Empty, ErrorBox, Field, MenuItem, Modal, Notice, PageHeader, SearchInput, Select, Toggle, confirmDialog, toast, useBusy } from '../components/ui'
import type { Tone } from '../components/ui'
import { fmtAgo, fmtDateTime } from '../format'

export const TLS_MODES = [
  { value: 'auto', label: 'Auto (Let’s Encrypt)', help: 'The app terminates TLS and issues a Let’s Encrypt certificate itself. Point the domain straight at this server.' },
  { value: 'proxy', label: 'Proxy / CDN', help: 'TLS is terminated by Cloudflare or another proxy in front of this server; no certificate is issued here.' },
]
export const IP_SOURCES = [
  { value: 'direct', label: 'Direct connection', help: 'Use the address of the TCP connection (PROXY-protocol aware).' },
  { value: 'cf', label: 'CF-Connecting-IP', help: 'Cloudflare: take the visitor IP from the CF-Connecting-IP header.' },
  { value: 'xff', label: 'X-Forwarded-For', help: 'Take the left-most address of X-Forwarded-For.' },
  { value: 'x_real_ip', label: 'X-Real-IP', help: 'Take the address from the X-Real-IP header (nginx).' },
]
const label = (list: { value: string; label: string }[], v: string) => list.find((x) => x.value === v)?.label ?? v
const STATUS_TONE: Record<string, Tone> = { ok: 'ok', pending: 'warn', error: 'err' }

export default function Domains() {
  const list = useLoad(() => get<Domain[]>('domains'), [])
  const groups = useLoad(() => get<DomainGroup[]>('domain-groups'), [])
  const isAdmin = useIsAdmin()
  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])
  // A domain may only serve campaigns the user can edit.
  const usable = useMemo(() => (camps.data ?? []).filter(canEdit), [camps.data])
  const sys = useLoad(() => get<SystemInfo>('system'), [])
  const [q, setQ] = useState('')
  const [group, setGroup] = useState('')
  const [status, setStatus] = useState('')
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Domain | null>(null)
  const [managing, setManaging] = useState(false)

  const domains = useMemo(() => list.data ?? [], [list.data])
  useInterval(() => list.reload(), 5000, domains.some((d) => d.status === 'pending'))

  const groupName = (id: number | null) => (id === null ? '' : groups.data?.find((g) => g.id === id)?.name ?? `#${id}`)
  const campName = (id: number | null) => (id === null ? '' : camps.data?.find((c) => c.id === id)?.name ?? `#${id}`)

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return domains.filter((d) => {
      if (s && !d.name.includes(s) && !d.note.toLowerCase().includes(s)) return false
      if (group === 'none' ? d.group_id !== null : group && String(d.group_id) !== group) return false
      if (status && d.status !== status) return false
      return true
    })
  }, [domains, q, group, status])

  const selected = rows.filter((d) => sel.has(d.id))
  const ids = selected.map((d) => d.id)
  const allChecked = rows.length > 0 && selected.length === rows.length

  const patch = async (d: Domain, body: Partial<Domain>) => {
    try {
      const n = await put<Domain>(`domains/${d.id}`, body)
      list.setData(domains.map((x) => (x.id === d.id ? n : x)))
    } catch (e) {
      toast.err(e)
    }
  }
  const bulkSet = async (set: Record<string, unknown>, what: string) => {
    try {
      const r = await post<{ updated: number }>('domains/bulk-update', { ids, set })
      toast.ok(`${what}: ${r.updated} domain${r.updated === 1 ? '' : 's'} updated`)
    } catch (e) {
      toast.err(e)
    }
    list.reload()
  }
  const recheck = async (which: number[]) => {
    try {
      await post('domains/check', { ids: which })
      // The check runs in the background; show it as pending until the poll picks the result up.
      list.setData(domains.map((d) => (which.includes(d.id) ? { ...d, status: 'pending', status_msg: '' } : d)))
      toast.info(`Re-checking ${which.length} domain${which.length === 1 ? '' : 's'}…`)
    } catch (e) {
      toast.err(e)
    }
  }
  const remove = async (which: Domain[]) => {
    const ok = await confirmDialog({
      title: which.length === 1 ? 'Delete domain?' : `Delete ${which.length} domains?`,
      message: (
        <>
          {which.length === 1 ? <b>{which[0].name}</b> : `${which.length} selected domains`} will stop serving campaigns immediately. Statistics are kept.
        </>
      ),
    })
    if (!ok) return
    try {
      if (which.length === 1) await del(`domains/${which[0].id}`)
      else {
        const r = await post<{ deleted: number }>('domains/bulk-delete', { ids: which.map((d) => d.id) })
        toast.ok(`${r.deleted} domains deleted`)
      }
      setSel(new Set())
    } catch (e) {
      toast.err(e)
    }
    list.reload()
  }

  const columns: Column<Domain>[] = [
    {
      key: 'sel',
      width: 32,
      title: <input type="checkbox" aria-label="Select all" checked={allChecked} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((d) => d.id)) : new Set())} />,
      render: (d) => (
        <input
          type="checkbox"
          aria-label={'Select ' + d.name}
          checked={sel.has(d.id)}
          onChange={(e) => {
            const n = new Set(sel)
            if (e.target.checked) n.add(d.id)
            else n.delete(d.id)
            setSel(n)
          }}
        />
      ),
    },
    {
      key: 'name',
      title: 'Domain',
      sort: (d) => d.name,
      render: (d) => (
        <div>
          <a href={`https://${d.name}/`} target="_blank" rel="noreferrer noopener" className="strong">
            {d.name}
          </a>
          {d.note && <div className="muted small">{d.note}</div>}
        </div>
      ),
    },
    { key: 'group', title: 'Group', sort: (d) => groupName(d.group_id), render: (d) => (d.group_id === null ? <span className="muted">—</span> : <Badge>{groupName(d.group_id)}</Badge>) },
    {
      key: 'status',
      title: 'Status',
      sort: (d) => d.status,
      render: (d) => (
        <span title={(d.status_msg ? d.status_msg + '\n' : '') + (d.checked_at ? 'Checked ' + fmtDateTime(d.checked_at) : 'Not checked yet')}>
          <Badge tone={STATUS_TONE[d.status] ?? 'neutral'}>{d.status === 'pending' ? 'pending…' : d.status}</Badge>
          {d.status === 'error' && d.status_msg && <span className="status-msg ellipsis">{d.status_msg}</span>}
          <span className="muted small"> {d.checked_at ? fmtAgo(d.checked_at) : ''}</span>
        </span>
      ),
    },
    { key: 'tls', title: 'TLS', sort: (d) => d.tls_mode, render: (d) => <span title={TLS_MODES.find((m) => m.value === d.tls_mode)?.help}>{d.tls_mode === 'auto' ? 'Auto' : 'Proxy'}</span> },
    { key: 'ip', title: 'Real IP', sort: (d) => d.ip_source, render: (d) => <span title={IP_SOURCES.find((m) => m.value === d.ip_source)?.help}>{label(IP_SOURCES, d.ip_source)}</span> },
    { key: 'campaign', title: 'Default campaign', sort: (d) => campName(d.campaign_id), render: (d) => (d.campaign_id === null ? <span className="muted">— (404 on “/”)</span> : campName(d.campaign_id)) },
    ...(isAdmin
      ? [{ key: 'admin', title: 'Panel', headTitle: 'Serve the admin panel on this domain under the admin path', width: 70, render: (d: Domain) => <Toggle checked={d.admin_enabled} onChange={(v) => patch(d, { admin_enabled: v })} title="Panel access on this domain" /> } as Column<Domain>]
      : []),
    { key: 'enabled', title: 'Enabled', width: 70, render: (d) => <Toggle checked={d.enabled} onChange={(v) => patch(d, { enabled: v })} /> },
    {
      key: 'actions',
      title: '',
      align: 'right',
      width: 110,
      render: (d) => (
        <div className="row-actions">
          <button className="icon-btn" title="Re-check now" onClick={() => recheck([d.id])}>
            <RefreshCw size={15} />
          </button>
          <button className="icon-btn" title="Edit" onClick={() => setEditing(d)}>
            <Pencil size={15} />
          </button>
          <button className="icon-btn danger" title="Delete" onClick={() => remove([d])}>
            <Trash2 size={15} />
          </button>
        </div>
      ),
    },
  ]

  const groupOptions = [{ value: 'none', label: 'Without group' }, ...(groups.data ?? []).map((g) => ({ value: String(g.id), label: g.name }))]
  const serverIP = sys.data?.server_ip ?? ''

  return (
    <div className="page">
      <PageHeader title="Domains" sub="Domains that serve campaigns, postbacks and (optionally) this panel.">
        <button className="btn" onClick={() => setManaging(true)}>
          <FolderCog size={15} /> Groups
        </button>
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Plus size={15} /> Add domains
        </button>
      </PageHeader>

      <Notice>
        Point an <b>A record</b> of each domain at {serverIP ? <><code>{serverIP}</code> <CopyButton text={serverIP} className="icon-btn" title="Copy the server IP" /></> : 'this server'}. The domain is checked automatically and its status turns <Badge tone="ok">ok</Badge> once it is verified
        {' '}— in Auto TLS mode that includes issuing the certificate, which can take a minute. Behind Cloudflare choose TLS “Proxy / CDN” and real IP “CF-Connecting-IP”.
      </Notice>
      <ErrorBox error={list.error} retry={list.reload} />

      <div className="toolbar">
        <SearchInput value={q} onChange={setQ} placeholder="Search domains…" />
        <Select value={group} onChange={setGroup} placeholder="All groups" options={groupOptions} />
        <Select
          value={status}
          onChange={setStatus}
          placeholder="Any status"
          options={[
            { value: 'ok', label: 'OK' },
            { value: 'pending', label: 'Pending' },
            { value: 'error', label: 'Error' },
          ]}
        />
        <span className="muted">
          {rows.length} of {domains.length}
        </span>
      </div>

      {selected.length > 0 && (
        <div className="bulkbar">
          <b>{selected.length} selected</b>
          <Dropdown className="btn small" label="Set group">
            {(close) => (
              <div className="menu">
                <MenuItem onClick={() => (close(), bulkSet({ group_id: null }, 'Group removed'))}>No group</MenuItem>
                {(groups.data ?? []).map((g) => (
                  <MenuItem key={g.id} onClick={() => (close(), bulkSet({ group_id: g.id }, 'Group set'))}>
                    {g.name}
                  </MenuItem>
                ))}
              </div>
            )}
          </Dropdown>
          <Dropdown className="btn small" label="Set campaign">
            {(close) => (
              <div className="menu">
                <MenuItem onClick={() => (close(), bulkSet({ campaign_id: null }, 'Default campaign removed'))}>No default campaign</MenuItem>
                {usable.map((c) => (
                  <MenuItem key={c.id} onClick={() => (close(), bulkSet({ campaign_id: c.id }, 'Default campaign set'))}>
                    {c.name}
                  </MenuItem>
                ))}
              </div>
            )}
          </Dropdown>
          <Dropdown className="btn small" label="TLS mode">
            {(close) => (
              <div className="menu">
                {TLS_MODES.map((m) => (
                  <MenuItem key={m.value} onClick={() => (close(), bulkSet({ tls_mode: m.value }, 'TLS mode set'))}>
                    {m.label}
                  </MenuItem>
                ))}
              </div>
            )}
          </Dropdown>
          <Dropdown className="btn small" label="IP source">
            {(close) => (
              <div className="menu">
                {IP_SOURCES.map((m) => (
                  <MenuItem key={m.value} onClick={() => (close(), bulkSet({ ip_source: m.value }, 'IP source set'))}>
                    {m.label}
                  </MenuItem>
                ))}
              </div>
            )}
          </Dropdown>
          <button className="btn small" onClick={() => bulkSet({ enabled: true }, 'Enabled')}>
            <Check size={14} /> Enable
          </button>
          <button className="btn small" onClick={() => bulkSet({ enabled: false }, 'Disabled')}>
            <X size={14} /> Disable
          </button>
          <button className="btn small" onClick={() => recheck(ids)}>
            <RefreshCw size={14} /> Re-check
          </button>
          <button className="btn small danger-outline" onClick={() => remove(selected)}>
            <Trash2 size={14} /> Delete
          </button>
          <span className="grow" />
          <button className="btn small ghost" onClick={() => setSel(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      <div className="card">
        <DataTable
          columns={columns}
          rows={list.data ? rows : undefined}
          rowKey={(d) => d.id}
          loading={list.loading}
          rowClass={(d) => (sel.has(d.id) ? 'selected' : d.enabled ? '' : 'dim')}
          empty={
            <Empty title={domains.length ? 'No domains match the filters' : 'No domains yet'} action={!domains.length && <button className="btn primary" onClick={() => setAdding(true)}><Plus size={15} /> Add domains</button>}>
              {!domains.length && 'Add one or many domains at once, then point their DNS at this server.'}
            </Empty>
          }
        />
      </div>

      {adding && (
        <AddDomains
          isAdmin={isAdmin}
          groups={groups.data ?? []}
          campaigns={usable}
          onClose={() => {
            setAdding(false)
            list.reload()
          }}
          onAdded={() => list.reload()}
        />
      )}
      {editing && (
        <EditDomain
          domain={editing}
          isAdmin={isAdmin}
          groups={groups.data ?? []}
          // The picker offers editable campaigns, plus the current one if it was set by someone with more rights.
          campaigns={[...(camps.data ?? []).filter((c) => c.id === editing.campaign_id && !canEdit(c)), ...usable]}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            list.reload()
          }}
        />
      )}
      {managing && (
        <GroupsModal
          groups={groups.data ?? []}
          domains={domains}
          reload={async () => {
            await Promise.all([groups.reload(), list.reload()])
          }}
          onClose={() => setManaging(false)}
        />
      )}
    </div>
  )
}

function DomainOptions({
  v,
  set,
  groups,
  campaigns,
}: {
  v: { group_id: string; campaign_id: string; tls_mode: string; ip_source: string }
  set: (p: Partial<{ group_id: string; campaign_id: string; tls_mode: string; ip_source: string }>) => void
  groups: DomainGroup[]
  campaigns: Campaign[]
}) {
  return (
    <div className="form-grid">
      <Field label="Group">
        <Select value={v.group_id} onChange={(group_id) => set({ group_id })} placeholder="No group" options={groups.map((g) => ({ value: String(g.id), label: g.name }))} />
      </Field>
      <Field label="Default campaign" help="Served on the root URL “/” of the domain. Other campaigns stay reachable by /alias.">
        <Select value={v.campaign_id} onChange={(campaign_id) => set({ campaign_id })} placeholder="None (404 on “/”)" options={campaigns.map((c) => ({ value: String(c.id), label: c.name }))} />
      </Field>
      <Field label="TLS mode" help={TLS_MODES.find((m) => m.value === v.tls_mode)?.help}>
        <Select value={v.tls_mode} onChange={(tls_mode) => set({ tls_mode })} options={TLS_MODES} />
      </Field>
      <Field label="Real visitor IP from" help={IP_SOURCES.find((m) => m.value === v.ip_source)?.help}>
        <Select value={v.ip_source} onChange={(ip_source) => set({ ip_source })} options={IP_SOURCES} />
      </Field>
      {v.ip_source !== 'direct' && (
        <div className="span-2">
          <Notice tone="warn">Forwarding headers are only trusted from the addresses listed under Settings → Network → Trusted proxies. From any other address the socket IP is used.</Notice>
        </div>
      )}
    </div>
  )
}

const idOrNull = (s: string) => (s ? Number(s) : null)

function AddDomains({ isAdmin, groups, campaigns, onClose, onAdded }: { isAdmin: boolean; groups: DomainGroup[]; campaigns: Campaign[]; onClose: () => void; onAdded: () => void }) {
  const [names, setNames] = useState('')
  const [v, setV] = useState({ group_id: '', campaign_id: '', tls_mode: 'auto', ip_source: 'direct' })
  const [admin, setAdmin] = useState(false)
  const [result, setResult] = useState<BulkAddResult | null>(null)
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const count = names.split(/[\s,;]+/).filter(Boolean).length

  const submit = () =>
    run(async () => {
      setError('')
      try {
        const r = await post<BulkAddResult>('domains/bulk', { names, group_id: idOrNull(v.group_id), campaign_id: idOrNull(v.campaign_id), tls_mode: v.tls_mode, ip_source: v.ip_source, ...(isAdmin ? { admin_enabled: admin } : {}) })
        setResult(r)
        onAdded()
      } catch (e) {
        setError(errMsg(e))
      }
    })

  if (result) {
    const failed = result.results.filter((r) => !r.ok)
    return (
      <Modal title="Domains added" onClose={onClose} footer={<><button className="btn" onClick={() => { setResult(null); setNames(failed.map((f) => f.name).join('\n')) }}>Add more</button><button className="btn primary" onClick={onClose}>Done</button></>}>
        <Notice tone={failed.length ? 'warn' : 'ok'}>
          {result.added} added{failed.length > 0 && `, ${failed.length} refused`}. New domains are checked in the background; watch the Status column.
        </Notice>
        <div className="table-wrap" style={{ maxHeight: 340 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {result.results.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{r.name}</td>
                  <td>{r.ok ? <Badge tone="ok">added</Badge> : <span className="field-error">{r.error}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title="Add domains"
      size="lg"
      onClose={onClose}
      footer={
        <>
          {error && <div className="field-error grow">{error}</div>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || count === 0} onClick={submit}>
            {busy ? 'Adding…' : `Add ${count || ''} domain${count === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      <Field label="Domain names" help="One per line, or separated by commas or spaces. URLs and upper case are fine — they are normalised.">
        <textarea className="input mono" rows={7} autoFocus value={names} onChange={(e) => setNames(e.target.value)} placeholder={'example.com\npromo.example.net, go.example.org'} />
      </Field>
      <DomainOptions v={v} set={(p) => setV((x) => ({ ...x, ...p }))} groups={groups} campaigns={campaigns} />
      {isAdmin && (
        <Field help="The panel becomes reachable at https://domain/<admin-path>/ once the domain is verified.">
          <Toggle checked={admin} onChange={setAdmin} label="Also serve the admin panel on these domains" />
        </Field>
      )}
      <Notice>Point an A record of every domain at this server before or right after adding it; the status turns OK when the check passes.</Notice>
    </Modal>
  )
}

function EditDomain({ domain, isAdmin, groups, campaigns, onClose, onSaved }: { domain: Domain; isAdmin: boolean; groups: DomainGroup[]; campaigns: Campaign[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(domain.name)
  const [note, setNote] = useState(domain.note)
  const [v, setV] = useState({ group_id: domain.group_id === null ? '' : String(domain.group_id), campaign_id: domain.campaign_id === null ? '' : String(domain.campaign_id), tls_mode: domain.tls_mode, ip_source: domain.ip_source })
  const [admin, setAdmin] = useState(domain.admin_enabled)
  const [enabled, setEnabled] = useState(domain.enabled)
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const save = () =>
    run(async () => {
      setError('')
      try {
        await put(`domains/${domain.id}`, { name, note, group_id: idOrNull(v.group_id), campaign_id: idOrNull(v.campaign_id), tls_mode: v.tls_mode, ip_source: v.ip_source, enabled, ...(isAdmin ? { admin_enabled: admin } : {}) })
        toast.ok('Domain saved')
        onSaved()
      } catch (e) {
        setError(errMsg(e))
      }
    })
  return (
    <Modal
      title={`Edit ${domain.name}`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          {error && <div className="field-error grow">{error}</div>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={save}>
            Save
          </button>
        </>
      }
    >
      {domain.status !== 'ok' && (
        <Notice tone={domain.status === 'error' ? 'err' : 'warn'} title={`Status: ${domain.status}`}>
          {domain.status_msg || 'Waiting for the check to finish.'} {domain.checked_at && <span className="muted">(checked {fmtDateTime(domain.checked_at)})</span>}
        </Notice>
      )}
      <div className="form-grid">
        <Field label="Domain name" help="Renaming or changing the TLS mode triggers a new check.">
          <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Note">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <DomainOptions v={v} set={(p) => setV((x) => ({ ...x, ...p }))} groups={groups} campaigns={campaigns} />
      <div className="form-grid">
        {isAdmin && (
          <Field help="Serve the admin panel at https://domain/<admin-path>/.">
            <Toggle checked={admin} onChange={setAdmin} label="Panel access" />
          </Field>
        )}
        <Field help="A disabled domain answers nothing.">
          <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
        </Field>
      </div>
    </Modal>
  )
}

function GroupsModal({ groups, domains, reload, onClose }: { groups: DomainGroup[]; domains: Domain[]; reload: () => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState('')
  const [edit, setEdit] = useState<{ id: number; name: string } | null>(null)
  const [busy, run] = useBusy()
  const count = (id: number) => domains.filter((d) => d.group_id === id).length

  const create = () =>
    run(async () => {
      await post('domain-groups', { name })
      setName('')
      await reload()
    })
  const rename = () =>
    run(async () => {
      if (!edit) return
      await put(`domain-groups/${edit.id}`, { name: edit.name })
      setEdit(null)
      await reload()
    })
  const remove = async (g: DomainGroup) => {
    const n = count(g.id)
    if (!(await confirmDialog({ title: 'Delete group?', message: <>Group <b>{g.name}</b> will be deleted.{n > 0 && ` Its ${n} domain${n === 1 ? '' : 's'} are kept and become ungrouped.`}</> }))) return
    run(async () => {
      await del(`domain-groups/${g.id}`)
      await reload()
    })
  }

  return (
    <Modal title="Domain groups" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
      <form
        className="row gap"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) create()
        }}
      >
        <input className="input grow" placeholder="New group name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" disabled={busy || !name.trim()}>
          <Plus size={14} /> Create
        </button>
      </form>
      <div className="list">
        {groups.length === 0 && <div className="muted pad">No groups yet. Groups are labels for filtering and bulk actions.</div>}
        {groups.map((g) => (
          <div className="list-row" key={g.id}>
            {edit && edit.id === g.id ? (
              <form
                className="row gap grow"
                onSubmit={(e) => {
                  e.preventDefault()
                  rename()
                }}
              >
                <input className="input grow" autoFocus value={edit.name} onChange={(e) => setEdit({ id: g.id, name: e.target.value })} />
                <button className="btn small primary" disabled={busy || !edit.name.trim()}>
                  Save
                </button>
                <button type="button" className="btn small" onClick={() => setEdit(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <span className="grow strong">{g.name}</span>
                <span className="muted">{count(g.id)} domains</span>
                <button className="icon-btn" title="Rename" onClick={() => setEdit({ id: g.id, name: g.name })}>
                  <Pencil size={15} />
                </button>
                <button className="icon-btn danger" title="Delete" onClick={() => remove(g)}>
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </Modal>
  )
}
