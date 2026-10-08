import { useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import { AlertTriangle, ArrowDown, Ban, Code2, Copy, CornerDownRight, ExternalLink, Eye, FileCode2, FileText, GripVertical, Pencil, Plus, ShieldCheck, Split, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { del, get, post, put } from '../api'
import { canEdit, useLoad, useMeta } from '../hooks'
import type { ActionDef, Campaign, Filter, FilterDef, GeoPreset, Stream, Whitepage } from '../types'
import { Badge, ErrorBox, Skeleton, Toggle, confirmDialog, toast } from '../components/ui'
import StreamEditor, { draftFromStream, newDraft, streamBody } from './StreamEditor'
import type { StreamDraft } from './StreamEditor'
import { flag } from '../countries'
import { ratioPct } from '../format'

interface StreamsResp {
  streams: Stream[] | null
  errors: Record<string, string> | null
  /** Names of every whitepage / target campaign the streams reference, including ones the viewer does not own. */
  whitepages?: Record<string, string> | null
  campaigns?: Record<string, string> | null
}

export interface RefNames {
  whitepages: Record<string, string>
  campaigns: Record<string, string>
}

const KINDS = ['forced', 'regular', 'default'] as const

const ACTION_ICONS: Record<string, LucideIcon> = {
  status: Ban,
  text: FileText,
  redirect: ExternalLink,
  whitepage: FileCode2,
  remote_js: Code2,
  campaign: Split,
  nothing: CornerDownRight,
}

export default function StreamFunnel({ campaign, campaigns, whitepages, presets, readOnly }: { campaign: Campaign; campaigns: Campaign[]; whitepages: Whitepage[]; presets: GeoPreset[]; readOnly: boolean }) {
  const meta = useMeta()
  const res = useLoad(() => get<StreamsResp>(`campaigns/${campaign.id}/streams`), [campaign.id])
  const [editing, setEditing] = useState<StreamDraft | null>(null)
  const [dragId, setDragId] = useState<number | null>(null)
  const [over, setOver] = useState<{ id: number; after: boolean } | null>(null)

  const streams = useMemo(() => res.data?.streams ?? [], [res.data])
  const errors = res.data?.errors ?? {}
  const refNames: RefNames = useMemo(() => ({ whitepages: res.data?.whitepages ?? {}, campaigns: res.data?.campaigns ?? {} }), [res.data])
  const byKind = useMemo(() => {
    const m: Record<string, Stream[]> = { forced: [], regular: [], default: [] }
    for (const s of streams) (m[s.kind] ?? m.regular).push(s)
    return m
  }, [streams])
  const filterDefs = useMemo(() => new Map(meta.filters.map((f) => [f.type, f])), [meta.filters])

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

  const toggle = async (s: Stream, enabled: boolean) => {
    try {
      await put(`streams/${s.id}`, { enabled })
      setStreams(streams.map((x) => (x.id === s.id ? { ...x, enabled } : x)))
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
    if (!(await confirmDialog({ title: 'Delete stream?', message: <>Stream <b>{s.name}</b> will be removed from this campaign.</> }))) return
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
      // New streams and streams moved between sections go to the end of their section.
      const groups: Record<string, Stream[]> = {}
      for (const k of KINDS) groups[k] = byKind[k].filter((s) => s.id !== saved.id)
      ;(groups[saved.kind] ?? groups.regular).push(saved)
      await saveOrder(groups)
    } else {
      await res.reload()
    }
  }

  if (res.loading && !res.data) return <Skeleton rows={8} height={18} />

  const totalWeight = byKind.regular.filter((s) => s.enabled).reduce((n, s) => n + s.weight, 0)

  return (
    <div className="funnel">
      <ErrorBox error={res.error} retry={res.reload} />
      {KINDS.map((kind, ki) => {
        const list = byKind[kind]
        return (
          <div key={kind}>
            {ki > 0 && (
              <div className="funnel-arrow">
                <ArrowDown size={16} />
                <span>{ki === 1 ? 'no forced stream matched' : 'no regular stream matched'}</span>
              </div>
            )}
            <section className={'funnel-section kind-' + kind}>
              <header>
                <div className="funnel-step">{ki + 1}</div>
                <div className="grow">
                  <h3>
                    {SECTION[kind].title} <span className="count">{list.length}</span>
                  </h3>
                  <div className="muted">{kind === 'regular' ? (campaign.rotation === 'weight' ? 'All matching streams take part in a weighted random draw.' : 'Checked top to bottom; the first stream whose filters match wins.') : SECTION[kind].desc}</div>
                </div>
                {!readOnly && (
                  <button className="btn small" onClick={() => setEditing(newDraft(campaign.id, kind, meta.actions))}>
                    <Plus size={14} /> Add stream
                  </button>
                )}
              </header>
              <div
                className="funnel-list"
                onDragOver={(e) => {
                  if (dragId !== null && list.some((s) => s.id === dragId)) e.preventDefault()
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  drop(kind)
                }}
              >
                {list.length === 0 && <div className="funnel-empty">{SECTION[kind].empty}</div>}
                {list.map((s, i) => (
                  <StreamCard
                    key={s.id}
                    stream={s}
                    index={i}
                    readOnly={readOnly}
                    refNames={refNames}
                    error={errors[String(s.id)]}
                    showWeight={campaign.rotation === 'weight' && kind === 'regular'}
                    totalWeight={totalWeight}
                    filterDefs={filterDefs}
                    actions={meta.actions}
                    whitepages={whitepages}
                    campaigns={campaigns}
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
                    onToggle={(v) => toggle(s, v)}
                    onDuplicate={() => duplicate(s)}
                    onDelete={() => remove(s)}
                  />
                ))}
              </div>
            </section>
          </div>
        )
      })}
      <div className="funnel-arrow end">
        <ArrowDown size={16} />
        <span>{byKind.default.some((s) => s.enabled) ? 'if the default stream does not match either: 404' : 'nothing matched: the visitor gets a 404'}</span>
      </div>

      {editing && <StreamEditor readOnly={readOnly} refNames={refNames} draft={editing} campaign={campaign} campaigns={campaigns.filter(canEdit)} whitepages={whitepages} presets={presets} onClose={() => setEditing(null)} onSaved={onSaved} />}
    </div>
  )
}

const SECTION: Record<string, { title: string; desc: string; empty: string }> = {
  forced: {
    title: 'Forced streams',
    desc: 'Checked first, top to bottom; the first match wins. Put bot and moderation filters here.',
    empty: 'No forced streams. Add one to send bots to a whitepage before anything else is evaluated.',
  },
  regular: { title: 'Regular streams', desc: '', empty: 'No regular streams. Add streams with filters (country, device, …) that lead to your offers.' },
  default: {
    title: 'Default stream',
    desc: 'The fallback for visitors that matched nothing above.',
    empty: 'No default stream: visitors that match nothing get a 404.',
  },
}

function filterChip(f: Filter, def: FilterDef | undefined) {
  const label = def?.label ?? f.type
  const not = f.mode === 'is_not'
  const vals = f.values ?? []
  let text = ''
  if (def && def.input !== 'none') {
    const shown = vals.slice(0, 4).map((v) => (def.input === 'countries' ? `${flag(v)} ${v}`.trim() : v))
    text = shown.join(', ') + (vals.length > 4 ? ` +${vals.length - 4}` : '')
  }
  return { label, not, text, title: `${label} ${not ? 'is not' : 'is'}${vals.length ? ': ' + vals.join(', ') : ''}` }
}

export function actionSummary(s: Stream, actions: ActionDef[], whitepages: Whitepage[], campaigns: Campaign[], refNames?: RefNames): { label: string; detail: string } {
  const def = actions.find((a) => a.type === s.action_type)
  const cfg = s.action_config ?? {}
  const str = (k: string) => (cfg[k] === undefined || cfg[k] === null ? '' : String(cfg[k]))
  let detail = ''
  switch (s.action_type) {
    case 'redirect':
      detail = `${str('url')}${str('method') && str('method') !== '302' ? ` · ${str('method')}` : ''}`
      break
    case 'whitepage': {
      const w = whitepages.find((x) => x.id === Number(cfg.whitepage_id))
      // In a shared campaign the owner's whitepages are not in the viewer's own list: the server supplies their names.
      detail = w ? w.name : cfg.whitepage_id ? refNames?.whitepages[str('whitepage_id')] ?? `#${str('whitepage_id')} (missing)` : 'not chosen'
      break
    }
    case 'campaign': {
      const c = campaigns.find((x) => x.id === Number(cfg.campaign_id))
      detail = c ? c.name : cfg.campaign_id ? refNames?.campaigns[str('campaign_id')] ?? `#${str('campaign_id')} (missing)` : 'not chosen'
      break
    }
    case 'status':
      detail = str('code') || '404'
      break
    case 'text':
      detail = str('content').replace(/\s+/g, ' ').slice(0, 80)
      break
    case 'remote_js':
      detail = str('url')
      break
    default: {
      const first = (def?.fields ?? []).find((f) => f.required)
      detail = first ? str(first.name) : ''
    }
  }
  return { label: def?.label ?? s.action_type, detail }
}

function StreamCard({
  stream: s,
  index,
  readOnly,
  refNames,
  error,
  showWeight,
  totalWeight,
  filterDefs,
  actions,
  whitepages,
  campaigns,
  dragging,
  dropMark,
  onDragStart,
  onDragEnd,
  onDragOverCard,
  onEdit,
  onToggle,
  onDuplicate,
  onDelete,
}: {
  stream: Stream
  index: number
  readOnly: boolean
  refNames: RefNames
  error?: string
  showWeight: boolean
  totalWeight: number
  filterDefs: Map<string, FilterDef>
  actions: ActionDef[]
  whitepages: Whitepage[]
  campaigns: Campaign[]
  dragging: boolean
  dropMark: 'before' | 'after' | null
  onDragStart: () => void
  onDragEnd: () => void
  onDragOverCard: (e: DragEvent<HTMLDivElement>) => void
  onEdit: () => void
  onToggle: (v: boolean) => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const [armed, setArmed] = useState(false)
  const filters = s.filters ?? []
  const act = actionSummary(s, actions, whitepages, campaigns, refNames)
  const Icon = ACTION_ICONS[s.action_type] ?? CornerDownRight
  return (
    <div
      className={'stream-card' + (s.enabled ? '' : ' off') + (dragging ? ' dragging' : '') + (dropMark ? ' drop-' + dropMark : '') + (error ? ' has-error' : '')}
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
      <div className={'stream-grip' + (readOnly ? ' fixed' : '')} title={readOnly ? undefined : 'Drag to reorder'} onMouseDown={() => setArmed(!readOnly)} onMouseUp={() => setArmed(false)}>
        {!readOnly && <GripVertical size={16} />}
        <span>{index + 1}</span>
      </div>
      <div className="stream-body" onDoubleClick={onEdit}>
        <div className="stream-top">
          <button className="stream-name" onClick={onEdit} title={readOnly ? 'View stream' : 'Edit stream'}>
            {s.name}
          </button>
          {s.js_check && (
            <Badge tone="info" title="JS check: the browser must run a script before the action">
              <ShieldCheck size={12} /> JS check
            </Badge>
          )}
          {!s.enabled && <Badge>disabled</Badge>}
          {error && (
            <Badge tone="err" title={error}>
              <AlertTriangle size={12} /> {error}
            </Badge>
          )}
        </div>
        <div className="stream-flow">
          <div className="stream-filters">
            {filters.length === 0 ? (
              <span className="fchip any">All visitors</span>
            ) : (
              filters.map((f, i) => {
                const c = filterChip(f, filterDefs.get(f.type))
                return (
                  <span key={i} className="fchip-wrap">
                    {i > 0 && <span className="fop">{s.filter_op === 'or' ? 'or' : 'and'}</span>}
                    <span className={'fchip' + (c.not ? ' not' : '')} title={c.title}>
                      <b>{c.label}</b>
                      {c.not && <i>not</i>}
                      {c.text && <span>{c.text}</span>}
                    </span>
                  </span>
                )
              })
            )}
          </div>
          <div className="stream-action" title={act.detail}>
            <Icon size={14} />
            <b>{act.label}</b>
            {act.detail && <span className="ellipsis mono">{act.detail}</span>}
          </div>
        </div>
      </div>
      {showWeight && (
        <div className="stream-weight" title="Weight and share among enabled regular streams">
          <b>{s.weight}</b>
          <span>{s.enabled ? ratioPct(s.weight, totalWeight, 0) : '—'}</span>
        </div>
      )}
      <div className="stream-ctl">
        <Toggle checked={s.enabled} disabled={readOnly} onChange={onToggle} title={s.enabled ? 'Enabled' : 'Disabled'} />
        <button className="icon-btn" title={readOnly ? 'View' : 'Edit'} onClick={onEdit}>
          {readOnly ? <Eye size={15} /> : <Pencil size={15} />}
        </button>
        {!readOnly && (
          <>
            <button className="icon-btn" title="Duplicate" onClick={onDuplicate}>
              <Copy size={15} />
            </button>
            <button className="icon-btn danger" title="Delete" onClick={onDelete}>
              <Trash2 size={15} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
