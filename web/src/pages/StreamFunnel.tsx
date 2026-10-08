import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AlertTriangle, BarChart3, ChevronDown, Copy, CornerDownRight, Eye, GripVertical, MoreVertical, MousePointerClick, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import { del, get, post, put } from '../api'
import { canEdit, useLoad, useMeta } from '../hooks'
import type { ActionConfig, ActionDef, Campaign, Filter, FilterDef, GeoPreset, ReportRow, Stream, StreamPreset, Whitepage } from '../types'
import { Dropdown, ErrorBox, MenuItem, Skeleton, Toggle, confirmDialog, toast } from '../components/ui'
import { DateRangePicker } from '../components/DateRangePicker'
import type { DateRange } from '../components/DateRangePicker'
import StreamEditor, { ACTION_ICONS, draftFromStream, newDraft, streamBody } from './StreamEditor'
import type { RefNames, StreamDraft } from './StreamEditor'
import StreamStats from './StreamStats'
import { loadReport } from '../reports'
import { buildSearch } from '../filters'
import { fmtInt, fmtMoney, fmtPct, ratioPct } from '../format'

interface StreamsResp {
  streams: Stream[] | null
  errors: Record<string, string> | null
  /** Names of every whitepage / target campaign the streams reference, including ones the viewer does not own. */
  whitepages?: Record<string, string> | null
  campaigns?: Record<string, string> | null
}

const KINDS = ['forced', 'regular', 'default'] as const
type Kind = (typeof KINDS)[number]

const LANE: Record<Kind, { title: string; desc: string; empty: string; add: string }> = {
  forced: {
    title: 'Forced',
    desc: 'Checked first, top to bottom — the first match wins.',
    empty: 'No forced streams. Add one to stop bots and unwanted traffic before anything else is evaluated.',
    add: 'Forced stream',
  },
  regular: { title: 'Regular', desc: '', empty: 'No regular streams. Add streams with filters (country, device, …) that lead to your offers.', add: 'Regular stream' },
  default: { title: 'Default', desc: 'The fallback for visitors that matched nothing above.', empty: 'No default stream: visitors that match nothing get a 404.', add: 'Default stream' },
}

export default function StreamFunnel({
  campaign,
  campaigns,
  whitepages,
  presets,
  readOnly,
  range,
  setRange,
}: {
  campaign: Campaign
  campaigns: Campaign[]
  whitepages: Whitepage[]
  presets: GeoPreset[]
  readOnly: boolean
  range: DateRange
  setRange: (r: DateRange) => void
}) {
  const meta = useMeta()
  const nav = useNavigate()
  const res = useLoad(() => get<StreamsResp>(`campaigns/${campaign.id}/streams`), [campaign.id])
  const stats = useLoad(() => loadReport('stream', range, { campaign_id: campaign.id }), [campaign.id, range.from, range.to])
  const own = useLoad(() => get<StreamPreset[] | null>('stream-presets'), [])
  const [editing, setEditing] = useState<StreamDraft | null>(null)
  const [statsFor, setStatsFor] = useState<Stream | null>(null)
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
  const totalClicks = useMemo(() => (stats.data ?? []).reduce((n, r) => n + r.clicks, 0), [stats.data])

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
      setStreams(streams.map((x) => (x.id === s.id ? n : x)))
      if (ok) toast.ok(ok)
      // Names of newly referenced whitepages and the error map come with the list.
      if (body.action_type !== undefined) res.reload()
    } catch (e) {
      toast.err(e)
    }
  }

  const duplicate = async (s: Stream) => {
    try {
      const body = { ...streamBody(draftFromStream(s), meta.actions), name: s.name + ' (copy)' }
      // Keep the stored config verbatim rather than the form-cleaned one.
      const created = await post<Stream>('streams', { ...body, action_config: s.action_config ?? {} })
      const list = [...byKind[s.kind]]
      list.splice(list.findIndex((x) => x.id === s.id) + 1, 0, created)
      await saveOrder({ ...byKind, [s.kind]: list })
      toast.ok('Stream duplicated')
    } catch (e) {
      toast.err(e)
    }
  }

  const remove = async (s: Stream) => {
    if (!(await confirmDialog({ title: 'Delete stream?', message: <>Stream <b>{s.name}</b> will be removed from this campaign. Its statistics are kept.</> }))) return
    try {
      await del(`streams/${s.id}`)
      toast.ok('Stream deleted')
      res.reload()
    } catch (e) {
      toast.err(e)
    }
  }

  const onSaved = async (saved: Stream, created: boolean, kindChanged: boolean) => {
    setEditing(null)
    toast.ok(created ? 'Stream created' : 'Stream saved')
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

  return (
    <div className="funnel">
      <div className="funnel-toolbar">
        <DateRangePicker value={range} onChange={setRange} />
        <span className="grow" />
        <Link className="btn" to={'/reports' + buildSearch({ range, group: 'stream', filters: scope })} title="Reports filtered to this campaign">
          <BarChart3 size={14} /> Open report
        </Link>
        {!readOnly && (
          <div className="split-btn">
            <button className="btn primary" onClick={() => add('regular')}>
              <Plus size={15} /> Add stream
            </button>
            <Dropdown align="right" className="btn primary split-caret" chevron={false} label={<ChevronDown size={14} />} title="Choose the kind of stream">
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

      <ErrorBox error={res.error} retry={res.reload} />
      {stats.error && <ErrorBox error={'Stream statistics are unavailable: ' + stats.error} retry={stats.reload} />}

      {res.loading && !res.data ? (
        <Skeleton rows={8} height={18} />
      ) : (
        <div className="lanes">
          {KINDS.map((kind, ki) => {
            const list = byKind[kind]
            return (
              <section key={kind} className={'lane kind-' + kind}>
                <header className="lane-head">
                  <span className="lane-node">{ki + 1}</span>
                  <h3>{LANE[kind].title}</h3>
                  <span className="count">{list.length}</span>
                  <span className="muted grow ellipsis">
                    {kind === 'regular' ? (campaign.rotation === 'weight' ? 'All matching streams take part in a weighted random draw.' : 'Checked top to bottom — the first stream whose filters match wins.') : LANE[kind].desc}
                  </span>
                  {!readOnly && (
                    <button className="btn small ghost" onClick={() => add(kind)} title={'Add a ' + LANE[kind].add.toLowerCase()}>
                      <Plus size={14} /> Add
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
                      onClicks={() => nav('/clicks' + buildSearch({ range, filters: { ...scope, stream_id: s.id } }))}
                    />
                  ))}
                </div>
                <div className="lane-next">{ki === 0 ? 'no forced stream matched' : ki === 1 ? 'no regular stream matched' : byKind.default.some((s) => s.enabled) ? 'default did not match either → 404' : 'nothing matched → 404'}</div>
              </section>
            )
          })}
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
          streamPresets={streamPresets}
          onPresetsChanged={own.reload}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
        />
      )}
      {statsFor && <StreamStats campaign={campaign} stream={statsFor} range={range} setRange={setRange} onClose={() => setStatsFor(null)} />}
    </div>
  )
}

/** "Country is RU, KZ +3" */
function filterChip(f: Filter, def: FilterDef | undefined) {
  const label = def?.label ?? f.type
  const not = f.mode === 'is_not'
  const vals = f.values ?? []
  let text = ''
  if (def && def.input !== 'none') {
    text = vals.slice(0, 3).join(', ') + (vals.length > 3 ? ` +${vals.length - 3}` : '')
  }
  return { label, not, text, flag: !def || def.input === 'none', title: `${label} ${not ? 'is not' : 'is'}${vals.length ? ': ' + vals.join(', ') : ''}` }
}

function urlHost(u: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(u)
  return m ? m[1] : u
}

export function actionSummary(s: Stream, actions: ActionDef[], whitepages: Whitepage[], campaigns: Campaign[], refNames?: RefNames): { label: string; detail: string; title: string } {
  const def = actions.find((a) => a.type === s.action_type)
  const cfg = s.action_config ?? {}
  const str = (k: string) => (cfg[k] === undefined || cfg[k] === null ? '' : String(cfg[k]))
  let label = def?.label ?? s.action_type
  let detail = ''
  let title = ''
  switch (s.action_type) {
    case 'redirect':
      label = 'Redirect'
      detail = urlHost(str('url'))
      title = `${str('url')}${str('method') ? ` (${str('method')})` : ''}`
      break
    case 'whitepage': {
      const w = whitepages.find((x) => x.id === Number(cfg.whitepage_id))
      // In a shared campaign the owner's whitepages are not in the viewer's own list: the server supplies their names.
      detail = w ? w.name : cfg.whitepage_id ? refNames?.whitepages[str('whitepage_id')] ?? `#${str('whitepage_id')} (missing)` : 'not chosen'
      break
    }
    case 'campaign': {
      const c = campaigns.find((x) => x.id === Number(cfg.campaign_id))
      label = 'Campaign'
      detail = c ? c.name : cfg.campaign_id ? refNames?.campaigns[str('campaign_id')] ?? `#${str('campaign_id')} (missing)` : 'not chosen'
      break
    }
    case 'status':
      label = 'HTTP ' + (str('code') || '404')
      break
    case 'text':
      label = 'Text / HTML'
      detail = str('content').replace(/\s+/g, ' ').slice(0, 60)
      break
    case 'remote_js':
      label = 'Remote JS'
      detail = urlHost(str('url'))
      title = str('url')
      break
    default: {
      const first = (def?.fields ?? []).find((f) => f.required)
      detail = first ? str(first.name) : ''
    }
  }
  return { label, detail, title: title || [def?.label, detail].filter(Boolean).join(': ') }
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
  const cell = (label: string, value: string, zero: boolean, title?: string) => (
    <div className={'st' + (zero ? ' zero' : '')} title={title}>
      <b>{statsLoading ? '·' : value}</b>
      <span>{label}</span>
    </div>
  )

  const actionLabel = (
    <>
      <Icon size={14} />
      <b>{act.label}</b>
      {act.detail && <span className="ellipsis">{act.detail}</span>}
    </>
  )

  return (
    <div
      className={'scard' + (s.enabled ? '' : ' off') + (dragging ? ' dragging' : '') + (dropMark ? ' drop-' + dropMark : '') + (error ? ' has-error' : '')}
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
      <div className={'scard-grip' + (readOnly ? ' fixed' : '')} title={readOnly ? undefined : 'Drag to reorder'} onMouseDown={() => setArmed(!readOnly)} onMouseUp={() => setArmed(false)}>
        {!readOnly && <GripVertical size={15} />}
        <span>{index + 1}</span>
      </div>
      <Toggle checked={s.enabled} disabled={readOnly} onChange={onToggle} title={s.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'} />

      <div className="scard-main">
        <div className="scard-title">
          {rename !== null ? (
            <input
              className="input input-sm scard-rename"
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
            <button className="scard-name" onClick={nameClick} onDoubleClick={nameDoubleClick} title={readOnly ? 'View stream' : 'Click to edit · double-click to rename'}>
              {s.name}
            </button>
          )}
          {s.js_check && (
            <span className="badge info" title="JS check: the browser must run a script before the action">
              <ShieldCheck size={12} /> JS
            </span>
          )}
          {showWeight && (
            <span className="badge neutral" title="Weight and share among enabled regular streams">
              w {s.weight}
              {s.enabled && totalWeight > 0 ? ` · ${ratioPct(s.weight, totalWeight, 0)}` : ''}
            </span>
          )}
          {!s.enabled && <span className="badge neutral">off</span>}
          {error && (
            <span className="badge err" title={error}>
              <AlertTriangle size={12} /> {error}
            </span>
          )}
        </div>
        <div className="scard-flow">
          <div className="fchips">
            {filters.length === 0 ? (
              <span className="fchip any">All visitors</span>
            ) : (
              filters.map((f, i) => {
                const c = filterChip(f, filterDefs.get(f.type))
                return (
                  <span key={i} className="fchip-wrap">
                    {i > 0 && <span className="fop">{s.filter_op === 'or' ? 'or' : 'and'}</span>}
                    <span className={'fchip' + (c.not ? ' not' : '')} title={c.title}>
                      {c.flag && c.not && <i>not</i>}
                      <b>{c.label}</b>
                      {!c.flag && <i>{c.not ? 'is not' : 'is'}</i>}
                      {c.text && <span>{c.text}</span>}
                    </span>
                  </span>
                )
              })
            )}
          </div>
          <span className="flow-arrow">→</span>
          {readOnly ? (
            <div className="scard-action static" title={act.title}>
              {actionLabel}
            </div>
          ) : (
            <Dropdown className="scard-action" label={actionLabel} title={act.title + ' — click to switch the action'}>
              {(close) => {
                const pick = (type: string, cfg: ActionConfig, label: string) => {
                  close()
                  onAction(type, cfg, label)
                }
                return (
                  <div className="menu quick-menu">
                    <div className="menu-title">Whitepage</div>
                    {whitepages.length === 0 && <div className="muted pad-s">No whitepages uploaded yet.</div>}
                    {whitepages.map((w) => (
                      <MenuItem key={w.id} onClick={() => pick('whitepage', { whitepage_id: w.id }, `whitepage “${w.name}”`)}>
                        <WpIcon size={14} />
                        <span className="grow ellipsis">{w.name}</span>
                        {w.id === currentWp ? <span className="badge ok">current</span> : <span className="muted small">{w.kind}</span>}
                      </MenuItem>
                    ))}
                    <div className="menu-title">Stop</div>
                    <MenuItem onClick={() => pick('status', { code: 404 }, '404')}>
                      <StopIcon size={14} /> <span className="grow">404 Not Found</span>
                    </MenuItem>
                    {actionPresets.length > 0 && <div className="menu-title">Action presets</div>}
                    {actionPresets.map((p, i) => {
                      const PIcon = ACTION_ICONS[p.data.action_type ?? ''] ?? CornerDownRight
                      return (
                        <MenuItem key={p.id ?? 'b' + i} onClick={() => p.data.action_type && pick(p.data.action_type, p.data.action_config ?? {}, `preset “${p.name}”`)}>
                          <PIcon size={14} />
                          <span className="grow ellipsis">{p.name}</span>
                          {p.builtin && <span className="muted small">built-in</span>}
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
                      <Pencil size={14} /> Other action… (open editor)
                    </MenuItem>
                  </div>
                )
              }}
            </Dropdown>
          )}
        </div>
      </div>

      <button className="scard-stats" onClick={onStats} title="Statistics for the selected period — click to drill down">
        <div className="st-row">
          {cell('Clicks', fmtInt(clicks), clicks === 0)}
          {cell('Uniq', fmtInt(stat?.uniques ?? 0), !stat?.uniques)}
          {cell('Bots', fmtInt(stat?.bots ?? 0), !stat?.bots)}
          {cell('Conv', fmtInt(stat?.conversions ?? 0), !stat?.conversions)}
          {cell('CR', fmtPct(stat?.cr ?? 0), !stat?.cr, 'Conversions / non-bot clicks')}
          {cell('Rev', fmtMoney(stat?.revenue ?? 0), !stat?.revenue)}
        </div>
        <div className="share" title={`${share.toFixed(1)}% of this campaign's clicks`}>
          <div className="share-bar">
            <div style={{ width: `${share}%` }} />
          </div>
          <span>{share >= 10 ? share.toFixed(0) : share.toFixed(1)}%</span>
        </div>
      </button>

      <div className="scard-ctl">
        <button className="icon-btn" title={readOnly ? 'View' : 'Edit'} onClick={onEdit}>
          {readOnly ? <Eye size={15} /> : <Pencil size={15} />}
        </button>
        <Dropdown align="right" className="icon-btn" chevron={false} label={<MoreVertical size={16} />} title="More">
          {(close) => {
            const run = (fn: () => void) => () => {
              close()
              fn()
            }
            return (
              <div className="menu">
                <MenuItem onClick={run(onEdit)}>
                  {readOnly ? <Eye size={14} /> : <Pencil size={14} />} {readOnly ? 'View' : 'Edit'}
                </MenuItem>
                {!readOnly && (
                  <MenuItem onClick={run(onDuplicate)}>
                    <Copy size={14} /> Duplicate
                  </MenuItem>
                )}
                <MenuItem onClick={run(onStats)}>
                  <BarChart3 size={14} /> Stats
                </MenuItem>
                <MenuItem onClick={run(onClicks)}>
                  <MousePointerClick size={14} /> Clicks
                </MenuItem>
                {!readOnly && (
                  <>
                    <div className="menu-sep" />
                    <MenuItem danger onClick={run(onDelete)}>
                      <Trash2 size={14} /> Delete
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
