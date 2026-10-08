import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Ban, BookmarkPlus, Check, Code2, CornerDownRight, ExternalLink, Eye, FileCode2, FileText, Pencil, Plus, Search, Split, Trash2, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { del, errMsg, get, post, put } from '../api'
import { useMeta } from '../hooks'
import type { ActionConfig, ActionDef, ActionField, Campaign, Filter, FilterDef, GeoPreset, Stream, StreamPreset, Whitepage } from '../types'
import { Chips, Drawer, Dropdown, Field, MenuItem, MultiSelect, Notice, NumberInput, Segmented, Select, Toggle, confirmDialog, toast } from '../components/ui'
import { CountrySelect } from '../components/CountrySelect'

export const ACTION_ICONS: Record<string, LucideIcon> = {
  status: Ban,
  text: FileText,
  redirect: ExternalLink,
  whitepage: FileCode2,
  remote_js: Code2,
  campaign: Split,
  nothing: CornerDownRight,
}

export interface StreamDraft {
  id?: number
  campaign_id: number
  name: string
  kind: string
  weight: number | ''
  enabled: boolean
  js_check: boolean
  filter_op: string
  filters: Filter[]
  action_type: string
  action_config: ActionConfig
  note: string
}

export interface RefNames {
  whitepages: Record<string, string>
  campaigns: Record<string, string>
}

export function defaultConfig(def: ActionDef | undefined): ActionConfig {
  const cfg: ActionConfig = {}
  for (const f of def?.fields ?? []) {
    if (f.default !== undefined && f.default !== null) cfg[f.name] = f.default
    else if (f.type === 'bool') cfg[f.name] = false
  }
  return cfg
}

export function newDraft(campaignId: number, kind: string, actions: ActionDef[]): StreamDraft {
  const def = actions.find((a) => a.type === 'redirect') ?? actions[0]
  return {
    campaign_id: campaignId,
    name: '',
    kind,
    weight: 100,
    enabled: true,
    js_check: false,
    filter_op: 'and',
    filters: [],
    action_type: def?.type ?? '',
    action_config: defaultConfig(def),
    note: '',
  }
}

const cloneFilters = (fs: Filter[] | null | undefined): Filter[] => (fs ?? []).map((f) => ({ type: f.type, mode: f.mode === 'is_not' ? 'is_not' : 'is', values: [...(f.values ?? [])] }))

export function draftFromStream(s: Stream): StreamDraft {
  return {
    id: s.id,
    campaign_id: s.campaign_id,
    name: s.name,
    kind: s.kind,
    weight: s.weight,
    enabled: s.enabled,
    js_check: s.js_check,
    filter_op: s.filter_op || 'and',
    filters: cloneFilters(s.filters),
    action_type: s.action_type,
    action_config: { ...(s.action_config ?? {}) },
    note: s.note,
  }
}

/** Shapes the config for the API: only the action's own fields, numbers as numbers, bools as bools. */
export function cleanConfig(def: ActionDef | undefined, cfg: ActionConfig): ActionConfig {
  const out: ActionConfig = {}
  for (const f of def?.fields ?? []) {
    const v = cfg[f.name]
    switch (f.type) {
      case 'number':
      case 'whitepage':
      case 'campaign': {
        if (v === '' || v === undefined || v === null) {
          if (typeof f.default === 'number') out[f.name] = f.default
          break
        }
        const n = Number(v)
        if (Number.isFinite(n)) out[f.name] = n
        break
      }
      case 'bool':
        out[f.name] = v === true || v === 'true'
        break
      default:
        if (v !== undefined && v !== null) out[f.name] = String(v)
    }
  }
  return out
}

const cleanFilters = (fs: Filter[]) => fs.map((f) => ({ type: f.type, mode: f.mode, values: f.values.map((v) => v.trim()).filter(Boolean) }))

export function streamBody(d: StreamDraft, actions: ActionDef[]) {
  return {
    campaign_id: d.campaign_id,
    name: d.name.trim(),
    kind: d.kind,
    weight: d.weight === '' ? 0 : d.weight,
    enabled: d.enabled,
    js_check: d.js_check,
    filter_op: d.filter_op,
    // Every filter is sent whole.
    filters: cleanFilters(d.filters),
    action_type: d.action_type,
    action_config: cleanConfig(
      actions.find((a) => a.type === d.action_type),
      d.action_config,
    ),
    note: d.note,
  }
}

interface Props {
  draft: StreamDraft
  campaign: Campaign
  campaigns: Campaign[]
  whitepages: Whitepage[]
  presets: GeoPreset[]
  /** Built-in and own filter / action presets. */
  streamPresets: StreamPreset[]
  onPresetsChanged: () => void
  readOnly?: boolean
  /** Names of referenced whitepages / campaigns that are not in the user's own lists. */
  refNames?: RefNames
  onClose: () => void
  onSaved: (s: Stream, created: boolean, kindChanged: boolean) => void
}

const KIND_HELP: Record<string, string> = {
  forced: 'Checked before everything else, top to bottom; the first match wins. For traffic that must never reach an offer.',
  regular: 'The main streams: first match by position, or a weighted draw among the matches, depending on the campaign rotation.',
  default: 'The fallback when no forced or regular stream matched. Usually has no filters.',
}

export default function StreamEditor({ draft: initial, campaign, campaigns, whitepages, presets, streamPresets, onPresetsChanged, readOnly, refNames, onClose, onSaved }: Props) {
  const meta = useMeta()
  const [d, setD] = useState<StreamDraft>(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tried, setTried] = useState(false)
  const set = (patch: Partial<StreamDraft>) => setD((x) => ({ ...x, ...patch }))

  const filterDefs = useMemo(() => new Map(meta.filters.map((f) => [f.type, f])), [meta.filters])
  const actionDef = meta.actions.find((a) => a.type === d.action_type)
  const baseline = useMemo(() => JSON.stringify(streamBody(initial, meta.actions)), [initial, meta.actions])
  const dirty = !readOnly && JSON.stringify(streamBody(d, meta.actions)) !== baseline

  const filterError = (f: Filter): string => {
    const def = filterDefs.get(f.type)
    if (!def) return 'Unknown filter type'
    if (def.input !== 'none' && f.values.filter((v) => v.trim()).length === 0) return 'Add at least one value'
    return ''
  }
  const fieldError = (f: ActionField): string => {
    if (!f.required) return ''
    const v = d.action_config[f.name]
    return v === undefined || v === null || v === '' || v === 0 ? 'Required' : ''
  }
  const invalid = !d.name.trim() || d.filters.some((f) => filterError(f)) || (actionDef?.fields ?? []).some((f) => fieldError(f))

  const close = async () => {
    if (dirty && !(await confirmDialog({ title: 'Discard unsaved changes?', confirmLabel: 'Discard', message: 'The changes you made to this stream have not been saved.' }))) return
    onClose()
  }

  const save = async () => {
    setTried(true)
    if (invalid) {
      setError('Fix the highlighted fields first.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const body = streamBody(d, meta.actions)
      const saved = d.id ? await put<Stream>(`streams/${d.id}`, body) : await post<Stream>('streams', body)
      onSaved(saved, !d.id, d.kind !== initial.kind)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const setFilter = (i: number, patch: Partial<Filter>) => set({ filters: d.filters.map((f, j) => (j === i ? { ...f, ...patch } : f)) })
  const filterOptions = meta.filters.map((f) => ({ value: f.type, label: f.label, group: f.group }))

  const applyFilterPreset = async (p: StreamPreset) => {
    if (d.filters.length > 0 && !(await confirmDialog({ title: 'Replace the current filters?', danger: false, confirmLabel: 'Replace', message: <>The {d.filters.length} filter{d.filters.length === 1 ? '' : 's'} of this stream will be replaced by preset <b>{p.name}</b>.</> }))) return
    set({ filters: cloneFilters(p.data.filters), filter_op: p.data.filter_op === 'or' ? 'or' : 'and' })
  }
  const applyActionPreset = (p: StreamPreset) => {
    const def = meta.actions.find((a) => a.type === p.data.action_type)
    if (!def) return toast.err(`Preset “${p.name}” uses an action this server does not have`)
    set({ action_type: def.type, action_config: { ...defaultConfig(def), ...(p.data.action_config ?? {}) } })
  }

  const showWeight = d.kind === 'regular'

  return (
    <Drawer
      title={
        <>
          {d.id ? (readOnly ? 'Stream' : 'Edit stream') : 'New stream'}
          {readOnly && <span className="badge neutral">read-only</span>}
          {dirty && <span className="badge warn">unsaved</span>}
        </>
      }
      onClose={close}
      size="xl"
      footer={
        readOnly ? (
          <button className="btn" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            {error && <div className="field-error grow">{error}</div>}
            <button className="btn" onClick={close}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || (!!d.id && !dirty)} onClick={save}>
              {busy ? 'Saving…' : d.id ? 'Save stream' : 'Create stream'}
            </button>
          </>
        )
      }
    >
      <fieldset className="plain se" disabled={readOnly}>
        {/* ---- header ---- */}
        <section className="se-head">
          <div className="se-name">
            <input className={'input input-lg' + (tried && !d.name.trim() ? ' invalid' : '')} autoFocus={!d.id} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Stream name, e.g. DE mobile → offer A" aria-label="Stream name" />
            {tried && !d.name.trim() && <div className="field-error">Name is required</div>}
          </div>
          <div className="se-opts">
            <div className="se-opt">
              <span className="se-opt-label">Kind</span>
              <Segmented
                small
                value={d.kind}
                onChange={(kind) => set({ kind })}
                options={[
                  { value: 'forced', label: 'Forced', title: KIND_HELP.forced },
                  { value: 'regular', label: 'Regular', title: KIND_HELP.regular },
                  { value: 'default', label: 'Default', title: KIND_HELP.default },
                ]}
              />
            </div>
            {showWeight && (
              <div className="se-opt" title={campaign.rotation === 'weight' ? 'Share of matching traffic among regular streams. 0 excludes the stream from the draw.' : 'Used only when the campaign rotation is “weight” (currently “position”).'}>
                <span className="se-opt-label">Weight{campaign.rotation !== 'weight' && ' (unused)'}</span>
                <NumberInput className="input-sm w-80" value={d.weight} min={0} max={100000} onChange={(weight) => set({ weight })} />
              </div>
            )}
            <div className="se-opt">
              <span className="se-opt-label">Status</span>
              <Toggle checked={d.enabled} onChange={(enabled) => set({ enabled })} label={d.enabled ? 'Enabled' : 'Disabled'} />
            </div>
            <div className="se-opt" title="Before the action runs, the visitor's browser must execute a small script and reload. Works on the direct campaign URL only (JS and PHP integrations skip it), adds one extra round trip, and browsers that fail it are re-routed as bots.">
              <span className="se-opt-label">JS check</span>
              <Toggle checked={d.js_check} onChange={(js_check) => set({ js_check })} label={d.js_check ? 'On' : 'Off'} />
            </div>
          </div>
          <div className="field-help">{KIND_HELP[d.kind]}</div>
          {d.js_check && <div className="field-help">JS check: direct campaign URL only; adds one extra round trip; browsers that fail are re-routed as bots.</div>}
        </section>

        {/* ---- filters ---- */}
        <section className="se-section">
          <header className="se-section-head">
            <h4>Filters</h4>
            <Segmented
              small
              value={d.filter_op === 'or' ? 'or' : 'and'}
              onChange={(filter_op) => set({ filter_op })}
              options={[
                { value: 'and', label: 'AND', title: 'Every filter must match' },
                { value: 'or', label: 'OR', title: 'Any filter may match' },
              ]}
            />
            <span className="muted grow ellipsis">{d.filters.length === 0 ? 'No filters: matches every visitor.' : d.filter_op === 'or' ? 'Matches when any filter passes.' : 'Matches when all filters pass.'}</span>
            <PresetControls
              kind="filters"
              presets={streamPresets}
              canSave={d.filters.length > 0 && !d.filters.some((f) => filterError(f))}
              getData={() => ({ filter_op: d.filter_op, filters: cleanFilters(d.filters) })}
              onApply={applyFilterPreset}
              onChanged={onPresetsChanged}
            />
          </header>

          <div className="filters">
            {d.filters.map((f, i) => {
              const def = filterDefs.get(f.type)
              const err = tried ? filterError(f) : ''
              return (
                <div className={'filter-row' + (err ? ' invalid' : '')} key={i}>
                  <span className="filter-join">{i === 0 ? 'IF' : d.filter_op === 'or' ? 'OR' : 'AND'}</span>
                  <Select className="filter-type" value={f.type} options={filterOptions} onChange={(type) => setFilter(i, { type, values: [] })} />
                  <div className={'mode-pill ' + (f.mode === 'is_not' ? 'not' : 'is')}>
                    <button type="button" className={f.mode !== 'is_not' ? 'active' : ''} onClick={() => setFilter(i, { mode: 'is' })}>
                      IS
                    </button>
                    <button type="button" className={f.mode === 'is_not' ? 'active' : ''} onClick={() => setFilter(i, { mode: 'is_not' })}>
                      IS NOT
                    </button>
                  </div>
                  <div className="filter-value">
                    <FilterValue def={def} values={f.values} onChange={(values) => setFilter(i, { values })} presets={presets} />
                    {err ? <div className="field-error">{err}</div> : def?.help && def.input !== 'none' ? <div className="field-help">{def.help}</div> : null}
                  </div>
                  <button type="button" className="icon-btn danger" title="Remove filter" onClick={() => set({ filters: d.filters.filter((_, j) => j !== i) })}>
                    <X size={15} />
                  </button>
                </div>
              )
            })}
          </div>
          <AddFilter defs={meta.filters} onAdd={(type) => set({ filters: [...d.filters, { type, mode: 'is', values: [] }] })} />
        </section>

        {/* ---- action ---- */}
        <section className="se-section">
          <header className="se-section-head">
            <h4>Action</h4>
            <span className="muted grow ellipsis">{actionDef?.description ?? 'What the matched visitor gets.'}</span>
            <PresetControls
              kind="action"
              presets={streamPresets}
              canSave={!!actionDef && !(actionDef.fields ?? []).some((f) => fieldError(f))}
              getData={() => ({ action_type: d.action_type, action_config: cleanConfig(actionDef, d.action_config) })}
              onApply={applyActionPreset}
              onChanged={onPresetsChanged}
            />
          </header>
          <div className="action-cards">
            {meta.actions.map((a) => {
              const Icon = ACTION_ICONS[a.type] ?? CornerDownRight
              return (
                <button
                  type="button"
                  key={a.type}
                  className={'action-card' + (a.type === d.action_type ? ' active' : '')}
                  title={a.description}
                  onClick={() => {
                    if (a.type !== d.action_type) set({ action_type: a.type, action_config: a.type === initial.action_type ? { ...initial.action_config } : defaultConfig(a) })
                  }}
                >
                  <Icon size={17} />
                  <span>{a.label}</span>
                </button>
              )
            })}
          </div>
          {actionDef && (
            <ActionForm
              key={actionDef.type}
              def={actionDef}
              config={d.action_config}
              onChange={(action_config) => set({ action_config })}
              errorFor={(f) => (tried ? fieldError(f) : '')}
              whitepages={whitepages}
              campaigns={campaigns.filter((c) => c.id !== campaign.id)}
              refNames={refNames}
              macros={meta.macros}
            />
          )}
        </section>

        <section className="se-section">
          <Field label="Note">
            <input className="input" value={d.note} onChange={(e) => set({ note: e.target.value })} placeholder="Optional, for your own reference" />
          </Field>
        </section>
      </fieldset>
    </Drawer>
  )
}

// ---- presets -----------------------------------------------------------------

/** "Apply preset" (with rename/delete of own presets) and "Save as preset…" for one kind. */
export function PresetControls({
  kind,
  presets,
  canSave,
  getData,
  onApply,
  onChanged,
}: {
  kind: 'filters' | 'action'
  presets: StreamPreset[]
  canSave: boolean
  getData: () => StreamPreset['data']
  onApply: (p: StreamPreset) => void
  onChanged: () => void
}) {
  const list = presets.filter((p) => p.kind === kind)
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const act = async (fn: () => Promise<unknown>, ok: string): Promise<boolean> => {
    setBusy(true)
    try {
      await fn()
      toast.ok(ok)
      onChanged()
      return true
    } catch (e) {
      toast.err(e)
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="row gap-s preset-controls">
      <Dropdown align="right" className="btn small" label="Apply preset" title="Presets: built-in and your own">
        {(close) => (
          <div className="menu preset-menu">
            {list.length === 0 && <div className="muted pad-s">No presets yet. Set this section up and use “Save as preset”.</div>}
            {list.map((p, i) =>
              renaming && p.id === renaming.id ? (
                <form
                  key={p.id}
                  className="row gap-s pad-s"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    if (renaming.name.trim() && (await act(() => put(`stream-presets/${renaming.id}`, { name: renaming.name.trim() }), 'Preset renamed'))) setRenaming(null)
                  }}
                >
                  <input className="input input-sm grow" autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: renaming.id, name: e.target.value })} />
                  <button className="icon-btn" disabled={busy || !renaming.name.trim()} title="Save name">
                    <Check size={14} />
                  </button>
                  <button type="button" className="icon-btn" title="Cancel" onClick={() => setRenaming(null)}>
                    <X size={14} />
                  </button>
                </form>
              ) : (
                <div className="preset-row" key={p.id ?? 'b' + i}>
                  <button
                    type="button"
                    className="menu-item grow"
                    onClick={() => {
                      close()
                      onApply(p)
                    }}
                  >
                    <span className="grow ellipsis">{p.name}</span>
                    {p.builtin && <span className="badge neutral">built-in</span>}
                  </button>
                  {!p.builtin && p.id !== undefined && (
                    <>
                      <button type="button" className="icon-btn" title="Rename preset" onClick={() => setRenaming({ id: p.id as number, name: p.name })}>
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn danger"
                        title="Delete preset"
                        disabled={busy}
                        onClick={async () => {
                          if (await confirmDialog({ title: 'Delete preset?', message: <>Preset <b>{p.name}</b> will be deleted. Streams that used it keep their settings.</> })) act(() => del(`stream-presets/${p.id}`), 'Preset deleted')
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </>
                  )}
                </div>
              ),
            )}
          </div>
        )}
      </Dropdown>
      <Dropdown
        align="right"
        className="btn small"
        chevron={false}
        disabled={!canSave}
        title={canSave ? 'Save the current setup as a reusable preset' : 'Complete this section first'}
        label={
          <>
            <BookmarkPlus size={14} /> Save as preset…
          </>
        }
      >
        {(close) => (
          <form
            className="pad-s preset-save"
            onSubmit={async (e) => {
              e.preventDefault()
              if (!name.trim()) return
              if (await act(() => post('stream-presets', { name: name.trim(), kind, data: getData() }), `Preset “${name.trim()}” saved`)) {
                setName('')
                close()
              }
            }}
          >
            <div className="field-label">Preset name</div>
            <div className="row gap-s">
              <input className="input input-sm grow" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'filters' ? 'e.g. Tier-1 mobile' : 'e.g. Main whitepage'} />
              <button className="btn small primary" disabled={busy || !name.trim()}>
                Save
              </button>
            </div>
          </form>
        )}
      </Dropdown>
    </div>
  )
}

// ---- filters -----------------------------------------------------------------

function AddFilter({ defs, onAdd }: { defs: FilterDef[]; onAdd: (type: string) => void }) {
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const s = q.trim().toLowerCase()
    const out: { group: string; items: FilterDef[] }[] = []
    for (const f of defs) {
      if (s && !f.label.toLowerCase().includes(s) && !f.type.includes(s) && !f.group.toLowerCase().includes(s)) continue
      let g = out.find((x) => x.group === f.group)
      if (!g) out.push((g = { group: f.group, items: [] }))
      g.items.push(f)
    }
    return out
  }, [defs, q])
  const first = groups[0]?.items[0]
  return (
    <Dropdown
      className="btn small add-filter"
      chevron={false}
      label={
        <>
          <Plus size={14} /> Add filter
        </>
      }
    >
      {(close) => (
        <div className="filter-menu">
          <div className="search">
            <Search size={14} />
            <input
              className="input"
              autoFocus
              placeholder="Search filters…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && first) {
                  e.preventDefault()
                  onAdd(first.type)
                  setQ('')
                  close()
                }
              }}
            />
          </div>
          <div className="filter-menu-list">
            {groups.length === 0 && <div className="muted pad-s">No filter matches “{q}”.</div>}
            {groups.map((g) => (
              <div key={g.group} className="filter-menu-group">
                <div className="menu-title">{g.group}</div>
                {g.items.map((f) => (
                  <MenuItem
                    key={f.type}
                    title={f.help}
                    onClick={() => {
                      onAdd(f.type)
                      setQ('')
                      close()
                    }}
                  >
                    {f.label}
                  </MenuItem>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </Dropdown>
  )
}

function FilterValue({ def, values, onChange, presets }: { def?: FilterDef; values: string[]; onChange: (v: string[]) => void; presets: GeoPreset[] }) {
  if (!def) return <Notice tone="warn">This filter type is not known to the server any more. Remove it.</Notice>
  switch (def.input) {
    case 'countries':
      return <CountrySelect values={values} onChange={onChange} presets={presets} />
    case 'select':
      return <MultiSelect values={values} onChange={onChange} options={(def.options ?? []).map((o) => ({ value: o, label: o }))} placeholder="Choose…" searchable={(def.options ?? []).length > 8} />
    case 'tags':
      return <Chips values={values} onChange={onChange} placeholder="Type a value and press Enter" />
    case 'lines':
      return <textarea className="input mono" rows={Math.min(8, Math.max(2, values.length + 1))} value={values.join('\n')} placeholder="One value per line" onChange={(e) => onChange(e.target.value === '' ? [] : e.target.value.split('\n'))} />
    default:
      return <div className="filter-flag">{def.help ?? 'No value needed'}</div>
  }
}

// ---- action form ---------------------------------------------------------------

type TextEl = HTMLInputElement | HTMLTextAreaElement

function ActionForm({
  def,
  config,
  onChange,
  errorFor,
  whitepages,
  campaigns,
  refNames,
  macros,
}: {
  def: ActionDef
  config: ActionConfig
  onChange: (c: ActionConfig) => void
  errorFor: (f: ActionField) => string
  whitepages: Whitepage[]
  campaigns: Campaign[]
  refNames?: RefNames
  macros: string[]
}) {
  const fields = def.fields ?? []
  const els = useRef<Record<string, TextEl | null>>({})
  const last = useRef<{ name: string; start: number; end: number } | null>(null)
  const textFields = fields.filter((f) => f.type === 'text' || f.type === 'textarea' || f.type === 'code')

  const setVal = (name: string, v: unknown) => onChange({ ...config, [name]: v })
  const track = (name: string) => (e: { currentTarget: TextEl }) => {
    last.current = { name, start: e.currentTarget.selectionStart ?? e.currentTarget.value.length, end: e.currentTarget.selectionEnd ?? e.currentTarget.value.length }
  }

  const insertMacro = (macro: string) => {
    const target = last.current && textFields.some((f) => f.name === last.current!.name) ? last.current : textFields[0] ? { name: textFields[0].name, start: -1, end: -1 } : null
    if (!target) return
    const cur = String(config[target.name] ?? '')
    const start = target.start < 0 ? cur.length : Math.min(target.start, cur.length)
    const end = target.end < 0 ? cur.length : Math.min(target.end, cur.length)
    const token = `{${macro}}`
    setVal(target.name, cur.slice(0, start) + token + cur.slice(end))
    const pos = start + token.length
    last.current = { name: target.name, start: pos, end: pos }
    requestAnimationFrame(() => {
      const el = els.current[target.name]
      if (el) {
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  const preview = async (id: number) => {
    try {
      const r = await get<{ url: string }>(`whitepages/${id}/preview-url`)
      window.open(r.url, '_blank', 'noopener')
    } catch (e) {
      toast.err(e)
    }
  }

  if (fields.length === 0) return <div className="muted">This action has no settings.</div>

  return (
    <div>
      <div className="form-grid">
        {fields.map((f) => {
          const v = config[f.name]
          const err = errorFor(f)
          const label = (
            <>
              {f.label}
              {f.required && <span className="req"> *</span>}
            </>
          )
          const textProps = {
            ref: (el: TextEl | null) => {
              els.current[f.name] = el
            },
            onFocus: track(f.name),
            onSelect: track(f.name),
            onKeyUp: track(f.name),
            onClick: track(f.name),
          }
          switch (f.type) {
            case 'bool':
              return (
                <Field key={f.name} help={f.help} error={err} className="span-2">
                  <Toggle checked={v === true} onChange={(b) => setVal(f.name, b)} label={f.label} />
                </Field>
              )
            case 'number':
              return (
                <Field key={f.name} label={label} help={f.help} error={err}>
                  <NumberInput value={typeof v === 'number' ? v : v === undefined || v === null || v === '' ? '' : Number(v) || 0} onChange={(n) => setVal(f.name, n)} />
                </Field>
              )
            case 'select':
              return (
                <Field key={f.name} label={label} help={f.help} error={err}>
                  <Select value={String(v ?? '')} onChange={(s) => setVal(f.name, s)} options={(f.options ?? []).map((o) => ({ value: o, label: o }))} />
                </Field>
              )
            case 'whitepage': {
              const own = whitepages.some((w) => w.id === Number(v))
              return (
                <Field
                  key={f.name}
                  label={label}
                  className="span-2"
                  error={err}
                  help={
                    whitepages.length === 0 && !v ? (
                      <>
                        No whitepages uploaded yet. <Link to="/whitepages">Upload one</Link> first.
                      </>
                    ) : (
                      f.help
                    )
                  }
                >
                  <div className="row gap-s">
                    <Select
                      className="grow"
                      value={v ? String(v) : ''}
                      placeholder="Choose a whitepage…"
                      onChange={(s) => setVal(f.name, s ? Number(s) : '')}
                      options={[
                        // A whitepage set by the campaign owner is not in a co-editor's own list; keep it selectable.
                        ...(v && !own ? [{ value: String(v), label: refNames?.whitepages[String(v)] ? `${refNames.whitepages[String(v)]} (owner's)` : `Whitepage #${v} (not available)` }] : []),
                        ...whitepages.map((w) => ({ value: String(w.id), label: `${w.name} (${w.kind}, ${w.file_count} files)` })),
                      ]}
                    />
                    {/* The fieldset may be disabled (read-only view); a link still works there. */}
                    {own && (
                      <a
                        className="btn"
                        href="#preview"
                        title="Open a sandboxed preview in a new tab"
                        onClick={(e) => {
                          e.preventDefault()
                          preview(Number(v))
                        }}
                      >
                        <Eye size={14} /> Preview
                      </a>
                    )}
                  </div>
                </Field>
              )
            }
            case 'campaign':
              return (
                <Field key={f.name} label={label} help={f.help} error={err} className="span-2">
                  <Select
                    value={v ? String(v) : ''}
                    placeholder="Choose a campaign…"
                    onChange={(s) => setVal(f.name, s ? Number(s) : '')}
                    options={[
                      ...(v && !campaigns.some((c) => c.id === Number(v)) ? [{ value: String(v), label: refNames?.campaigns[String(v)] ? `${refNames.campaigns[String(v)]} (owner's)` : `Campaign #${v} (not available)` }] : []),
                      ...campaigns.map((c) => ({ value: String(c.id), label: c.enabled ? c.name : `${c.name} (disabled)` })),
                    ]}
                  />
                </Field>
              )
            case 'textarea':
            case 'code':
              return (
                <Field key={f.name} label={label} help={f.help} error={err} className="span-2">
                  <textarea className={'input' + (f.type === 'code' ? ' mono code' : '')} rows={f.type === 'code' ? 8 : 3} spellCheck={false} value={String(v ?? '')} onChange={(e) => setVal(f.name, e.target.value)} {...textProps} />
                </Field>
              )
            default:
              return (
                <Field key={f.name} label={label} help={f.help} error={err} className="span-2">
                  <input className="input mono" spellCheck={false} value={String(v ?? '')} onChange={(e) => setVal(f.name, e.target.value)} {...textProps} />
                </Field>
              )
          }
        })}
      </div>
      {textFields.length > 0 && (
        <div className="macros">
          <div className="field-label">Macros — click to insert into the focused field</div>
          <div className="macro-chips">
            {macros.map((m) => (
              <button type="button" key={m} className="macro" onMouseDown={(e) => e.preventDefault()} onClick={() => insertMacro(m)}>
                {'{' + m + '}'}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
