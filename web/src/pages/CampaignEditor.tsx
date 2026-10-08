import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Copy, Download, Trash2 } from 'lucide-react'
import { del, errMsg, get, post, put } from '../api'
import { canEdit, canRead, isOwner, useLoad, useMeta } from '../hooks'
import type { Campaign, Domain, GeoPreset, IntegrationSnippets, Whitepage } from '../types'
import { Card, CodeBlock, CopyButton, ErrorBox, Field, Notice, NumberInput, Segmented, Select, Skeleton, Tabs, Toggle, confirmDialog, toast, useBusy } from '../components/ui'
import StreamFunnel from './StreamFunnel'
import Simulator from './Simulator'
import Sharing from './Sharing'
import { AccessBadge } from './Campaigns'
import { downloadText } from '../format'

type Tab = 'streams' | 'settings' | 'integration' | 'simulator' | 'sharing'
const TABS: { value: Tab; label: string }[] = [
  { value: 'streams', label: 'Streams' },
  { value: 'settings', label: 'Settings' },
  { value: 'integration', label: 'Integration' },
  { value: 'simulator', label: 'Simulator' },
  { value: 'sharing', label: 'Sharing' },
]

export default function CampaignEditor() {
  const params = useParams()
  const nav = useNavigate()
  const id = Number(params.id)

  // The API has no single-campaign GET; the list is small and also feeds the "send to campaign" action.
  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])
  const wps = useLoad(() => get<Whitepage[]>('whitepages'), [])
  const presets = useLoad(() => get<GeoPreset[]>('geo-presets'), [])
  const domains = useLoad(() => get<Domain[]>('domains'), [])

  const campaign = camps.data?.find((c) => c.id === id)
  const editable = canEdit(campaign)
  const owner = isOwner(campaign)
  // Integration snippets carry the campaign secret (editors only); sharing is the owner's business.
  const tabs = TABS.filter((t) => (t.value === 'integration' ? editable : t.value === 'sharing' ? owner : true))
  const tab: Tab = tabs.some((t) => t.value === params.tab) ? (params.tab as Tab) : 'streams'

  const update = (c: Campaign) => camps.setData((camps.data ?? []).map((x) => (x.id === c.id ? c : x)))

  const setEnabled = async (enabled: boolean) => {
    try {
      update(await put<Campaign>(`campaigns/${id}`, { enabled }))
    } catch (e) {
      toast.err(e)
    }
  }
  const clone = async () => {
    try {
      const n = await post<Campaign>(`campaigns/${id}/clone`)
      await camps.reload()
      toast.ok(`Cloned as “${n.name}”`)
      nav(`/campaigns/${n.id}/settings`)
    } catch (e) {
      toast.err(e)
    }
  }
  const remove = async () => {
    if (!campaign) return
    if (!(await confirmDialog({ title: 'Delete campaign?', message: <><b>{campaign.name}</b> and all of its streams will be deleted. Collected statistics are kept.</> }))) return
    try {
      await del(`campaigns/${id}`)
      toast.ok('Campaign deleted')
      nav('/campaigns')
    } catch (e) {
      toast.err(e)
    }
  }

  if (camps.loading && !camps.data) {
    return (
      <div className="page">
        <Skeleton rows={8} height={18} />
      </div>
    )
  }
  if (!campaign) {
    return (
      <div className="page">
        <ErrorBox error={camps.error || 'Campaign not found'} retry={camps.error ? camps.reload : undefined} />
        <Link to="/campaigns">← Back to campaigns</Link>
      </div>
    )
  }

  // "Stats only" shares have no editor access at all.
  if (!canRead(campaign)) return <Navigate to={`/reports?campaign_id=${campaign.id}`} replace />

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Link to="/campaigns" className="back">
            <ArrowLeft size={14} /> Campaigns
          </Link>
          <h1>
            {campaign.name} <code className="alias">/{campaign.alias}</code> <AccessBadge c={campaign} />
          </h1>
        </div>
        <div className="page-actions">
          <Toggle checked={campaign.enabled} disabled={!editable} onChange={setEnabled} label={campaign.enabled ? 'Enabled' : 'Disabled'} />
          <button className="btn" onClick={clone} title="Copy this campaign and its streams into a new campaign of your own">
            <Copy size={14} /> Clone
          </button>
          {owner && (
            <button className="btn danger-outline" onClick={remove}>
              <Trash2 size={14} /> Delete
            </button>
          )}
        </div>
      </div>

      <Tabs value={tab} onChange={(t) => nav(`/campaigns/${id}${t === 'streams' ? '' : '/' + t}`, { replace: true })} tabs={tabs} />

      {!campaign.enabled && <Notice tone="warn">This campaign is disabled: its URL answers 404 until you enable it.</Notice>}

      {!editable && (
        <Notice>
          <b>Read-only.</b> {campaign.owner_name || 'The owner'} shared this campaign with you for viewing: you can inspect streams and settings and use the simulator, but not change anything.
        </Notice>
      )}
      {editable && !owner && (
        <Notice>
          Shared with you by <b>{campaign.owner_name || 'its owner'}</b> with edit access. You can change streams and settings; only the owner can share or delete the campaign.
        </Notice>
      )}

      {tab === 'streams' && <StreamFunnel key={id} campaign={campaign} campaigns={camps.data ?? []} whitepages={wps.data ?? []} presets={presets.data ?? []} readOnly={!editable} />}
      {tab === 'settings' && <SettingsTab key={id} campaign={campaign} onSaved={update} readOnly={!editable} />}
      {tab === 'sharing' && owner && <Sharing key={id} campaign={campaign} />}
      {tab === 'integration' && editable && <IntegrationTab key={id} campaign={campaign} domains={domains.data ?? []} domainsLoading={domains.loading} />}
      {tab === 'simulator' && <Simulator key={id} campaign={campaign} domains={domains.data ?? []} />}
    </div>
  )
}

function SettingsTab({ campaign, onSaved, readOnly }: { campaign: Campaign; onSaved: (c: Campaign) => void; readOnly: boolean }) {
  const meta = useMeta()
  const [f, setF] = useState({ ...campaign, cost_value: campaign.cost_value as number | '', unique_hours: campaign.unique_hours as number | '' })
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }))
  const dirty = useMemo(
    () => (['name', 'alias', 'enabled', 'rotation', 'cost_model', 'cost_value', 'currency', 'unique_hours', 'note'] as const).some((k) => f[k] !== campaign[k]),
    [f, campaign],
  )
  const aliasErr = !/^[A-Za-z0-9_-]{1,64}$/.test(f.alias) ? 'Only letters, digits, - and _ (1–64 characters)' : meta.reserved_aliases.includes(f.alias.toLowerCase()) ? 'This alias is reserved' : ''

  const save = () =>
    run(async () => {
      setError('')
      try {
        const c = await put<Campaign>(`campaigns/${campaign.id}`, {
          name: f.name,
          alias: f.alias,
          enabled: f.enabled,
          rotation: f.rotation,
          cost_model: f.cost_model,
          cost_value: f.cost_value === '' ? 0 : f.cost_value,
          currency: f.currency.trim().toUpperCase(),
          unique_hours: f.unique_hours === '' ? 24 : f.unique_hours,
          note: f.note,
        })
        onSaved(c)
        setF({ ...c })
        toast.ok('Campaign saved')
      } catch (e) {
        setError(errMsg(e))
      }
    })

  const costHelp: Record<string, string> = {
    none: 'No cost is recorded.',
    cpc: 'Cost per click: charged for every click.',
    cpuc: 'Cost per unique click: charged only for unique visitors.',
    cpm: 'Cost per 1000 clicks.',
    cpa: 'Cost per conversion: charged when a conversion arrives.',
    revshare: 'Percentage of the conversion revenue.',
  }

  return (
    <Card title="Campaign settings">
      <fieldset className="plain" disabled={readOnly}>
      <div className="form-grid narrow">
        <Field label="Name" error={!f.name.trim() ? 'Name is required' : ''}>
          <input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Alias" help="The campaign URL is https://your-domain/<alias>. Changing it breaks links already in use." error={aliasErr}>
          <input className="input mono" value={f.alias} onChange={(e) => set({ alias: e.target.value.trim() })} />
        </Field>
        <Field label="Status">
          <Toggle checked={f.enabled} onChange={(enabled) => set({ enabled })} label={f.enabled ? 'Enabled' : 'Disabled'} />
        </Field>
        <Field label="Rotation of regular streams" help={f.rotation === 'weight' ? 'Weight: among the regular streams whose filters match, one is drawn at random in proportion to its weight.' : 'Position: regular streams are checked top to bottom and the first match wins.'}>
          <Segmented
            value={f.rotation}
            onChange={(rotation) => set({ rotation })}
            options={[
              { value: 'position', label: 'Position' },
              { value: 'weight', label: 'Weight' },
            ]}
          />
        </Field>
        <Field label="Cost model" help={costHelp[f.cost_model]}>
          <Select value={f.cost_model} onChange={(cost_model) => set({ cost_model })} options={meta.cost_models.map((m) => ({ value: m, label: m === 'none' ? 'None' : m.toUpperCase() }))} />
        </Field>
        <div className="row gap">
          <Field label={f.cost_model === 'revshare' ? 'Share, %' : 'Cost value'} className="grow">
            <NumberInput value={f.cost_value} min={0} step="any" disabled={f.cost_model === 'none'} onChange={(cost_value) => set({ cost_value })} />
          </Field>
          <Field label="Currency" style={{ width: 110 }}>
            <input className="input mono" maxLength={8} value={f.currency} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} />
          </Field>
        </div>
        <Field label="Uniqueness window, hours" help="A visitor (IP + User-Agent) counts as unique once per this period.">
          <NumberInput value={f.unique_hours} min={1} onChange={(unique_hours) => set({ unique_hours })} />
        </Field>
        <Field label="Note" className="span-2">
          <textarea className="input" rows={3} value={f.note} onChange={(e) => set({ note: e.target.value })} />
        </Field>
      </div>
      </fieldset>
      {error && <div className="field-error">{error}</div>}
      {!readOnly && (
        <div className="form-actions">
          <button className="btn primary" disabled={busy || !dirty || !f.name.trim() || !!aliasErr} onClick={save}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          {dirty && (
            <button className="btn ghost" onClick={() => setF({ ...campaign })}>
              Discard
            </button>
          )}
        </div>
      )}
    </Card>
  )
}

function IntegrationTab({ campaign, domains, domainsLoading }: { campaign: Campaign; domains: Domain[]; domainsLoading: boolean }) {
  const usable = useMemo(() => [...domains].sort((a, b) => Number(b.status === 'ok') - Number(a.status === 'ok') || a.name.localeCompare(b.name)), [domains])
  const [domain, setDomain] = useState('')
  useEffect(() => {
    if (!domain && usable.length) setDomain((usable.find((d) => d.enabled && d.status === 'ok') ?? usable[0]).name)
  }, [usable, domain])

  const snip = useLoad(() => (domainsLoading ? Promise.resolve(undefined) : get<IntegrationSnippets>(`campaigns/${campaign.id}/integration`, { domain })), [campaign.id, domain, domainsLoading, campaign.alias])
  const d = domains.find((x) => x.name === domain)
  const s = snip.data

  return (
    <div className="stack">
      <Card title="Domain">
        <div className="row gap wrap">
          <Field label="Build snippets for" style={{ minWidth: 320 }}>
            <Select
              value={domain}
              onChange={setDomain}
              placeholder={domains.length ? undefined : 'YOUR-DOMAIN (no domains added)'}
              options={usable.map((x) => ({ value: x.name, label: `${x.name}${x.status !== 'ok' ? ` (${x.status})` : ''}${x.enabled ? '' : ' (disabled)'}` }))}
            />
          </Field>
          {domains.length === 0 && !domainsLoading && (
            <Notice tone="warn">
              No domains yet — the snippets use a placeholder. <Link to="/domains">Add a domain</Link> first.
            </Notice>
          )}
          {d && d.status !== 'ok' && <Notice tone="warn">This domain has not passed its check yet ({d.status_msg || d.status}); the URLs will not work until it does.</Notice>}
          {d && d.campaign_id === campaign.id && <Notice tone="ok">This campaign is also served on the root of the domain: https://{d.name}/</Notice>}
        </div>
      </Card>
      <ErrorBox error={snip.error} retry={snip.reload} />
      {!s ? (
        <Skeleton rows={6} />
      ) : (
        <>
          <Card title="1. Direct link" actions={<CopyButton text={s.direct_url} label="Copy URL" />}>
            <p className="muted">Send traffic straight to the tracker. Supports every action, the JS check and cookies.</p>
            <div className="url-line">
              <code>{s.direct_url}</code>
            </div>
            <div className="field-help">{s.direct_note}</div>
          </Card>
          <Card title="2. JavaScript snippet">
            <p className="muted">
              Paste into the &lt;head&gt; of a page hosted elsewhere. The tracker decides in the background and either redirects, replaces the page content, or does nothing. The page URL and referrer are passed along automatically.
            </p>
            <CodeBlock text={s.js} />
          </Card>
          <Card title={`3. PHP include (${s.php_filename})`}>
            <p className="muted">
              Server-side integration for PHP sites: upload the file next to your page and add <code>require __DIR__ . '/{s.php_filename}';</code> as the very first line. The visitor never sees the tracker domain. The file contains this campaign's secret token — keep it private.
            </p>
            <CodeBlock
              text={s.php}
              maxHeight={360}
              actions={
                <button className="btn small" onClick={() => downloadText(s.php_filename, s.php, 'application/x-httpd-php')}>
                  <Download size={14} /> Download {s.php_filename}
                </button>
              }
            />
          </Card>
        </>
      )}
    </div>
  )
}
