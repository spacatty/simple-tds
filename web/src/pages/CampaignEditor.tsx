import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Copy, Download, RefreshCw, Save, Trash2 } from 'lucide-react'
import { del, errMsg, get, post, put } from '../api'
import { canEdit, canRead, isOwner, useLoad, useMeta } from '../hooks'
import type { Campaign, Domain, GeoPreset, IntegrationSnippets, Whitepage } from '../types'
import { CodeBlock, CopyButton, ErrorBox, Field, Notice, NumberInput, Segmented, Select, Skeleton, Toggle, confirmDialog, toast } from '../components/ui'
import { useDateRange } from '../components/DateRangePicker'
import StreamFunnel from './StreamFunnel'
import Simulator from './Simulator'
import Sharing from './Sharing'
import Stages from './Stages'
import { AccessBadge } from './Campaigns'
import { downloadText } from '../format'

type Tab = 'streams' | 'settings' | 'link' | 'funnel' | 'integration' | 'sharing' | 'simulator'
const TABS: { value: Tab; label: string }[] = [
  { value: 'streams', label: 'Streams' },
  { value: 'settings', label: 'Settings' },
  { value: 'link', label: 'Link' },
  { value: 'funnel', label: 'Funnel' },
  { value: 'integration', label: 'Integration' },
  { value: 'sharing', label: 'Sharing' },
  { value: 'simulator', label: 'Simulator' },
]

interface Form {
  name: string
  rotation: string
  cost_model: string
  cost_value: number | ''
  currency: string
  unique_hours: number | ''
  note: string
}
const formOf = (c: Campaign): Form => ({ name: c.name, rotation: c.rotation, cost_model: c.cost_model, cost_value: c.cost_value, currency: c.currency, unique_hours: c.unique_hours, note: c.note })

export default function CampaignEditor() {
  const params = useParams()
  const nav = useNavigate()
  const [search] = useSearchParams()
  const id = Number(params.id)

  // The API has no single-campaign GET; the list is small and also feeds the "send to campaign" action.
  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])
  const wps = useLoad(() => get<Whitepage[]>('whitepages'), [])
  const presets = useLoad(() => get<GeoPreset[]>('geo-presets'), [])
  const domains = useLoad(() => get<Domain[]>('domains'), [])
  const [range, setRange] = useDateRange()

  const campaign = camps.data?.find((c) => c.id === id)
  const editable = canEdit(campaign)
  const owner = isOwner(campaign)
  // Integration snippets carry the campaign secret (editors only); sharing is the owner's business.
  const tabs = TABS.filter((t) => (t.value === 'integration' ? editable : t.value === 'sharing' ? owner : true))
  // The tab lives in the query (?tab=settings) so reload and Back keep it; /campaigns/1/<tab> links from before still work.
  const wanted = search.get('tab') ?? params.tab ?? 'streams'
  const tab: Tab = tabs.some((t) => t.value === wanted) ? (wanted as Tab) : 'streams'

  // The settings form lives here so the header's Save button can submit it.
  const [form, setForm] = useState<Form | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  useEffect(() => {
    setForm(campaign ? formOf(campaign) : null)
    setFormError('')
    // Reset only when another campaign is opened, not on every list refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaign?.id])
  const dirty = !!campaign && !!form && JSON.stringify(form) !== JSON.stringify(formOf(campaign))

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // One domain choice shared by the Link and Integration tabs.
  const sortedDomains = useMemo(() => [...(domains.data ?? [])].sort((a, b) => Number(b.status === 'ok') - Number(a.status === 'ok') || a.name.localeCompare(b.name)), [domains.data])
  const [domain, setDomain] = useState('')
  useEffect(() => {
    if (!domain && sortedDomains.length) setDomain((sortedDomains.find((d) => d.enabled && d.status === 'ok') ?? sortedDomains[0]).name)
  }, [sortedDomains, domain])

  const update = (c: Campaign) => camps.setData((camps.data ?? []).map((x) => (x.id === c.id ? { ...x, ...c, access: x.access, owner_name: x.owner_name } : x)))

  const save = async () => {
    if (!form || !campaign) return
    setSaving(true)
    setFormError('')
    try {
      const c = await put<Campaign>(`campaigns/${campaign.id}`, {
        name: form.name,
        rotation: form.rotation,
        cost_model: form.cost_model,
        cost_value: form.cost_value === '' ? 0 : form.cost_value,
        currency: form.currency.trim().toUpperCase(),
        unique_hours: form.unique_hours === '' ? 24 : form.unique_hours,
        note: form.note,
      })
      update(c)
      setForm(formOf(c))
      toast.ok('Campaign saved')
    } catch (e) {
      setFormError(errMsg(e))
      nav(`/campaigns/${id}?tab=settings`, { replace: true })
    } finally {
      setSaving(false)
    }
  }
  /** Runs go() unless the Settings form has unsaved edits the user wants to keep. */
  const leave = async (go: () => void) => {
    if (tab === 'settings' && dirty && campaign) {
      const ok = await confirmDialog({ title: 'Discard unsaved settings?', confirmLabel: 'Discard', message: 'The campaign settings you changed have not been saved.' })
      if (!ok) return
      setForm(formOf(campaign))
    }
    go()
  }
  const goTab = (t: Tab) => {
    if (t === tab) return
    // Switching tabs also drops the simulator prefill parameters.
    leave(() => nav(`/campaigns/${id}${t === 'streams' ? '' : '?tab=' + t}`))
  }
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
      nav(`/campaigns/${n.id}`)
    } catch (e) {
      toast.err(e)
    }
  }
  const remove = async () => {
    if (!campaign) return
    if (!(await confirmDialog({ title: 'Delete campaign?', message: <><b>{campaign.name}</b> and all of its streams will be deleted and its link stops working. Collected statistics are kept.</> }))) return
    try {
      await del(`campaigns/${id}`)
      toast.ok('Campaign deleted')
      nav('/campaigns')
    } catch (e) {
      toast.err(e)
    }
  }
  const regenerate = async () => {
    if (!campaign) return
    const ok = await confirmDialog({
      title: 'Generate a new link?',
      confirmLabel: 'Regenerate',
      message: (
        <>
          <b>The current link stops working immediately.</b> Every ad, landing page, JavaScript snippet and tds.php that uses it has to be updated with the new one, or that traffic gets a 404.
        </>
      ),
    })
    if (!ok) return
    try {
      update(await post<Campaign>(`campaigns/${id}/alias`))
      toast.ok('New link generated — update it wherever the old one was used')
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
  if (!campaign || !form) {
    if (campaign) return null
    return (
      <div className="page">
        <ErrorBox error={camps.error || 'Campaign not found'} retry={camps.error ? camps.reload : undefined} />
        <Link to="/campaigns">← Back to campaigns</Link>
      </div>
    )
  }
  // "Stats only" shares have no editor access at all.
  if (!canRead(campaign)) return <Navigate to={`/reports?campaign_id=${campaign.id}`} replace />

  const d = (domains.data ?? []).find((x) => x.name === domain)
  const domainSelect = (
    <Field label="Domain">
      <Select
        value={domain}
        onChange={setDomain}
        placeholder={sortedDomains.length ? undefined : 'YOUR-DOMAIN (no domains added)'}
        options={sortedDomains.map((x) => ({ value: x.name, label: `${x.name}${x.status !== 'ok' ? ` (${x.status})` : ''}${x.enabled ? '' : ' (disabled)'}` }))}
      />
      {sortedDomains.length === 0 && !domains.loading && (
        <div className="field-help">
          No domains yet — <Link to="/domains">add one</Link> to get a working link.
        </div>
      )}
      {d && d.status !== 'ok' && <div className="field-error">This domain has not passed its check yet ({d.status_msg || d.status}).</div>}
    </Field>
  )

  return (
    <div className="ce">
      <header className="ce-head">
        <button className="icon-btn" onClick={() => leave(() => nav('/campaigns'))} title="Back to campaigns" aria-label="Back to campaigns">
          <ArrowLeft size={17} />
        </button>
        <div className="ce-title">
          <h1 className="ellipsis">{form.name || campaign.name}</h1>
          <AccessBadge c={campaign} />
          {!campaign.enabled && <span className="badge warn" title="The campaign link answers 404 until it is enabled">disabled</span>}
        </div>
        <span className="grow" />
        <Toggle checked={campaign.enabled} disabled={!editable} onChange={setEnabled} label={campaign.enabled ? 'Enabled' : 'Disabled'} />
        {/* Save belongs to the Settings form, so it only shows there. */}
        {editable && tab === 'settings' && (
          <button className="btn primary" disabled={saving || !dirty || !form.name.trim()} onClick={save} title={dirty ? 'Save the campaign settings' : 'No unsaved settings'}>
            <Save size={14} /> {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        )}
        <button className="btn" onClick={clone} title="Copy this campaign and its streams into a new campaign of your own">
          <Copy size={14} /> Clone
        </button>
        {owner && (
          <button className="btn danger-outline" onClick={remove}>
            <Trash2 size={14} /> Delete
          </button>
        )}
      </header>

      <div className="ce-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.value} role="tab" aria-selected={t.value === tab} className={t.value === tab ? 'active' : ''} onClick={() => goTab(t.value)}>
            {t.label}
            {t.value === 'settings' && dirty && <i className="dot warn" title="Unsaved changes" />}
          </button>
        ))}
      </div>

      <div className={'ce-content' + (tab === 'streams' ? ' wide' : '')}>
        {!editable && (
          <Notice>
            <b>Read-only.</b> {campaign.owner_name || 'The owner'} shared this campaign with you for viewing: you can inspect it and use the simulator, but not change anything.
          </Notice>
        )}
        {editable && !owner && tab !== 'streams' && (
          <Notice>
            Shared by <b>{campaign.owner_name || 'its owner'}</b> with edit access. Only the owner can share or delete it.
          </Notice>
        )}

        {/* Streams take the whole width; the other tabs are forms at a readable width. */}
        {tab === 'streams' && <StreamFunnel key={id} campaign={campaign} campaigns={camps.data ?? []} whitepages={wps.data ?? []} presets={presets.data ?? []} readOnly={!editable} range={range} setRange={setRange} />}

        {tab === 'settings' && (
          <div className="ce-form card">
            <div className="card-body">
              <SettingsForm form={form} setForm={setForm} campaign={campaign} readOnly={!editable} error={formError} setEnabled={setEnabled} />
              {editable && (
                <div className="form-actions">
                  <button className="btn primary" disabled={saving || !dirty || !form.name.trim()} onClick={save}>
                    <Save size={14} /> {saving ? 'Saving…' : 'Save changes'}
                  </button>
                  {dirty && (
                    <button className="btn ghost" onClick={() => setForm(formOf(campaign))}>
                      Discard
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'link' && (
          <div className="ce-form card">
            <div className="card-body">
              {domainSelect}
              <Field label="Campaign link" help="Send traffic here. Append your own parameters: ?sub1=..&sub2=..&keyword=..">
                <div className="url-line">
                  <code>{`https://${domain || 'YOUR-DOMAIN'}/${campaign.alias}`}</code>
                  <CopyButton text={`https://${domain || 'YOUR-DOMAIN'}/${campaign.alias}`} label="Copy" />
                </div>
              </Field>
              {d && d.campaign_id === campaign.id && (
                <Field label="Domain root" help="This campaign is the default campaign of the domain, so it also answers on “/”.">
                  <div className="url-line">
                    <code>{`https://${d.name}/`}</code>
                    <CopyButton text={`https://${d.name}/`} label="Copy" />
                  </div>
                </Field>
              )}
              <div className="field-help">The link ID is generated by the server and cannot be chosen: a long random string cannot be guessed or enumerated.</div>
              {editable && (
                <div className="form-actions">
                  <button className="btn danger-outline" onClick={regenerate}>
                    <RefreshCw size={14} /> Regenerate link
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'funnel' && (
          <div className="ce-form">
            <Stages key={id} campaign={campaign} domain={domain} range={range} readOnly={!editable} onSaved={update} />
          </div>
        )}
        {tab === 'integration' && editable && (
          <div className="ce-form card">
            <div className="card-body">
              <IntegrationPane campaign={campaign} domain={domain} domainSelect={domainSelect} ready={!domains.loading} />
            </div>
          </div>
        )}
        {tab === 'sharing' && owner && (
          <div className="ce-form">
            <Sharing key={id} campaign={campaign} />
          </div>
        )}
        {tab === 'simulator' && (
          <div className="ce-sim">
            <Simulator
              key={id + '|' + search.toString()}
              campaign={campaign}
              domains={domains.data ?? []}
              prefill={{ ip: search.get('ip') ?? undefined, user_agent: search.get('ua') ?? undefined, language: search.get('lang') ?? undefined, referer: search.get('referer') ?? undefined, query: search.get('query') ?? undefined, domain: search.get('domain') ?? undefined }}
            />
          </div>
        )}
      </div>
    </div>
  )
}

function SettingsForm({ form: f, setForm, campaign, readOnly, error, setEnabled }: { form: Form; setForm: (f: Form) => void; campaign: Campaign; readOnly: boolean; error: string; setEnabled: (v: boolean) => void }) {
  const meta = useMeta()
  const set = (patch: Partial<Form>) => setForm({ ...f, ...patch })
  const costHelp: Record<string, string> = {
    none: 'No cost is recorded.',
    cpc: 'Cost per click: charged for every click.',
    cpuc: 'Cost per unique click: charged only for unique visitors.',
    cpm: 'Cost per 1000 clicks.',
    cpa: 'Cost per conversion: charged when a conversion arrives.',
    revshare: 'Percentage of the conversion revenue.',
  }
  return (
    <fieldset className="plain" disabled={readOnly}>
      <div className="form-grid">
      <Field label="Name" error={!f.name.trim() ? 'Name is required' : ''}>
        <input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Status" help="Applies immediately. A disabled campaign answers 404.">
        <Toggle checked={campaign.enabled} onChange={setEnabled} label={campaign.enabled ? 'Enabled' : 'Disabled'} />
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
        <Field label="Currency" style={{ width: 96 }}>
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
      {error && <div className="field-error">{error}</div>}
    </fieldset>
  )
}

type IntegrationKind = 'direct' | 'js' | 'php'
const HOWTO: Record<IntegrationKind, string> = {
  direct: 'Send traffic straight to the tracker. Supports every action, the JS check and cookies.',
  js: 'Paste into the <head> of a page hosted elsewhere. The tracker decides in the background and either redirects, replaces the page content, or does nothing. The page URL and referrer are passed along automatically.',
  php: 'Server-side integration for PHP sites: upload the file next to your page and require it as the very first line. The visitor never sees the tracker domain. The file contains this campaign’s secret token — keep it private.',
}

function IntegrationPane({ campaign, domain, domainSelect, ready }: { campaign: Campaign; domain: string; domainSelect: ReactNode; ready: boolean }) {
  const [kind, setKind] = useState<IntegrationKind>('direct')
  const snip = useLoad(() => (ready ? get<IntegrationSnippets>(`campaigns/${campaign.id}/integration`, { domain }) : Promise.resolve(undefined)), [campaign.id, domain, ready, campaign.alias])
  const s = snip.data
  return (
    <div>
      <Field label="Integration type">
        <Select
          value={kind}
          onChange={(v) => setKind(v as IntegrationKind)}
          options={[
            { value: 'direct', label: 'Direct link' },
            { value: 'js', label: 'JavaScript snippet' },
            { value: 'php', label: 'PHP include' },
          ]}
        />
      </Field>
      {domainSelect}
      <p className="muted">{HOWTO[kind]}</p>
      <ErrorBox error={snip.error} retry={snip.reload} />
      {!s ? (
        !snip.error && <Skeleton rows={4} />
      ) : kind === 'direct' ? (
        <>
          <div className="url-line">
            <code>{s.direct_url}</code>
            <CopyButton text={s.direct_url} label="Copy" />
          </div>
          <div className="field-help">{s.direct_note}</div>
        </>
      ) : kind === 'js' ? (
        <CodeBlock text={s.js} maxHeight={320} />
      ) : (
        <>
          <div className="field-help" style={{ marginBottom: 8 }}>
            First line of your page: <code>{`require __DIR__ . '/${s.php_filename}';`}</code>
          </div>
          <CodeBlock
            text={s.php}
            maxHeight={380}
            actions={
              <button className="btn small" onClick={() => downloadText(s.php_filename, s.php, 'application/x-httpd-php')}>
                <Download size={14} /> {s.php_filename}
              </button>
            }
          />
        </>
      )}
    </div>
  )
}
