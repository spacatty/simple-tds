import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { BarChart3, Copy, Eye, Pencil, Plus, Trash2 } from 'lucide-react'
import { del, get, post, put } from '../api'
import { canEdit, canRead, isOwner, useLoad, useMeta } from '../hooks'
import type { Campaign, ReportRow } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { Badge, Empty, ErrorBox, Field, Modal, PageHeader, SearchInput, Toggle, confirmDialog, toast, useBusy } from '../components/ui'
import { presetRange } from '../components/DateRangePicker'
import { loadReport } from '../reports'
import { fmtInt, fmtMoney } from '../format'
import { errMsg } from '../api'

export function costLabel(c: Campaign): string {
  if (c.cost_model === 'none') return '—'
  const v = c.cost_model === 'revshare' ? `${c.cost_value}%` : fmtMoney(c.cost_value, c.currency)
  return `${c.cost_model.toUpperCase()} · ${v}`
}

export const ACCESS_LABEL: Record<string, string> = { edit: 'Can edit', read: 'Read-only', stats: 'Stats only' }

/** Where a campaign name leads: the editor, or its reports when only statistics are shared. */
export function campaignLink(c: Campaign): string {
  return canRead(c) ? `/campaigns/${c.id}` : `/reports?campaign_id=${c.id}`
}

/** Badge for campaigns shared with the viewer; nothing for their own. */
export function AccessBadge({ c }: { c: Campaign }) {
  if (!c.access || c.access === 'owner') return null
  return (
    <Badge tone={c.access === 'edit' ? 'info' : 'neutral'} title={`Shared with you by ${c.owner_name || 'its owner'}: ${ACCESS_LABEL[c.access] ?? c.access}`}>
      {ACCESS_LABEL[c.access] ?? c.access}
    </Badge>
  )
}

export default function Campaigns() {
  const nav = useNavigate()
  const list = useLoad(() => get<Campaign[]>('campaigns'), [])
  const today = useLoad(() => loadReport('campaign', presetRange('today')), [])
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)

  const stats = useMemo(() => new Map<string, ReportRow>((today.data ?? []).map((r) => [r.key, r])), [today.data])
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (list.data ?? []).filter((c) => !s || c.name.toLowerCase().includes(s) || c.alias.toLowerCase().includes(s))
  }, [list.data, q])

  const setEnabled = async (c: Campaign, enabled: boolean) => {
    try {
      await put(`campaigns/${c.id}`, { enabled })
      list.setData((list.data ?? []).map((x) => (x.id === c.id ? { ...x, enabled } : x)))
    } catch (e) {
      toast.err(e)
    }
  }
  const clone = async (c: Campaign) => {
    try {
      const n = await post<Campaign>(`campaigns/${c.id}/clone`)
      toast.ok(`Cloned as “${n.name}”`)
      nav(`/campaigns/${n.id}/settings`)
    } catch (e) {
      toast.err(e)
    }
  }
  const remove = async (c: Campaign) => {
    const ok = await confirmDialog({
      title: 'Delete campaign?',
      message: (
        <>
          <b>{c.name}</b> and all of its streams will be deleted. Links to <code>/{c.alias}</code> will start returning 404. Collected statistics are kept.
        </>
      ),
    })
    if (!ok) return
    try {
      await del(`campaigns/${c.id}`)
      toast.ok('Campaign deleted')
      list.reload()
    } catch (e) {
      toast.err(e)
    }
  }

  const columns: Column<Campaign>[] = [
    {
      key: 'name',
      title: 'Name',
      sort: (c) => c.name.toLowerCase(),
      render: (c) => (
        <div>
          <span className="row gap-s">
            <Link to={campaignLink(c)} className="strong" title={canRead(c) ? undefined : 'Only statistics are shared with you: opens the reports for this campaign'}>
              {c.name}
            </Link>
            <AccessBadge c={c} />
            {c.access && c.access !== 'owner' && c.owner_name && <span className="muted small">by {c.owner_name}</span>}
          </span>
          {c.note && <div className="muted small ellipsis" style={{ maxWidth: 360 }}>{c.note}</div>}
        </div>
      ),
    },
    { key: 'alias', title: 'Alias', sort: (c) => c.alias, render: (c) => <code>/{c.alias}</code> },
    { key: 'enabled', title: 'Status', width: 90, sort: (c) => (c.enabled ? 1 : 0), render: (c) => <Toggle checked={c.enabled} disabled={!canEdit(c)} onChange={(v) => setEnabled(c, v)} title={!canEdit(c) ? 'You cannot change this campaign' : c.enabled ? 'Enabled' : 'Disabled'} /> },
    { key: 'rotation', title: 'Rotation', render: (c) => <Badge>{c.rotation}</Badge> },
    { key: 'cost', title: 'Cost model', render: (c) => costLabel(c) },
    { key: 'clicks', title: 'Clicks today', align: 'right', sort: (c) => stats.get(String(c.id))?.clicks ?? 0, render: (c) => fmtInt(stats.get(String(c.id))?.clicks ?? 0) },
    { key: 'conv', title: 'Conv. today', align: 'right', sort: (c) => stats.get(String(c.id))?.conversions ?? 0, render: (c) => fmtInt(stats.get(String(c.id))?.conversions ?? 0) },
    {
      key: 'actions',
      title: '',
      align: 'right',
      width: 120,
      render: (c) => (
        <div className="row-actions">
          {canRead(c) ? (
            <Link className="icon-btn" to={`/campaigns/${c.id}`} title={canEdit(c) ? 'Edit' : 'View (read-only)'}>
              {canEdit(c) ? <Pencil size={15} /> : <Eye size={15} />}
            </Link>
          ) : (
            <Link className="icon-btn" to={campaignLink(c)} title="Reports for this campaign">
              <BarChart3 size={15} />
            </Link>
          )}
          {canRead(c) && (
            <button className="icon-btn" title="Clone with streams into a campaign of your own" onClick={() => clone(c)}>
              <Copy size={15} />
            </button>
          )}
          {isOwner(c) && (
            <button className="icon-btn danger" title="Delete" onClick={() => remove(c)}>
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ),
    },
  ]

  return (
    <div className="page">
      <PageHeader title="Campaigns" sub="Each campaign is a URL that routes visitors through its streams.">
        <SearchInput value={q} onChange={setQ} />
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={15} /> New campaign
        </button>
      </PageHeader>
      <ErrorBox error={list.error} retry={list.reload} />
      {today.error && <ErrorBox error={'Today’s statistics are unavailable: ' + today.error} />}
      <div className="card">
        <DataTable
          columns={columns}
          rows={list.data ? rows : undefined}
          rowKey={(c) => c.id}
          loading={list.loading}
          empty={
            <Empty title={q ? 'No campaigns match the search' : 'No campaigns yet'} action={!q && <button className="btn primary" onClick={() => setCreating(true)}><Plus size={15} /> Create the first campaign</button>}>
              {!q && 'Create a campaign, add streams with filters, and point a domain at it.'}
            </Empty>
          }
        />
      </div>
      {creating && <CreateCampaign onClose={() => setCreating(false)} onCreated={(c) => nav(`/campaigns/${c.id}`)} />}
    </div>
  )
}

function CreateCampaign({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Campaign) => void }) {
  const meta = useMeta()
  const [name, setName] = useState('')
  const [alias, setAlias] = useState('')
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const aliasErr = alias && !/^[A-Za-z0-9_-]{1,64}$/.test(alias) ? 'Only letters, digits, - and _' : meta.reserved_aliases.includes(alias.toLowerCase()) ? 'This alias is reserved' : ''
  const submit = () =>
    run(async () => {
      setError('')
      try {
        const c = await post<Campaign>('campaigns', { name, alias, enabled: true })
        toast.ok('Campaign created')
        onCreated(c)
      } catch (e) {
        setError(errMsg(e))
      }
    })
  return (
    <Modal
      title="New campaign"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name.trim() || !!aliasErr} onClick={submit}>
            Create
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && !aliasErr) submit()
        }}
      >
        <Field label="Name">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="FB · DE · sweepstakes" />
        </Field>
        <Field label="Alias" help="The campaign URL is https://your-domain/<alias>. Leave empty to generate a random one." error={aliasErr}>
          <input className="input mono" value={alias} onChange={(e) => setAlias(e.target.value.trim())} placeholder="random" />
        </Field>
        {error && <div className="field-error">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
