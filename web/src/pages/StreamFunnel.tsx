import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, KeyboardEvent, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, BarChart3, ClipboardCopy, ClipboardPaste, Copy, CopyPlus, CornerDownRight, CornerRightDown, Eye, MousePointerClick, Pencil, Plus, ShieldCheck, Target, Trash2 } from 'lucide-react'
import { del, errMsg, get, post, put } from '../api'
import { canEdit, useLoad, useMeta } from '../hooks'
import type { ActionConfig, ActionDef, Campaign, Filter, FilterDef, GeoPreset, LandingRef, ReportRow, Stream, StreamPreset, Whitepage } from '../types'
import { Dropdown, ErrorBox, Field, MenuItem, Modal, Select, Skeleton, Toggle, confirmDialog, toast } from '../components/ui'
import type { ToastAction } from '../components/ui'
import type { DateRange } from '../components/DateRangePicker'
import StreamEditor, { ACTION_ICONS, draftFromStream, landingPresets, newDraft, presetName, streamBody } from './StreamEditor'
import type { RefNames, StreamDraft } from './StreamEditor'
import StreamStats from './StreamStats'
import FunnelDrawer from './FunnelDrawer'
import { confirmCutOff, loadReport, sumRows } from '../reports'
import { buildSearch } from '../filters'
import { fmtInt, fmtMoney, fmtPct, ratioPct } from '../format'
import { dimIcon, FunnelIcon } from '../components/icons'
import { t, tn, ts, tx } from '../i18n'
import { StatBar } from '../components/StatBar'
import type { Metric } from '../components/StatBar'
import { ActionMenu } from '../components/ActionMenu'

interface StreamsResp {
  streams: Stream[] | null
  errors: Record<string, string> | null
  /** Names of every whitepage / target campaign the streams reference, including ones the viewer does not own. */
  whitepages?: Record<string, string> | null
  campaigns?: Record<string, string> | null
  landings?: Record<string, LandingRef> | null
}

const KINDS = ['forced', 'regular', 'default'] as const

/** Stream settings copied to be pasted into another stream, in any campaign. Kept in localStorage so it outlives the page. */
interface StreamClip {
  name: string
  filter_op: string
  filters: Filter[]
  action_type: string
  action_config: ActionConfig
  js_check: boolean
  weight: number
}
type PasteWhat = 'all' | 'filters' | 'action'
const CLIP_KEY = 'tds_stream_clip'

function readClip(): StreamClip | null {
  try {
    const v = JSON.parse(localStorage.getItem(CLIP_KEY) ?? 'null')
    return v && typeof v.action_type === 'string' ? v : null
  } catch {
    return null
  }
}

function pasteBody(c: StreamClip, what: PasteWhat): Partial<Stream> {
  const filters = { filter_op: c.filter_op, filters: c.filters }
  const action = { action_type: c.action_type, action_config: c.action_config }
  if (what === 'filters') return filters
  if (what === 'action') return action
  return { ...filters, ...action, js_check: c.js_check, weight: c.weight }
}
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
  const [copying, setCopying] = useState<Stream | null>(null)
  const [clip, setClip] = useState<StreamClip | null>(readClip)
  // Copied in another tab: offer it here too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === CLIP_KEY && setClip(readClip())
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const streams = useMemo(() => res.data?.streams ?? [], [res.data])
  const errors = res.data?.errors ?? {}
  const refNames: RefNames = useMemo(() => ({ whitepages: res.data?.whitepages ?? {}, campaigns: res.data?.campaigns ?? {}, landings: res.data?.landings ?? {} }), [res.data])
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

  /**
   * Puts a stream at index of a lane: a new place in its own lane, or another lane, which
   * changes what kind of stream it is.
   */
  const moveStream = async (s: Stream, kind: Kind, index: number) => {
    const from = s.kind as Kind
    const rest = byKind[kind].filter((x) => x.id !== s.id)
    const at = Math.max(0, Math.min(index, rest.length))
    if (from === kind && byKind[kind][at]?.id === s.id) return
    rest.splice(at, 0, from === kind ? s : { ...s, kind })
    if (from !== kind) {
      try {
        await put<Stream>(`streams/${s.id}`, { kind })
      } catch (e) {
        toast.err(e)
        return
      }
      toast.ok(t('“{name}” moved to {lane}', { name: s.name, lane: LANE[kind].title }))
    }
    await saveOrder({ ...byKind, [from]: byKind[from].filter((x) => x.id !== s.id), [kind]: rest })
  }

  const drop = (kind: Kind) => {
    const moving = streams.find((s) => s.id === dragId)
    const target = over
    setDragId(null)
    setOver(null)
    if (!moving || target?.id === moving.id) return
    // Dropped on a stream: before or after it; on the empty part of a lane: at its end.
    const rest = byKind[kind].filter((s) => s.id !== moving.id)
    const j = target ? rest.findIndex((s) => s.id === target.id) : -1
    moveStream(moving, kind, j < 0 ? rest.length : j + (target?.after ? 1 : 0))
  }

  /** Partial update of one stream, shown immediately. */
  const patch = async (s: Stream, body: Partial<Stream>, ok?: string, action?: ToastAction) => {
    try {
      const n = await put<Stream>(`streams/${s.id}`, body)
      // From the latest list, not the one captured before the request: another toggle may have landed meanwhile.
      res.setData((d) => d && { ...d, streams: (d.streams ?? []).map((x) => (x.id === s.id ? n : x)) })
      if (ok) toast.ok(ok, action)
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

  const copySettings = (s: Stream) => {
    const c: StreamClip = { name: s.name, filter_op: s.filter_op, filters: s.filters ?? [], action_type: s.action_type, action_config: s.action_config ?? {}, js_check: s.js_check, weight: s.weight }
    try {
      localStorage.setItem(CLIP_KEY, JSON.stringify(c))
    } catch {
      // Storage blocked: the copy still works on this page.
    }
    setClip(c)
    toast.ok(t('Settings of “{name}” copied — paste them from the menu of another stream', { name: s.name }))
  }

  const paste = (s: Stream, what: PasteWhat) => {
    if (!clip) return
    const ok = what === 'filters' ? t('Filters pasted into “{name}”', { name: s.name }) : what === 'action' ? t('Action pasted into “{name}”', { name: s.name }) : t('Settings pasted into “{name}”', { name: s.name })
    const body = pasteBody(clip, what)
    // What the paste overwrites, so Undo can put it back.
    const before = Object.fromEntries(Object.keys(body).map((k) => [k, s[k as keyof Stream] ?? (k === 'filters' ? [] : k === 'action_config' ? {} : null)])) as Partial<Stream>
    patch(s, body, ok, { label: t('Undo'), run: () => patch(s, before, t('“{name}” is back as it was', { name: s.name })) })
  }

  /** The switch moves at once and goes back if the server refuses; live traffic is asked about first. */
  const setStreamEnabled = async (s: Stream, enabled: boolean) => {
    if (!enabled && !(await confirmCutOff('stream', s.name, { campaign_id: campaign.id, stream_id: s.id }))) return
    const apply = (v: boolean) => res.setData((d) => d && { ...d, streams: (d.streams ?? []).map((x) => (x.id === s.id ? { ...x, enabled: v } : x)) })
    apply(enabled)
    try {
      const n = await put<Stream>(`streams/${s.id}`, { enabled })
      res.setData((d) => d && { ...d, streams: (d.streams ?? []).map((x) => (x.id === s.id ? n : x)) })
    } catch (e) {
      apply(!enabled)
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
  const metrics: Metric[] = [
    { label: t('Clicks'), value: fmtInt(total.clicks), metric: 'm-clicks', to: '/clicks' + buildSearch({ range, filters: scope }), title: t('Open the click log of this campaign'), sub: tn(total.uniques, '{n} unique', '{n} unique', { n: fmtInt(total.uniques) }) },
    { label: t('Bots'), value: ratioPct(total.bots, total.clicks), metric: 'm-bots', sub: tn(total.bots, '{n} click', '{n} clicks', { n: fmtInt(total.bots) }) },
    { label: t('Conv.'), value: fmtInt(total.conversions), metric: 'm-conv', to: '/conversions' + buildSearch({ range, filters: scope }), title: t('Open the conversion log of this campaign'), sub: `CR ${fmtPct(total.cr)}` },
    { label: t('Revenue'), value: fmtMoney(total.revenue, cur), metric: 'm-conv', sub: t('cost {value}', { value: fmtMoney(total.cost, cur) }) },
    {
      label: t('Profit'),
      value: fmtMoney(total.profit, cur),
      metric: total.profit < 0 ? 'm-loss' : 'm-conv',
      tone: total.profit > 0 ? 'pos' : total.profit < 0 ? 'neg' : '',
      sub: total.cost > 0 ? `ROI ${fmtPct(total.roi, 1)}` : t('no cost recorded'),
    },
  ]

  return (
    <div className="funnel">
      <div className="funnel-sb">
        <StatBar
          flat
          loading={stats.loading && !stats.data}
          metrics={metrics}
        />
      </div>

      <ErrorBox error={res.error} retry={res.reload} />
      {stats.error && <ErrorBox error={t('Stream statistics are unavailable: {error}', { error: stats.error })} retry={stats.reload} />}

      {res.loading && !res.data ? (
        <Skeleton rows={8} height={18} />
      ) : (
        <div className="lanes">
          <div className="stable l-flow">
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
                    if (dragId !== null) e.preventDefault()
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
                      dropMark={over && over.id === s.id && dragId !== null && dragId !== s.id ? (over.after ? 'after' : 'before') : null}
                      onDragStart={() => setDragId(s.id)}
                      onDragEnd={() => {
                        setDragId(null)
                        setOver(null)
                      }}
                      onDragOverCard={(e) => {
                        if (dragId === null) return
                        const r = e.currentTarget.getBoundingClientRect()
                        const after = e.clientY > r.top + r.height / 2
                        if (!over || over.id !== s.id || over.after !== after) setOver({ id: s.id, after })
                      }}
                      onEdit={() => setEditing(draftFromStream(s))}
                      onToggle={(enabled) => setStreamEnabled(s, enabled)}
                      onRename={(name) => patch(s, { name })}
                      onAction={(action_type, action_config, label) => patch(s, { action_type, action_config }, `${s.name}: ${label}`)}
                      onDuplicate={() => duplicate(s)}
                      onCopyTo={() => setCopying(s)}
                      onCopySettings={() => copySettings(s)}
                      clip={clip?.name ?? null}
                      onPaste={(what) => paste(s, what)}
                      onDelete={() => remove(s)}
                      onMove={(to) => (to === 'up' ? moveStream(s, kind, i - 1) : to === 'down' ? moveStream(s, kind, i + 1) : moveStream(s, to, byKind[to].length))}
                      canUp={i > 0}
                      canDown={i < list.length - 1}
                      kind={kind}
                      onStats={() => setStatsFor(s)}
                      onFunnel={() => setFunnelFor({ stream: s })}
                      onClicks={() => nav('/clicks' + buildSearch({ range, filters: { ...scope, stream_id: s.id } }))}
                      onConversions={() => nav('/conversions' + buildSearch({ range, filters: { ...scope, stream_id: s.id } }))}
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
      {copying && (
        <CopyStream
          stream={copying}
          campaign={campaign}
          campaigns={campaigns.filter(canEdit)}
          onClose={() => setCopying(null)}
          onDone={(target) => {
            if (target === campaign.id) res.reload()
          }}
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
  return { label, not, text, vals, flag: !def || def.input === 'none', title: `${label} ${not ? t('is not') : t('is')}${vals.length ? ': ' + vals.join(', ') : ''}${f.bypass ? ` (${t('bypassed@@filter')})` : ''}` }
}

/** Filters whose values carry an icon (a flag, a device). */
const ICON_DIMS = ['country', 'device_type', 'os', 'browser']

/** How many filters a row spells out before the rest fold into "+N more". */
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
    case 'landing': {
      const l = refNames?.landings[str('landing_id')]
      const shown = landingPresets(cfg.presets).map((p) => (l?.presets ?? []).find((x) => x.id === p.id)?.name ?? `#${p.id}`)
      detail = l ? l.name + (shown.length ? ` · ${shown.join(' / ')}` : '') : cfg.landing_id ? t('#{id} (missing)', { id: str('landing_id') }) : t('not chosen@@landing')
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
  onCopyTo,
  onCopySettings,
  clip,
  onPaste,
  onDelete,
  onMove,
  canUp,
  canDown,
  kind,
  onStats,
  onFunnel,
  onClicks,
  onConversions,
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
  onCopyTo: () => void
  onCopySettings: () => void
  /** Name of the stream whose settings were copied, if any. */
  clip: string | null
  onPaste: (what: PasteWhat) => void
  onDelete: () => void
  /** One place up or down its lane, or to the end of another lane. */
  onMove: (to: 'up' | 'down' | Kind) => void
  canUp: boolean
  canDown: boolean
  kind: Kind
  onStats: () => void
  onFunnel: () => void
  onClicks: () => void
  onConversions: () => void
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

  const drag = {
    draggable: armed && !readOnly,
    onDragStart: (e: DragEvent<HTMLDivElement>) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(s.id))
      onDragStart()
    },
    onDragEnd: () => {
      setArmed(false)
      onDragEnd()
    },
    onDragOver: onDragOverCard,
  }
  const rowClass = (s.enabled ? '' : ' off') + (dragging ? ' dragging' : '') + (dropMark ? ' drop-' + dropMark : '') + (error ? ' has-error' : '')
  const arm = { onMouseDown: () => setArmed(!readOnly), onMouseUp: () => setArmed(false) }

  const toggle = <Toggle checked={s.enabled} disabled={readOnly} onChange={onToggle} title={s.enabled ? t('Enabled — click to disable') : t('Disabled — click to enable')} />
  const nameEl =
    rename !== null ? (
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
    )
  const tagsEl = (s.js_check || showWeight || error) && (
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
  )

  // The same filters read as a sentence: "Country is DE, AT and not Bot".
  const join = s.filter_op === 'or' ? t('or@@filters') : t('and@@filters')
  const rule =
    filters.length === 0 ? (
      <span className="rtok any">{t('All visitors')}</span>
    ) : (
      <>
        {shown.map((f, i) => {
          const c = filterChip(f, filterDefs.get(f.type))
          return (
            <span key={i} className="rtok-wrap">
              {i > 0 && <span className="rjoin">{join}</span>}
              <span className={'rtok' + (c.not ? ' not' : '') + (f.bypass ? ' bypass' : '')} title={c.title}>
                {c.flag ? (
                  <>
                    {c.not && <em>{t('not')} </em>}
                    <b>{c.label}</b>
                  </>
                ) : (
                  <>
                    <i>
                      {c.label} {c.not ? t('is not') : t('is')}{' '}
                    </i>
                    {ICON_DIMS.includes(f.type) ? (
                      <b className="rvals">
                        {c.vals.slice(0, 3).map((v, j) => (
                          <span key={v} className="with-icon">
                            {dimIcon(f.type, v)}
                            {v}
                            {j < Math.min(c.vals.length, 3) - 1 && ','}
                          </span>
                        ))}
                        {c.vals.length > 3 && <i> +{c.vals.length - 3}</i>}
                      </b>
                    ) : (
                      <b className="rvals">{c.text}</b>
                    )}
                  </>
                )}
              </span>
            </span>
          )
        })}
        {hidden.length > 0 && (
          <span className="rtok more" title={hidden.map((f) => filterChip(f, filterDefs.get(f.type)).title).join('\n')}>
            {t('+{n} more', { n: hidden.length })}
          </span>
        )}
      </>
    )

  const actionEl = readOnly ? (
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
  )

  // The stream's figures for the period: clicks large, conversions and money beside them.
  const conv = stat?.conversions ?? 0
  const rev = stat?.revenue ?? 0
  const cost = stat?.cost ?? 0
  const profit = stat?.profit ?? 0
  const hasMoney = rev !== 0 || cost !== 0
  const q = (v: string) => (statsLoading ? '·' : v)
  const signed = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmtMoney(Math.abs(v), currency)
  const ptone = profit > 0 ? 'pos' : profit < 0 ? 'neg' : 'zero'
  const shareTxt = share >= 10 ? share.toFixed(0) + '%' : share.toFixed(1) + '%'
  const statsTitle = t('Statistics for the selected period — click to open the breakdown')
  // The conversions figure opens the conversion log; the rest of the block, the breakdown.
  const convLink = (node: ReactNode, className: string) =>
    conv ? (
      <span
        className={className + ' sv-link'}
        title={t('Open the conversion log of this stream')}
        onClick={(e) => {
          e.stopPropagation()
          onConversions()
        }}
      >
        {node}
      </span>
    ) : (
      <span className={className}>{node}</span>
    )
  const statsView = (
    <button className="sv sv-focus" onClick={onStats} title={statsTitle}>
      <span className="sv-main">
        <b className={clicks ? '' : 'z'}>{q(fmtInt(clicks))}</b>
        <small>
          {t('clicks@@unit')} · {shareTxt}
        </small>
      </span>
      <span className="sv-side">
        {convLink(conv ? t('{n} conv. · CR {cr}', { n: fmtInt(conv), cr: fmtPct(stat?.cr ?? 0) }) : t('no conversions'), conv ? 'good' : 'z')}
        {hasMoney ? (
          <span>
            {rev !== 0 && <span className="z">{fmtMoney(rev, currency)} </span>}<b className={ptone}>{q(signed(profit))}</b>
          </span>
        ) : (
          <span className="z">—</span>
        )}
      </span>
    </button>
  )

  const ctl = (
    <div className="srow-ctl">
      <button className="icon-btn" title={t('Click log of this stream')} aria-label={t('Click log')} onClick={onClicks}>
        <MousePointerClick size={15} />
      </button>
      <button className="icon-btn" title={t('Funnel of this stream')} aria-label={t('Funnel')} onClick={onFunnel}>
        <FunnelIcon size={15} />
      </button>
      <button className="icon-btn" title={readOnly ? t('View') : t('Edit')} aria-label={readOnly ? t('View') : t('Edit')} onClick={onEdit}>
        {readOnly ? <Eye size={15} /> : <Pencil size={15} />}
      </button>
      <ActionMenu
        sections={[
          {
            items: [
              { icon: <MousePointerClick size={15} />, label: t('Click log'), onClick: onClicks },
              { icon: <Target size={15} />, label: t('Conversion log'), onClick: onConversions },
              { icon: <FunnelIcon size={15} />, label: t('Funnel'), onClick: onFunnel },
              { icon: <BarChart3 size={15} />, label: t('Breakdown'), onClick: onStats },
            ],
          },
          {
            items: [
              ...(!readOnly ? [{ icon: <Copy size={15} />, label: t('Duplicate'), onClick: onDuplicate }] : []),
              { icon: <CopyPlus size={15} />, label: t('Copy to campaign…'), title: t('Copy this stream into another campaign you can edit'), onClick: onCopyTo },
              { icon: <ClipboardCopy size={15} />, label: t('Copy settings'), title: t('Remember the filters, action and options of this stream to paste them into another stream'), onClick: onCopySettings },
              ...(!readOnly && clip !== null
                ? [
                    { icon: <ClipboardPaste size={15} />, label: t('Paste settings'), title: t('Replace the filters, action, JS check and weight of this stream with those copied from “{name}”', { name: clip }), onClick: () => onPaste('all') },
                    { icon: <ClipboardPaste size={15} />, label: t('Paste filters'), title: t('Replace only the filters, with those copied from “{name}”', { name: clip }), onClick: () => onPaste('filters') },
                    { icon: <ClipboardPaste size={15} />, label: t('Paste action'), title: t('Replace only the action, with the one copied from “{name}”', { name: clip }), onClick: () => onPaste('action') },
                  ]
                : []),
            ],
          },
          {
            items: readOnly
              ? []
              : [
                  ...(canUp ? [{ icon: <ArrowUp size={15} />, label: t('Move up'), onClick: () => onMove('up') }] : []),
                  ...(canDown ? [{ icon: <ArrowDown size={15} />, label: t('Move down'), onClick: () => onMove('down') }] : []),
                  ...KINDS.filter((k) => k !== kind).map((k) => ({ icon: <CornerRightDown size={15} />, label: t('Move to {lane}', { lane: LANE[k].title }), title: LANE[k].desc, onClick: () => onMove(k) })),
                ],
          },
          { items: readOnly ? [] : [{ icon: <Trash2 size={15} />, label: t('Delete'), danger: true, onClick: onDelete }] },
        ]}
      />
    </div>
  )

  return (
    <div className={'frow' + rowClass} {...drag}>
      <span
        className={'frow-node' + (readOnly ? '' : ' grab')}
        title={readOnly ? undefined : t('Drag to reorder, or focus and press ↑ ↓')}
        {...arm}
        {...(readOnly
          ? {}
          : {
              tabIndex: 0,
              role: 'button',
              'aria-label': t('Stream {n}: press up or down arrow to move it', { n: index + 1 }),
              onKeyDown: (e: KeyboardEvent<HTMLSpanElement>) => {
                if (e.key === 'ArrowUp' && canUp) onMove('up')
                else if (e.key === 'ArrowDown' && canDown) onMove('down')
                else return
                e.preventDefault()
              },
            })}
      >
        {index + 1}
      </span>
      <div className="frow-body">
        <div className="frow-name">
          {toggle}
          {nameEl}
          {tagsEl}
        </div>
        {/* Alternatives stack inside a bracket marked "or"; filters that must all hold run inline joined by "and". */}
        <div className={'frow-cond' + (filters.length > 1 && s.filter_op === 'or' ? ' grp' : '')}>
          {filters.length > 1 && s.filter_op === 'or' && <span className="rgrp-label">{t('or@@filters')}</span>}
          {rule}
        </div>
      </div>
      <div className="frow-act">
        <ArrowRight size={15} className="act-arrow" aria-hidden="true" />
        {actionEl}
      </div>
      {statsView}
      {ctl}
    </div>
  )
}

/** Copies a stream to the end of its lane in a campaign the viewer can edit. */
function CopyStream({ stream, campaign, campaigns, onClose, onDone }: { stream: Stream; campaign: Campaign; campaigns: Campaign[]; onClose: () => void; onDone: (target: number) => void }) {
  const others = campaigns.filter((c) => c.id !== campaign.id)
  const [target, setTarget] = useState(String(others[0]?.id ?? (canEdit(campaign) ? campaign.id : '')))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const options = campaigns.map((c) => ({ value: String(c.id), label: c.id === campaign.id ? t('{name} (this campaign)', { name: c.name }) : c.name }))
  const run = async () => {
    setBusy(true)
    setError('')
    try {
      await post<Stream>(`streams/${stream.id}/copy`, { campaign_id: Number(target) })
      const name = campaigns.find((c) => String(c.id) === target)?.name ?? ''
      toast.ok(t('Stream “{stream}” copied to “{campaign}”', { stream: stream.name, campaign: name }))
      onDone(Number(target))
      onClose()
    } catch (e) {
      setError(errMsg(e))
      setBusy(false)
    }
  }
  return (
    <Modal
      title={t('Copy stream to campaign')}
      onClose={onClose}
      footer={
        <>
          {error && <div className="field-error grow">{error}</div>}
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !target} onClick={run}>
            <CopyPlus size={14} /> {busy ? t('Copying…') : t('Copy')}
          </button>
        </>
      }
    >
      <Field label={t('Campaign')} help={tx('A copy of <b>{name}</b> with its filters, action and options is added to the end of its lane there. Its statistics stay with this stream.', { b: (c) => <b>{c}</b>, name: stream.name })}>
        {options.length ? <Select value={target} onChange={setTarget} options={options} /> : <div className="muted">{t('You have no campaign you can edit.')}</div>}
      </Field>
    </Modal>
  )
}
