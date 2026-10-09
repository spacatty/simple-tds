import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AlertTriangle, ArrowRight, BarChart3, ChevronDown, Copy, CornerDownRight, Eye, GripVertical, MoreVertical, MousePointerClick, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, Wallet } from 'lucide-react'
import { del, get, post, put } from '../api'
import { canEdit, useLoad, useMeta } from '../hooks'
import type { ActionConfig, ActionDef, Campaign, Filter, FilterDef, GeoPreset, ReportRow, Stream, StreamPreset, Whitepage } from '../types'
import { Dropdown, ErrorBox, MenuItem, Skeleton, Toggle, confirmDialog, toast } from '../components/ui'
import { DateRangePicker } from '../components/DateRangePicker'
import type { DateRange } from '../components/DateRangePicker'
import StreamEditor, { ACTION_ICONS, draftFromStream, newDraft, presetName, streamBody } from './StreamEditor'
import type { RefNames, StreamDraft } from './StreamEditor'
import StreamStats from './StreamStats'
import FunnelDrawer from './FunnelDrawer'
import { loadReport, sumRows } from '../reports'
import { buildSearch } from '../filters'
import { fmtInt, fmtMoney, fmtPct, ratioPct } from '../format'
import { dimIcon, FunnelIcon } from '../components/icons'
import { t, ts, tx } from '../i18n'

interface StreamsResp {
  streams: Stream[] | null
  errors: Record<string, string> | null
  /** Names of every whitepage / target campaign the streams reference, including ones the viewer does not own. */
  whitepages?: Record<string, string> | null
  campaigns?: Record<string, string> | null
}

const KINDS = ['forced', 'regular', 'default'] as const
type Kind = (typeof KINDS)[number]

const LANE: Record<Kind, { title: string; desc: string; empty: string; add: string; addTitle: string }> = {
  forced: {
    title: t('Intercepting@@lane'),
    desc: t('Checked first, top to bottom — the first match wins.'),
    empty: t('No intercepting streams. Add one to stop bots and unwanted traffic before anything else is evaluated.'),
    add: t('Intercepting stream'),
    addTitle: t('Add an intercepting stream'),
  },
  regular: {
    title: t('Regular@@lane'),
    desc: '',
    empty: t('No regular streams. Add streams with filters (country, device, …) that lead to your offers.'),
    add: t('Regular stream'),
    addTitle: t('Add a regular stream'),
  },
  default: {
    title: t('Default@@lane'),
    desc: t('The fallback for visitors that matched nothing above.'),
    empty: t('No default stream: visitors that match nothing get a 404.'),
    add: t('Default stream'),
    addTitle: t('Add a default stream'),
  },
}

export default function StreamFunnel({
  campaign,
  campaigns,
  whitepages,
  presets,
  readOnly,
  range,
  setRange,
  domain,
}: {
  campaign: Campaign
  campaigns: Campaign[]
  whitepages: Whitepage[]
  presets: GeoPreset[]
  readOnly: boolean
  range: DateRange
  setRange: (r: DateRange) => void
  /** The tracker domain used in the URLs the stream editor shows. */
  domain: string
}) {
  const meta = useMeta()
  const nav = useNavigate()
  const res = useLoad(() => get<StreamsResp>(`campaigns/${campaign.id}/streams`), [campaign.id])
  const stats = useLoad(() => loadReport('stream', range, { campaign_id: campaign.id }), [campaign.id, range.from, range.to])
  const own = useLoad(() => get<StreamPreset[] | null>('stream-presets'), [])
  const [editing, setEditing] = useState<StreamDraft | null>(null)
  const [statsFor, setStatsFor] = useState<Stream | null>(null)
  // The funnel drawer: of the whole campaign, or of one stream.
  const [funnelFor, setFunnelFor] = useState<{ stream?: Stream } | null>(null)
  const [dragId, setDragId] = useState<number | null>(null)
  const [over, setOver] = useState<{ id: number; after: boolean } | null>(null)

  const streams = useMemo(() => res.data?.streams ?? [], [res.data])
  const errors = res.data?.errors ?? {}
  const refNames: RefNames = useMemo(() => ({ whitepages: res.data?.whitepages ?? {}, campaigns: res.data?.campaigns ?? {} }), [res.data])
  const streamPresets = useMemo(() => [...(meta.stream_presets ?? []), ...(own.data ?? [])], [meta.stream_presets, own.data])
  const byKind = useMemo(() => {
    const m: Record<string, Stream[]> = { forced: [], regular: [], default: [] }
    for (const s of streams) (m[s.kind] ?? m.regular).push(s)
    return m
  }, [streams])
  const filterDefs = useMemo(() => new Map(meta.filters.map((f) => [f.type, f])), [meta.filters])
  const statById = useMemo(() => new Map<string, ReportRow>((stats.data ?? []).map((r) => [r.key, r])), [stats.data])
  const total = useMemo(() => sumRows(stats.data ?? []), [stats.data])
  const totalClicks = total.clicks

  const setStreams = (next: Stream[]) => res.setData({ ...res.data, streams: next, errors: res.data?.errors ?? {} })

  /** Persists the order forced → regular → default, as given. */
  const saveOrder = async (groups: Record<string, Stream[]>) => {
    const ordered = KINDS.flatMap((k) => groups[k] ?? [])
    setStreams(ordered.map((s, i) => ({ ...s, position: i })))
    try {
      await put(`campaigns/${campaign.id}/streams/order`, { ids: ordered.map((s) => s.id) })
    } catch (e) {
      toast.err(e)
    }
    await res.reload()
  }

  const drop = (kind: string) => {
    if (dragId === null || !over) return
    const list = byKind[kind]
    const moving = list.find((s) => s.id === dragId)
    setDragId(null)
    setOver(null)
    if (!moving || over.id === dragId) return
    const rest = list.filter((s) => s.id !== dragId)
    let idx = rest.findIndex((s) => s.id === over.id)
    if (idx < 0) return
    if (over.after) idx++
    rest.splice(idx, 0, moving)
    if (rest.every((s, i) => s.id === list[i].id)) return
    saveOrder({ ...byKind, [kind]: rest })
  }

  /** Partial update of one stream, shown immediately. */
  const patch = async (s: Stream, body: Partial<Stream>, ok?: string) => {
    try {
      const n = await put<Stream>(`streams/${s.id}`, body)
      // From the latest list, not the one captured before the request: another toggle may have landed meanwhile.
      res.setData((d) => d && { ...d, streams: (d.streams ?? []).map((x) => (x.id === s.id ? n : x)) })
      if (ok) toast.ok(ok)
      // Names of newly referenced whitepages and the error map come with the list.
      if (body.action_type !== undefined) res.reload()
    } catch (e) {
      toast.err(e)
    }
  }

  const duplicate = async (s: Stream) => {
    try {
      const body = { ...streamBody(draftFromStream(s), meta.actions), name: t('{name} (copy)', { name: s.name }) }
      // Keep the stored config verbatim rather than the form-cleaned one.
      const created = await post<Stream>('streams', { ...body, action_config: s.action_config ?? {} })
      const list = [...byKind[s.kind]]
      list.splice(list.findIndex((x) => x.id === s.id) + 1, 0, created)
      await saveOrder({ ...byKind, [s.kind]: list })
      toast.ok(t('Stream duplicated'))
    } catch (e) {
      toast.err(e)
    }
  }

  const remove = async (s: Stream) => {
    if (!(await confirmDialog({ title: t('Delete stream?'), message: tx('Stream <b>{name}</b> will be removed from this campaign. Its statistics are kept.', { b: (c) => <b>{c}</b>, name: s.name }) }))) return
    try {
      await del(`streams/${s.id}`)
      toast.ok(t('Stream deleted'))
      res.reload()
    } catch (e) {
      toast.err(e)
    }
  }

  const onSaved = async (saved: Stream, created: boolean, kindChanged: boolean) => {
    setEditing(null)
    toast.ok(created ? t('Stream created') : t('Stream saved'))
    if (created || kindChanged) {
      // New streams and streams moved between lanes go to the end of their lane.
      const groups: Record<string, Stream[]> = {}
      for (const k of KINDS) groups[k] = byKind[k].filter((s) => s.id !== saved.id)
      ;(groups[saved.kind] ?? groups.regular).push(saved)
      await saveOrder(groups)
    } else {
      await res.reload()
    }
  }

  const add = (kind: Kind) => setEditing(newDraft(campaign.id, kind, meta.actions))
  const totalWeight = byKind.regular.filter((s) => s.enabled).reduce((n, s) => n + s.weight, 0)
  const scope = { campaign_id: campaign.id }

  const cur = campaign.currency
  const summary: [string, string, string][] = [
    [t('Clicks'), fmtInt(total.clicks), 'm-clicks'],
    [t('Uniques'), fmtInt(total.uniques), 'm-uniq'],
    [t('Bots'), ratioPct(total.bots, total.clicks), 'm-bots'],
    [t('Conv.'), fmtInt(total.conversions), 'm-conv'],
  ]
  // Money stays out of sight until asked for.
  const money: [string, string, string?][] = [
    ['CR', fmtPct(total.cr)],
    [t('Revenue'), fmtMoney(total.revenue, cur)],
    [t('Cost'), fmtMoney(total.cost, cur)],
    [t('Profit'), fmtMoney(total.profit, cur), total.profit > 0 ? 'pos' : total.profit < 0 ? 'neg' : ''],
    ['ROI', total.cost > 0 ? fmtPct(total.roi, 1) : '—', total.cost > 0 ? (total.roi > 0 ? 'pos' : total.roi < 0 ? 'neg' : '') : ''],
  ]

  return (
    <div className="funnel">
      <div className="funnel-toolbar">
        <DateRangePicker value={range} onChange={setRange} />
        <button className="btn" onClick={() => (res.reload(), stats.reload())} title={t('Refresh the streams and their statistics')} aria-label={t('Refresh')}>
          <RefreshCw size={14} className={res.loading || stats.loading ? 'spin' : ''} />
        </button>
        <span className="grow" />
        <button className="btn" onClick={() => setFunnelFor({})} title={t('How far the clicks of this campaign get')}>
          <FunnelIcon size={14} /> {t('Funnel')}
        </button>
        <Link className="btn" to={'/clicks' + buildSearch({ range, filters: scope })} title={t('Click log filtered to this campaign')}>
          <MousePointerClick size={14} /> {t('Click log')}
        </Link>
        <Link className="btn" to={'/reports' + buildSearch({ range, group: 'stream', filters: scope })} title={t('Reports filtered to this campaign')}>
          <BarChart3 size={14} /> {t('Report')}
        </Link>
        {!readOnly && (
          <div className="split-btn">
            <button className="btn primary" onClick={() => add('regular')}>
              <Plus size={15} /> {t('Add stream')}
            </button>
            <Dropdown align="right" className="btn primary split-caret" chevron={false} label={<ChevronDown size={14} />} title={t('Choose the kind of stream')}>
              {(close) => (
                <div className="menu">
                  {KINDS.map((k) => (
                    <MenuItem
                      key={k}
                      onClick={() => {
                        close()
                        add(k)
                      }}
                    >
                      <span className={'lane-dot kind-' + k} /> {LANE[k].add}
                    </MenuItem>
                  ))}
                </div>
              )}
            </Dropdown>
          </div>
        )}
      </div>

      <div className="fsum" title={t('This campaign in the selected period')}>
        {summary.map(([label, value, metric]) => (
          <div key={label} className={'fsum-item ' + metric}>
            <span>{label}</span>
            <b>{stats.loading && !stats.data ? '·' : value}</b>
          </div>
        ))}
        <Dropdown
          align="right"
          className="fsum-item fsum-more"
          title={t('CR, revenue, cost and profit of this campaign in the selected period')}
          label={
            <>
              <Wallet size={15} /> {t('Profit')}
            </>
          }
        >
          {() => (
            <div className="fmoney">
              {money.map(([label, value, tone]) => (
                <div key={label} className="fmoney-row">
                  <span>{label}</span>
                  <b className={tone || undefined}>{stats.loading && !stats.data ? '·' : value}</b>
                </div>
              ))}
            </div>
          )}
        </Dropdown>
      </div>

      <ErrorBox error={res.error} retry={res.reload} />
      {stats.error && <ErrorBox error={t('Stream statistics are unavailable: {error}', { error: stats.error })} retry={stats.reload} />}

      {res.loading && !res.data ? (
        <Skeleton rows={8} height={18} />
      ) : (
        <div className="lanes">
          <div className="stable">
            {/* Column titles for every row below; the same grid as .srow. */}
            <div className="stable-head" aria-hidden="true">
              <span />
              <span />
              <span>{t('Stream')}</span>
              <span>{t('Filters')}</span>
              <span>{t('Action')}</span>
              <div className="lane-cols">
                <span>{t('Clicks')}</span>
                <span>{t('Uniq.')}</span>
                <span>{t('Bots')}</span>
                <span>{t('Conv.')}</span>
                <span>CR</span>
                <span>{t('Revenue')}</span>
                <span>{t('Share@@traffic')}</span>
              </div>
              <span />
            </div>
          {KINDS.map((kind) => {
            const list = byKind[kind]
            return (
              <section key={kind} className={'lane kind-' + kind}>
                <header className="lane-head">
                  <h3>{LANE[kind].title}</h3>
                  <span className="count">{list.length}</span>
                  <span className="lane-desc ellipsis">
                    {kind === 'regular' ? (campaign.rotation === 'weight' ? t('All matching streams take part in a weighted random draw.') : t('Checked top to bottom — the first stream whose filters match wins.')) : LANE[kind].desc}
                  </span>
                  {!readOnly && (
                    <button className="btn small ghost" onClick={() => add(kind)} title={LANE[kind].addTitle}>
                      <Plus size={13} /> {t('Add')}
                    </button>
                  )}
                </header>
                <div
                  className="lane-body"
                  onDragOver={(e) => {
                    if (dragId !== null && list.some((s) => s.id === dragId)) e.preventDefault()
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    drop(kind)
                  }}
                >
                  {list.length === 0 && <div className="lane-empty">{LANE[kind].empty}</div>}
                  {list.map((s, i) => (
                    <StreamCard
                      key={s.id}
                      stream={s}
                      index={i}
                      readOnly={readOnly}
                      refNames={refNames}
                      error={errors[String(s.id)]}
                      stat={statById.get(String(s.id))}
                      statsLoading={stats.loading && !stats.data}
                      totalClicks={totalClicks}
                      currency={cur}
                      showWeight={campaign.rotation === 'weight' && kind === 'regular'}
                      totalWeight={totalWeight}
                      filterDefs={filterDefs}
                      actions={meta.actions}
                      whitepages={whitepages}
                      campaigns={campaigns}
                      actionPresets={streamPresets.filter((p) => p.kind === 'action')}
                      dragging={dragId === s.id}
                      dropMark={over && over.id === s.id && dragId !== null && dragId !== s.id && list.some((x) => x.id === dragId) ? (over.after ? 'after' : 'before') : null}
                      onDragStart={() => setDragId(s.id)}
                      onDragEnd={() => {
                        setDragId(null)
                        setOver(null)
                      }}
                      onDragOverCard={(e) => {
                        if (dragId === null || !list.some((x) => x.id === dragId)) return
                        const r = e.currentTarget.getBoundingClientRect()
                        const after = e.clientY > r.top + r.height / 2
                        if (!over || over.id !== s.id || over.after !== after) setOver({ id: s.id, after })
                      }}
                      onEdit={() => setEditing(draftFromStream(s))}
                      onToggle={(enabled) => patch(s, { enabled })}
                      onRename={(name) => patch(s, { name })}
                      onAction={(action_type, action_config, label) => patch(s, { action_type, action_config }, `${s.name}: ${label}`)}
                      onDuplicate={() => duplicate(s)}
                      onDelete={() => remove(s)}
                      onStats={() => setStatsFor(s)}
                      onFunnel={() => setFunnelFor({ stream: s })}
                      onClicks={() => nav('/clicks' + buildSearch({ range, filters: { ...scope, stream_id: s.id } }))}
                    />
                  ))}
                </div>
              </section>
            )
          })}
          </div>
          <div className="lanes-note">
            {byKind.default.some((s) => s.enabled)
              ? t('A visitor is checked against Intercepting, then Regular, then Default streams. If the default stream does not match either, the answer is 404.')
              : t('A visitor is checked against Intercepting, then Regular, then Default streams. With no default stream, a visitor that matches nothing gets a 404.')}
          </div>
        </div>
      )}

      {editing && (
        <StreamEditor
          readOnly={readOnly}
          refNames={refNames}
          draft={editing}
          campaign={campaign}
          campaigns={campaigns.filter(canEdit)}
          whitepages={whitepages}
          presets={presets}
          domain={domain}
          streamPresets={streamPresets}
          onPresetsChanged={own.reload}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
        />
      )}
      {statsFor && <StreamStats campaign={campaign} stream={statsFor} range={range} setRange={setRange} onClose={() => setStatsFor(null)} />}
      {funnelFor && <FunnelDrawer campaign={campaign} stream={funnelFor.stream} range={range} setRange={setRange} onClose={() => setFunnelFor(null)} />}
    </div>
  )
}

/** "Country is RU, KZ +3" */
function filterChip(f: Filter, def: FilterDef | undefined) {
  const label = def ? ts(def.label) : f.type
  const not = f.mode === 'is_not'
  const vals = f.values ?? []
  let text = ''
  if (def && def.input !== 'none') {
    text = vals.slice(0, 3).join(', ') + (vals.length > 3 ? ` +${vals.length - 3}` : '')
  }
  return { label, not, text, vals, flag: !def || def.input === 'none', title: `${label} ${not ? t('is not') : t('is')}${vals.length ? ': ' + vals.join(', ') : ''}` }
}

/** How many filter chips a row shows before the rest fold into "+N more". */
const MAX_CHIPS = 5

/** What the action does to the visitor, for the colour of its icon. */
const ACTION_TONE: Record<string, string> = { status: 'stop', nothing: 'stop', redirect: 'send', campaign: 'send' }

function urlHost(u: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(u)
  return m ? m[1] : u
}

export function actionSummary(s: Stream, actions: ActionDef[], whitepages: Whitepage[], campaigns: Campaign[], refNames?: RefNames): { label: string; detail: string; title: string } {
  const def = actions.find((a) => a.type === s.action_type)
  const cfg = s.action_config ?? {}
  const str = (k: string) => (cfg[k] === undefined || cfg[k] === null ? '' : String(cfg[k]))
  let label = def ? ts(def.label) : s.action_type
  let detail = ''
  let title = ''
  switch (s.action_type) {
    case 'redirect':
      label = t('Redirect')
      detail = urlHost(str('url'))
      title = `${str('url')}${str('method') ? ` (${str('method')})` : ''}`
      break
    case 'whitepage': {
      const w = whitepages.find((x) => x.id === Number(cfg.whitepage_id))
      // In a shared campaign the owner's whitepages are not in the viewer's own list: the server supplies their names.
      detail = w ? w.name : cfg.whitepage_id ? refNames?.whitepages[str('whitepage_id')] ?? t('#{id} (missing)', { id: str('whitepage_id') }) : t('not chosen@@whitepage')
      break
    }
    case 'campaign': {
      const c = campaigns.find((x) => x.id === Number(cfg.campaign_id))
      label = t('Campaign')
      detail = c ? c.name : cfg.campaign_id ? refNames?.campaigns[str('campaign_id')] ?? t('#{id} (missing)', { id: str('campaign_id') }) : t('not chosen@@campaign')
      break
    }
    case 'status':
      label = 'HTTP ' + (str('code') || '404')
      break
    case 'text':
      label = t('Text / HTML')
      detail = str('content').replace(/\s+/g, ' ').slice(0, 60)
      break
    case 'js':
      label = t('JavaScript')
      detail = str('code').replace(/\s+/g, ' ').slice(0, 60)
      break
    case 'remote_js':
      label = t('Remote JS')
      detail = urlHost(str('url'))
      title = str('url')
      break
    default: {
      const first = (def?.fields ?? []).find((f) => f.required)
      detail = first ? str(first.name) : ''
    }
  }
  return { label, detail, title: title || [ts(def?.label), detail].filter(Boolean).join(': ') }
}

function StreamCard({
  stream: s,
  index,
  readOnly,
  refNames,
  error,
  stat,
  statsLoading,
  totalClicks,
  currency,
  showWeight,
  totalWeight,
  filterDefs,
  actions,
  whitepages,
  campaigns,
  actionPresets,
  dragging,
  dropMark,
  onDragStart,
  onDragEnd,
  onDragOverCard,
  onEdit,
  onToggle,
  onRename,
  onAction,
  onDuplicate,
  onDelete,
  onStats,
  onFunnel,
  onClicks,
}: {
  stream: Stream
  index: number
  readOnly: boolean
  refNames: RefNames
  error?: string
  stat?: ReportRow
  statsLoading: boolean
  totalClicks: number
  currency: string
  showWeight: boolean
  totalWeight: number
  filterDefs: Map<string, FilterDef>
  actions: ActionDef[]
  whitepages: Whitepage[]
  campaigns: Campaign[]
  actionPresets: StreamPreset[]
  dragging: boolean
  dropMark: 'before' | 'after' | null
  onDragStart: () => void
  onDragEnd: () => void
  onDragOverCard: (e: DragEvent<HTMLDivElement>) => void
  onEdit: () => void
  onToggle: (v: boolean) => void
  onRename: (name: string) => void
  onAction: (type: string, config: ActionConfig, label: string) => void
  onDuplicate: () => void
  onDelete: () => void
  onStats: () => void
  onFunnel: () => void
  onClicks: () => void
}) {
  const [armed, setArmed] = useState(false)
  const [rename, setRename] = useState<string | null>(null)
  // A double click renames, a single click opens the editor: wait briefly to tell them apart.
  const clickTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(clickTimer.current), [])
  const nameClick = () => {
    if (readOnly) return onEdit()
    window.clearTimeout(clickTimer.current)
    clickTimer.current = window.setTimeout(onEdit, 230)
  }
  const nameDoubleClick = () => {
    if (readOnly) return
    window.clearTimeout(clickTimer.current)
    setRename(s.name)
  }
  const filters = s.filters ?? []
  const act = actionSummary(s, actions, whitepages, campaigns, refNames)
  const Icon = ACTION_ICONS[s.action_type] ?? CornerDownRight
  const WpIcon = ACTION_ICONS.whitepage
  const StopIcon = ACTION_ICONS.status
  const currentWp = s.action_type === 'whitepage' ? Number(s.action_config?.whitepage_id) : 0

  const commitRename = () => {
    const name = (rename ?? '').trim()
    setRename(null)
    if (name && name !== s.name) onRename(name)
  }

  const clicks = stat?.clicks ?? 0
  const share = totalClicks > 0 ? (clicks / totalClicks) * 100 : 0
  const cell = (label: string, value: string, zero: boolean, title?: string, tone = '') => (
    <div className={'st' + (zero ? ' zero' : tone ? ' ' + tone : '')} title={title}>
      <span>{label}</span>
      <b>{statsLoading ? '·' : value}</b>
    </div>
  )

  const tone = ACTION_TONE[s.action_type] ?? 'show'
  const actionLabel = (
    <>
      <Icon size={13} />
      <b>{act.label}</b>
      {act.detail && <span className="ellipsis">{act.detail}</span>}
    </>
  )
  const shown = filters.slice(0, MAX_CHIPS)
  const hidden = filters.slice(MAX_CHIPS)

  return (
    <div
      className={'srow' + (s.enabled ? '' : ' off') + (dragging ? ' dragging' : '') + (dropMark ? ' drop-' + dropMark : '') + (error ? ' has-error' : '')}
      draggable={armed && !readOnly}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(s.id))
        onDragStart()
      }}
      onDragEnd={() => {
        setArmed(false)
        onDragEnd()
      }}
      onDragOver={onDragOverCard}
    >
      <div className={'srow-grip' + (readOnly ? ' fixed' : '')} title={readOnly ? undefined : t('Drag to reorder')} onMouseDown={() => setArmed(!readOnly)} onMouseUp={() => setArmed(false)}>
        {!readOnly && <GripVertical size={14} />}
        <span>{index + 1}</span>
      </div>
      <Toggle checked={s.enabled} disabled={readOnly} onChange={onToggle} title={s.enabled ? t('Enabled — click to disable') : t('Disabled — click to enable')} />

      <div className="srow-main">
        {rename !== null ? (
          <input
            className="input input-sm srow-rename"
            autoFocus
            value={rename}
            onChange={(e) => setRename(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') setRename(null)
            }}
          />
        ) : (
          <button className="srow-name ellipsis" onClick={nameClick} onDoubleClick={nameDoubleClick} title={readOnly ? t('View stream') : t('Click to edit · double-click to rename')}>
            {s.name}
          </button>
        )}
        {(s.js_check || showWeight || error) && (
          <div className="srow-tags">
            {s.js_check && (
              <span className="tag info" title={t('JS check: the browser must run a script before the action')}>
                <ShieldCheck size={11} /> JS
              </span>
            )}
            {showWeight && (
              <span className="tag" title={t('Weight and share among enabled regular streams')}>
                {t('w {weight}', { weight: s.weight })}
                {s.enabled && totalWeight > 0 ? ` · ${ratioPct(s.weight, totalWeight, 0)}` : ''}
              </span>
            )}
            {error && (
              <span className="tag err" title={ts(error)}>
                <AlertTriangle size={11} /> <span className="ellipsis">{ts(error)}</span>
              </span>
            )}
          </div>
        )}
      </div>

      <div className="srow-filters">
        {filters.length === 0 ? (
          <span className="fchip any">{t('All visitors')}</span>
        ) : (
          <>
            {filters.length > 1 && s.filter_op === 'or' && (
              <span className="fmode" title={t('Any filter may match')}>
                {t('any of')}
              </span>
            )}
            {shown.map((f, i) => {
              const c = filterChip(f, filterDefs.get(f.type))
              return (
                <span key={i} className={'fchip' + (c.not ? ' not' : '')} title={c.title}>
                  {c.flag ? (
                    <>
                      {c.not && <em>{t('not')}</em>}
                      <b>{c.label}</b>
                    </>
                  ) : (
                    <>
                      <i>{c.label}</i>
                      {c.not && <em>≠</em>}
                      {f.type === 'country' || f.type === 'device_type' || f.type === 'os' || f.type === 'browser' ? (
                        <span className="fvals">
                          {c.vals.slice(0, 3).map((v) => (
                            <span key={v} className="with-icon">
                              {dimIcon(f.type, v)}
                              {v}
                            </span>
                          ))}
                          {c.vals.length > 3 && <i>+{c.vals.length - 3}</i>}
                        </span>
                      ) : (
                        <span className="fvals">{c.text}</span>
                      )}
                    </>
                  )}
                </span>
              )
            })}
            {hidden.length > 0 && (
              <span className="fchip more" title={hidden.map((f) => filterChip(f, filterDefs.get(f.type)).title).join('\n')}>
                {t('+{n} more', { n: hidden.length })}
              </span>
            )}
          </>
        )}
      </div>

      <div className="srow-act">
        <ArrowRight size={14} className="act-arrow" aria-hidden="true" />
        {readOnly ? (
          <div className={'srow-action static a-' + tone} title={act.title}>
            {actionLabel}
          </div>
        ) : (
          <Dropdown className={'srow-action a-' + tone} label={actionLabel} title={t('{action} — click to switch the action', { action: act.title })}>
            {(close) => {
              const pick = (type: string, cfg: ActionConfig, label: string) => {
                close()
                onAction(type, cfg, label)
              }
              return (
                <div className="menu quick-menu">
                  <div className="menu-title">{t('Whitepage')}</div>
                  {whitepages.length === 0 && <div className="muted pad-s">{t('No whitepages uploaded yet.')}</div>}
                  {whitepages.map((w) => (
                    <MenuItem key={w.id} onClick={() => pick('whitepage', { whitepage_id: w.id }, t('whitepage “{name}”', { name: w.name }))}>
                      <WpIcon size={14} />
                      <span className="grow ellipsis">{w.name}</span>
                      {w.id === currentWp ? <span className="badge ok">{t('current')}</span> : <span className="muted small">{w.kind}</span>}
                    </MenuItem>
                  ))}
                  <div className="menu-title">{t('Stop')}</div>
                  <MenuItem onClick={() => pick('status', { code: 404 }, '404')}>
                    <StopIcon size={14} /> <span className="grow">404 Not Found</span> {/* i18n-ignore: HTTP status text */}
                  </MenuItem>
                  {actionPresets.length > 0 && <div className="menu-title">{t('Action presets')}</div>}
                  {actionPresets.map((p, i) => {
                    const PIcon = ACTION_ICONS[p.data.action_type ?? ''] ?? CornerDownRight
                    return (
                      <MenuItem key={p.id ?? 'b' + i} onClick={() => p.data.action_type && pick(p.data.action_type, p.data.action_config ?? {}, t('preset “{name}”', { name: presetName(p) }))}>
                        <PIcon size={14} />
                        <span className="grow ellipsis">{presetName(p)}</span>
                        {p.builtin && <span className="muted small">{t('built-in')}</span>}
                      </MenuItem>
                    )
                  })}
                  <div className="menu-sep" />
                  <MenuItem
                    onClick={() => {
                      close()
                      onEdit()
                    }}
                  >
                    <Pencil size={14} /> {t('Other action… (open editor)')}
                  </MenuItem>
                </div>
              )
            }}
          </Dropdown>
        )}
      </div>

      <button className="srow-stats" onClick={onStats} title={t('Statistics for the selected period — click to open the breakdown')}>
        {cell(t('Clicks'), fmtInt(clicks), clicks === 0, undefined, 'lead')}
        {cell(t('Uniq.'), fmtInt(stat?.uniques ?? 0), !stat?.uniques)}
        {cell(t('Bots'), fmtInt(stat?.bots ?? 0), !stat?.bots, undefined, 'tone-warn')}
        {cell(t('Conv.'), fmtInt(stat?.conversions ?? 0), !stat?.conversions, undefined, 'tone-good')}
        {cell('CR', fmtPct(stat?.cr ?? 0), !stat?.cr, t('Conversions / non-bot clicks'), 'tone-accent')}
        {cell(t('Revenue'), fmtMoney(stat?.revenue ?? 0), !stat?.revenue, currency, 'tone-good')}
        <div className="share" title={t("{pct}% of this campaign's clicks", { pct: share.toFixed(1) })}>
          <div className="share-bar">
            <div style={{ width: `${share}%` }} />
          </div>
          <span>{share >= 10 ? share.toFixed(0) : share.toFixed(1)}%</span>
        </div>
      </button>

      <div className="srow-ctl">
        <button className="icon-btn" title={t('Statistics of this stream')} aria-label={t('Statistics')} onClick={onStats}>
          <BarChart3 size={15} />
        </button>
        <button className="icon-btn" title={t('Funnel of this stream')} aria-label={t('Funnel')} onClick={onFunnel}>
          <FunnelIcon size={15} />
        </button>
        <button className="icon-btn" title={readOnly ? t('View') : t('Edit')} aria-label={readOnly ? t('View') : t('Edit')} onClick={onEdit}>
          {readOnly ? <Eye size={15} /> : <Pencil size={15} />}
        </button>
        <Dropdown align="right" className="icon-btn" chevron={false} label={<MoreVertical size={15} />} title={t('More')}>
          {(close) => {
            const run = (fn: () => void) => () => {
              close()
              fn()
            }
            return (
              <div className="menu">
                <MenuItem onClick={run(onStats)}>
                  <BarChart3 size={14} /> {t('Statistics')}
                </MenuItem>
                <MenuItem onClick={run(onFunnel)}>
                  <FunnelIcon size={14} /> {t('Funnel')}
                </MenuItem>
                <MenuItem onClick={run(onClicks)}>
                  <MousePointerClick size={14} /> {t('Click log')}
                </MenuItem>
                {!readOnly && (
                  <>
                    <MenuItem onClick={run(onDuplicate)}>
                      <Copy size={14} /> {t('Duplicate')}
                    </MenuItem>
                    <div className="menu-sep" />
                    <MenuItem danger onClick={run(onDelete)}>
                      <Trash2 size={14} /> {t('Delete')}
                    </MenuItem>
                  </>
                )}
              </div>
            )
          }}
        </Dropdown>
      </div>
    </div>
  )
}
