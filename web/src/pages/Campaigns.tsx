import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, BarChart3, Copy, Eye, FlaskConical, Folder, FolderCog, FolderMinus, MousePointerClick, Pencil, Plus, RefreshCw, Trash2, Users } from 'lucide-react'
import { del, get, post, put } from '../api'
import { canEdit, canRead, isOwner, useLoad } from '../hooks'
import type { Campaign, CampaignGroup, Domain, FunnelPreset, ReportRow, Stream } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { ActionMenu } from '../components/ActionMenu'
import { StatBar } from '../components/StatBar'
import type { Metric } from '../components/StatBar'
import { reloadCampaignGroups, useCampaignGroups } from '../campaignGroups'
import { Badge, CopyButton, Empty, ErrorBox, Field, Modal, PageHeader, SearchInput, Segmented, Select, Toggle, confirmDialog, toast, useBusy } from '../components/ui'
import { DateRangePicker, useDateRange } from '../components/DateRangePicker'
import { loadReport, sumRows } from '../reports'
import { buildSearch } from '../filters'
import { fmtInt, fmtMoney, fmtPct, ratioPct } from '../format'
import { errMsg } from '../api'
import { t, tn, tx } from '../i18n'
import FunnelDrawer from './FunnelDrawer'
import { GroupsModal, ownsGroup } from './CampaignGroups'
import { FunnelIcon } from '../components/icons'

export function costLabel(c: Campaign): string {
  if (c.cost_model === 'none') return '—'
  const v = c.cost_model === 'revshare' ? `${c.cost_value}%` : fmtMoney(c.cost_value, c.currency)
  return `${c.cost_model.toUpperCase()} · ${v}`
}

export const ACCESS_LABEL: Record<string, string> = { edit: t('Can edit'), read: t('Read-only'), stats: t('Stats only') }

/** Where a campaign name leads: the editor, or its reports when only statistics are shared. */
export function campaignLink(c: Campaign): string {
  return canRead(c) ? `/campaigns/${c.id}` : `/reports?campaign_id=${c.id}`
}

/** Marks a test campaign, and one whose source has moved on since the last sync. */
export function TestBadge({ c }: { c: Campaign }) {
  if (!c.test) return null
  return (
    <>
      <Badge tone="info" title={t('Test campaign: answers only requests with its key, and its statistics are kept apart')}>
        {t('test@@campaign')}
      </Badge>
      {c.outdated && (
        <Badge tone="warn" title={t('The campaign it was forked from has changed since the last sync')}>
          {t('outdated@@fork')}
        </Badge>
      )}
    </>
  )
}

/** Badge for campaigns shared with the viewer; nothing for their own. */
export function AccessBadge({ c }: { c: Campaign }) {
  if (!c.access || c.access === 'owner') return null
  const access = ACCESS_LABEL[c.access] ?? c.access
  return (
    <Badge tone={c.access === 'edit' ? 'info' : 'neutral'} title={c.owner_name ? t('Shared with you by {name}: {access}', { name: c.owner_name, access }) : t('Shared with you by its owner: {access}', { access })}>
      {access}
    </Badge>
  )
}

type Show = 'all' | 'active' | 'paused'

export default function Campaigns() {
  const nav = useNavigate()
  const [range, setRange] = useDateRange()
  const list = useLoad(() => get<Campaign[]>('campaigns'), [])
  // Test campaigns show their own numbers in their rows; the totals leave them out.
  const rep = useLoad(() => loadReport('campaign', range, { tests: 'all' }), [range.from, range.to])
  const streams = useLoad(() => get<Stream[]>('streams'), [])
  const domains = useLoad(() => get<Domain[]>('domains'), [])
  const [q, setQ] = useState('')
  const [show, setShow] = useState<Show>('all')
  const [creating, setCreating] = useState(false)
  const [funnelFor, setFunnelFor] = useState<Campaign | null>(null)
  const groups = useCampaignGroups()
  // The group lives in the address (?group=3, from the sidebar): '' = every campaign, 'none' = the ungrouped ones.
  const [sp, setSp] = useSearchParams()
  const groupFilter = sp.get('group') ?? ''
  const setGroupFilter = (v: string) => setSp(v ? { group: v } : {})
  const [managing, setManaging] = useState<{ shareId?: number } | null>(null)
  const groupList = useMemo(() => groups ?? [], [groups])
  const openGroup = groupList.find((g) => String(g.id) === groupFilter)
  const groupOf = (c: Campaign) => groupList.find((g) => g.id === c.group_id)

  const everything = useMemo(() => list.data ?? [], [list.data])
  // A group view is a page of its own: its totals and counts are the group's.
  const all = useMemo(() => everything.filter((c) => groupFilter === '' || (groupFilter === 'none' ? !c.group_id : String(c.group_id ?? '') === groupFilter)), [everything, groupFilter])
  const stats = useMemo(() => new Map<string, ReportRow>((rep.data ?? []).map((r) => [r.key, r])), [rep.data])
  const stat = (c: Campaign) => stats.get(String(c.id))
  // Only campaigns that still exist count towards the totals.
  const total = useMemo(() => sumRows(all.filter((c) => !c.test).map((c) => stats.get(String(c.id))).filter((r): r is ReportRow => !!r)), [all, stats])
  const streamCount = useMemo(() => {
    const m = new Map<number, number>()
    for (const st of streams.data ?? []) m.set(st.campaign_id, (m.get(st.campaign_id) ?? 0) + 1)
    return m
  }, [streams.data])
  // The domain whose root serves the campaign, else any working domain: enough to copy a full link.
  const host = useMemo(() => {
    const ok = (domains.data ?? []).filter((d) => d.enabled)
    const best = ok.find((d) => d.status === 'ok') ?? ok[0]
    return (c: Campaign) => (ok.find((d) => d.campaign_id === c.id) ?? best)?.name
  }, [domains.data])

  const active = all.filter((c) => c.enabled).length
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return all.filter((c) => (show === 'all' || (show === 'active') === c.enabled) && (!s || c.name.toLowerCase().includes(s) || c.alias.toLowerCase() === s || (c.note ?? '').toLowerCase().includes(s)))
  }, [all, q, show])

  const setEnabled = async (c: Campaign, enabled: boolean) => {
    // The switch moves at once and goes back if the server refuses. Updating from the
    // latest list (not the one captured at click time) keeps two quick switches from undoing each other.
    const apply = (v: boolean) => list.setData((d) => d?.map((x) => (x.id === c.id ? { ...x, enabled: v } : x)))
    apply(enabled)
    try {
      await put(`campaigns/${c.id}`, { enabled })
    } catch (e) {
      apply(!enabled)
      toast.err(e)
    }
  }
  const moveTo = async (c: Campaign, g: CampaignGroup | null) => {
    try {
      await put(`campaigns/${c.id}`, { group_id: g ? g.id : null })
      list.setData((d) => d?.map((x) => (x.id === c.id ? { ...x, group_id: g ? g.id : null } : x)))
      toast.ok(g ? t('“{name}” moved to group “{group}”', { name: c.name, group: g.name }) : t('“{name}” removed from its group', { name: c.name }))
    } catch (e) {
      toast.err(e)
    }
  }
  const clone = async (c: Campaign) => {
    try {
      const n = await post<Campaign>(`campaigns/${c.id}/clone`)
      toast.ok(t('Cloned as “{name}”', { name: n.name }))
      nav(`/campaigns/${n.id}`)
    } catch (e) {
      toast.err(e)
    }
  }
  const fork = async (c: Campaign) => {
    try {
      const n = await post<Campaign>(`campaigns/${c.id}/fork`)
      toast.ok(t('Test campaign “{name}” created', { name: n.name }))
      nav(`/campaigns/${n.id}?tab=test`)
    } catch (e) {
      toast.err(e)
    }
  }
  const remove = async (c: Campaign) => {
    const ok = await confirmDialog({
      title: t('Delete campaign?'),
      message: tx('<b>{name}</b> and all of its streams will be deleted and its link stops working. Collected statistics are kept.', { b: (x) => <b>{x}</b>, name: c.name }),
    })
    if (!ok) return
    try {
      await del(`campaigns/${c.id}`)
      toast.ok(t('Campaign deleted'))
      list.reload()
    } catch (e) {
      toast.err(e)
    }
  }

  const report = (c: Campaign) => '/reports' + buildSearch({ range, group: 'stream', filters: { campaign_id: c.id } })
  const clicks = (c: Campaign) => '/clicks' + buildSearch({ range, filters: { campaign_id: c.id } })
  const loadingStats = rep.loading && !rep.data
  // tone: 'sign' colours by the sign of the value, anything else is a tone class for non-zero values.
  const num = (c: Campaign, pick: (r: ReportRow) => number, fmt: (v: number) => string, tone?: string) => {
    const v = stat(c) ? pick(stat(c) as ReportRow) : 0
    const cls = v === 0 ? ' muted' : tone === 'sign' ? (v > 0 ? ' tone-good' : ' tone-bad') : tone ? ' ' + tone : ''
    return <span className={'tnum' + cls}>{loadingStats ? '·' : fmt(v)}</span>
  }
  const money = (v: number) => fmtMoney(v)

  const columns: Column<Campaign>[] = [
    { key: 'enabled', title: '', width: 46, sort: (c) => (c.enabled ? 1 : 0), render: (c) => <Toggle checked={c.enabled} disabled={!canEdit(c)} onChange={(v) => setEnabled(c, v)} title={!canEdit(c) ? t('You cannot change this campaign') : c.enabled ? t('Enabled — click to pause') : t('Paused: the link answers 404 — click to enable')} /> },
    {
      key: 'name',
      title: t('Campaign'),
      sort: (c) => c.name.toLowerCase(),
      render: (c) => {
        const h = host(c)
        const n = streamCount.get(c.id)
        // A test campaign answers nothing without its key.
        const path = c.alias + (c.test && c.test_key ? `?key=${c.test_key}` : '')
        return (
          <div className="camp">
            <div className="camp-title">
              <Link to={campaignLink(c)} className="camp-name ellipsis" title={canRead(c) ? c.note || undefined : t('Only statistics are shared with you: opens the reports for this campaign')}>
                {c.name}
              </Link>
              {!c.enabled && <span className="tag">{t('paused@@campaign')}</span>}
              <TestBadge c={c} />
              <AccessBadge c={c} />
              {c.access && c.access !== 'owner' && c.owner_name && <span className="muted small">{t('by {name}@@owner', { name: c.owner_name })}</span>}
            </div>
            <div className="camp-meta">
              {!groupFilter && groupOf(c) && (
                <button className="camp-group" onClick={() => setGroupFilter(String(c.group_id))} title={t('Show only this group')}>
                  <Folder size={11} /> {groupOf(c)?.name}
                </button>
              )}
              <span className="camp-alias" title={h ? `https://${h}/${c.alias}` : c.alias}>
                <code className="ellipsis">/{c.alias}</code>
                <CopyButton text={h ? `https://${h}/${path}` : path} className="icon-btn" title={h ? t('Copy the campaign link') : t('Copy the link ID (no domain yet)')} />
              </span>
              {n !== undefined && <span>{tn(n, '{n} stream', '{n} streams')}</span>}
              <span>{c.rotation === 'weight' ? t('by weight') : t('by position')}</span>
              {c.cost_model !== 'none' && <span>{costLabel(c)}</span>}
              {(c.stages ?? []).length > 0 && (
                <button className="camp-funnel" onClick={() => setFunnelFor(c)} title={t('Open the funnel of this campaign')}>
                  <FunnelIcon size={11} /> {tn((c.stages ?? []).length, '{n}-stage funnel', '{n}-stage funnel')}
                </button>
              )}
            </div>
          </div>
        )
      },
    },
    {
      key: 'clicks',
      title: t('Clicks'),
      align: 'right',
      sort: (c) => stat(c)?.clicks ?? 0,
      render: (c) => {
        const v = stat(c)?.clicks ?? 0
        return (
          <Link className="camp-clicks" to={report(c)} title={c.test ? t('Test clicks, not counted in the totals — open the report') : t('{share} of all clicks — open the report', { share: ratioPct(v, total.clicks) })} onClick={(e) => e.stopPropagation()}>
            <span className={'tnum' + (v === 0 ? ' muted' : '')}>{loadingStats ? '·' : fmtInt(v)}</span>
            <span className="share-bar">
              <span style={{ width: `${!c.test && total.clicks > 0 ? (v / total.clicks) * 100 : 0}%` }} />
            </span>
          </Link>
        )
      },
    },
    { key: 'uniques', title: t('Uniq.'), className: 'c-wide', align: 'right', sort: (c) => stat(c)?.uniques ?? 0, render: (c) => num(c, (r) => r.uniques, fmtInt) },
    { key: 'bots', title: t('Bots'), className: 'c-wide', align: 'right', headTitle: t('Share of clicks judged to be bots'), sort: (c) => (stat(c)?.clicks ? (stat(c) as ReportRow).bots / (stat(c) as ReportRow).clicks : 0), render: (c) => num(c, (r) => (r.clicks ? (r.bots / r.clicks) * 100 : 0), (v) => fmtPct(v, 1), 'tone-warn') },
    { key: 'conv', title: t('Conv.'), align: 'right', sort: (c) => stat(c)?.conversions ?? 0, render: (c) => num(c, (r) => r.conversions, fmtInt, 'tone-good') },
    { key: 'cr', title: 'CR', className: 'c-wide', align: 'right', headTitle: t('Conversions / non-bot clicks'), sort: (c) => stat(c)?.cr ?? 0, render: (c) => num(c, (r) => r.cr, (v) => fmtPct(v), 'tone-accent') },
    { key: 'revenue', title: t('Revenue'), align: 'right', sort: (c) => stat(c)?.revenue ?? 0, render: (c) => num(c, (r) => r.revenue, money, 'tone-good') },
    { key: 'cost', title: t('Cost'), className: 'c-wide', align: 'right', sort: (c) => stat(c)?.cost ?? 0, render: (c) => num(c, (r) => r.cost, money) },
    { key: 'profit', title: t('Profit'), align: 'right', sort: (c) => stat(c)?.profit ?? 0, render: (c) => num(c, (r) => r.profit, money, 'sign') },
    {
      key: 'actions',
      title: '',
      align: 'right',
      width: 124,
      render: (c) => {
        const own = groupList.filter((g) => g.owner_id === c.owner_id)
        return (
          <div className="row-actions" onClick={(e) => e.stopPropagation()}>
            <Link className="icon-btn" to={clicks(c)} title={t('Click log of this campaign')} aria-label={t('Click log')}>
              <MousePointerClick size={15} />
            </Link>
            <button className="icon-btn" onClick={() => setFunnelFor(c)} title={t('Funnel of this campaign')} aria-label={t('Funnel')}>
              <FunnelIcon size={15} />
            </button>
            {canRead(c) && (
              <Link className="icon-btn" to={`/campaigns/${c.id}`} title={canEdit(c) ? t('Edit') : t('View (read-only)')}>
                {canEdit(c) ? <Pencil size={15} /> : <Eye size={15} />}
              </Link>
            )}
            <ActionMenu
              sections={[
                {
                  items: [
                    { icon: <MousePointerClick size={15} />, label: t('Click log'), onClick: () => nav(clicks(c)) },
                    { icon: <BarChart3 size={15} />, label: t('Report'), onClick: () => nav(report(c)) },
                    { icon: <FunnelIcon size={15} />, label: t('Funnel'), onClick: () => setFunnelFor(c) },
                  ],
                },
                {
                  items: canRead(c)
                    ? [
                        { icon: <Copy size={15} />, label: t('Clone'), title: t('Copy this campaign and its streams into a new campaign of your own'), onClick: () => clone(c) },
                        ...(!c.test ? [{ icon: <FlaskConical size={15} />, label: t('Fork as test'), title: t('Copy this campaign and its streams into a test campaign: it answers only your key, skips the antibot for you, and keeps its statistics apart'), onClick: () => fork(c) }] : []),
                      ]
                    : [],
                },
                {
                  title: isOwner(c) ? t('Group') : undefined,
                  items: isOwner(c)
                    ? [
                        ...own.map((g) => ({ icon: <Folder size={15} />, label: g.name, checked: g.id === c.group_id, onClick: () => g.id !== c.group_id && moveTo(c, g) })),
                        ...(c.group_id ? [{ icon: <FolderMinus size={15} />, label: t('Remove from the group'), onClick: () => moveTo(c, null) }] : []),
                      ]
                    : [],
                  extra: isOwner(c) && own.length === 0 && <div className="muted pad-s small">{t('No groups yet — create one with “Groups” above the list.')}</div>,
                },
                { items: isOwner(c) ? [{ icon: <Trash2 size={15} />, label: t('Delete'), danger: true, onClick: () => remove(c) }] : [] },
              ]}
            />
          </div>
        )
      },
    },
  ]

  const metrics: Metric[] = [
    { label: t('Clicks'), metric: 'm-clicks', value: fmtInt(total.clicks), sub: tn(total.uniques, '{n} unique', '{n} unique', { n: fmtInt(total.uniques) }) },
    { label: t('Bots'), metric: 'm-bots', value: ratioPct(total.bots, total.clicks), sub: tn(total.bots, '{n} click', '{n} clicks', { n: fmtInt(total.bots) }) },
    { label: t('Conversions'), metric: 'm-conv', value: fmtInt(total.conversions), sub: `CR ${fmtPct(total.cr)}` },
    { label: t('Revenue'), metric: 'm-conv', value: fmtMoney(total.revenue), sub: t('cost {value}', { value: fmtMoney(total.cost) }) },
    { label: t('Profit'), metric: total.profit < 0 ? 'm-loss' : 'm-conv', value: fmtMoney(total.profit), sub: total.cost > 0 ? `ROI ${fmtPct(total.roi, 1)}` : t('no cost recorded'), tone: total.profit > 0 ? 'pos' : total.profit < 0 ? 'neg' : '' },
  ]
  const showOptions = [
    { value: 'all' as Show, label: t('All {n}', { n: all.length }) },
    { value: 'active' as Show, label: t('Active {n}', { n: active }) },
    { value: 'paused' as Show, label: t('Paused {n}', { n: all.length - active }) },
  ]
  const title = openGroup ? openGroup.name : groupFilter === 'none' ? t('Campaigns without a group') : t('Campaigns')

  return (
    <div className="page">
      <PageHeader
        title={title}
        sub={
          groupFilter ? (
            <Link to="/campaigns" className="back">
              <ArrowLeft size={13} /> {t('All campaigns')}
            </Link>
          ) : (
            t('Each campaign is a URL that routes visitors through its streams.')
          )
        }
      >
        {openGroup && ownsGroup(openGroup) && (
          <button className="btn" onClick={() => setManaging({ shareId: openGroup.id })} title={t('Choose who gets the campaigns of this group')}>
            <Users size={14} /> {t('Share group')}
          </button>
        )}
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={15} /> {t('New campaign')}
        </button>
      </PageHeader>
      <ErrorBox error={list.error} retry={list.reload} />
      {rep.error && <ErrorBox error={t('Statistics are unavailable: {error}', { error: rep.error })} retry={rep.reload} />}

      <StatBar
        loading={!list.data || loadingStats}
        metrics={metrics}
        controls={
          <>
            <DateRangePicker value={range} onChange={setRange} />
            <button className="btn" onClick={() => (list.reload(), rep.reload())} title={t('Refresh')} aria-label={t('Refresh')}>
              <RefreshCw size={14} className={rep.loading || list.loading ? 'spin' : ''} />
            </button>
          </>
        }
      />

      <div className="card camp-card">
        <div className="card-head camp-bar">
          <Segmented small value={show} onChange={setShow} options={showOptions} />
          <span className="grow" />
          <button className="btn small ghost" onClick={() => setManaging({})} title={t('Create, rename, share and delete campaign groups')}>
            <FolderCog size={13} /> {t('Groups')}
          </button>
          <SearchInput value={q} onChange={setQ} placeholder={t('Search name, note or link ID…')} width={260} />
        </div>
        <DataTable
          columns={columns}
          rows={list.data ? rows : undefined}
          rowKey={(c) => c.id}
          loading={list.loading}
          defaultSort={{ key: 'clicks', dir: 'desc' }}
          rowClass={(c) => (c.enabled ? '' : 'camp-off')}
          empty={
            <Empty title={q || show !== 'all' || groupFilter ? t('No campaigns match') : t('No campaigns yet')} action={!q && show === 'all' && !groupFilter && <button className="btn primary" onClick={() => setCreating(true)}><Plus size={15} /> {t('Create the first campaign')}</button>}>
              {!q && show === 'all' && !groupFilter && t('Create a campaign, add streams with filters, and point a domain at it.')}
            </Empty>
          }
        />
      </div>
      {funnelFor && <FunnelDrawer campaign={funnelFor} range={range} setRange={setRange} onClose={() => setFunnelFor(null)} />}
      {managing && (
        <GroupsModal
          groups={groupList}
          campaigns={everything}
          shareId={managing.shareId}
          onClose={() => setManaging(null)}
          onChanged={() => {
            reloadCampaignGroups()
            // Deleting a group ungroups its campaigns.
            list.reload()
          }}
        />
      )}
      {creating && <CreateCampaign onClose={() => setCreating(false)} onCreated={(c) => nav(`/campaigns/${c.id}`)} />}
    </div>
  )
}

function CreateCampaign({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Campaign) => void }) {
  const [name, setName] = useState('')
  const [presetId, setPresetId] = useState('')
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const presets = useLoad(() => get<FunnelPreset[] | null>('funnel-presets'), [])
  const submit = () =>
    run(async () => {
      setError('')
      try {
        // The campaign starts with a copy of the preset's stages and remembers where they came from.
        const p = (presets.data ?? []).find((x) => String(x.id) === presetId)
        const c = await post<Campaign>('campaigns', { name, enabled: true, ...(p ? { stages: p.stages, funnel_preset_id: p.id, funnel_preset_rev: p.rev } : {}) })
        toast.ok(t('Campaign created'))
        onCreated(c)
      } catch (e) {
        setError(errMsg(e))
      }
    })
  return (
    <Modal
      title={t('New campaign')}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={submit}>
            {t('Create')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) submit()
        }}
      >
        <Field label={t('Name')} help={t('The campaign gets a random, unguessable link and starts with two streams you can edit: an intercepting “Traffic filter” that stops bots and off-target visitors, and a “Fallback”. Both answer 404 until you point them at a whitepage or an offer.')}>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('FB · DE · sweepstakes')} />
        </Field>
        {(presets.data ?? []).length > 0 && (
          <Field label={t('Funnel preset')} help={t('Optional: the campaign starts with a copy of the preset’s stages. You can change them later on the Funnel tab.')}>
            <Select value={presetId} onChange={setPresetId} options={[{ value: '', label: t('No funnel') }, ...(presets.data ?? []).map((p) => ({ value: String(p.id), label: `${p.name} · ${tn(p.stages.length, '{n} stage', '{n} stages')}` }))]} />
          </Field>
        )}
        {error && <div className="field-error">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}
