import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
import { errMsg, post, put } from '../api'
import { useMeta } from '../hooks'
import type { ActionConfig, ActionDef, ActionField, Campaign, Filter, FilterDef, GeoPreset, Stream, Whitepage } from '../types'
import { Chips, Drawer, Dropdown, Field, MenuItem, MultiSelect, Notice, NumberInput, Segmented, Select, Toggle } from '../components/ui'
import { CountrySelect } from '../components/CountrySelect'

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

export function defaultConfig(def: ActionDef | undefined): ActionConfig {
  const cfg: ActionConfig = {}
  for (const f of def?.fields ?? []) {
    if (f.default !== undefined && f.default !== null) cfg[f.name] = f.default
    else if (f.type === 'bool') cfg[f.name] = false
  }
  return cfg
}

export function newDraft(campaignId: number, kind: string, actions: ActionDef[]): StreamDraft {
  // Bots usually go to a whitepage, everything else to an offer.
  const prefer = kind === 'forced' ? 'whitepage' : 'redirect'
  const def = actions.find((a) => a.type === prefer) ?? actions[0]
  return {
    campaign_id: campaignId,
    name: '',
    kind,
    weight: 100,
    enabled: true,
    js_check: false,
    filter_op: 'and',
    filters: kind === 'forced' ? [{ type: 'bot', mode: 'is', values: [] }] : [],
    action_type: def?.type ?? '',
    action_config: defaultConfig(def),
    note: '',
  }
}

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
    filters: (s.filters ?? []).map((f) => ({ type: f.type, mode: f.mode === 'is_not' ? 'is_not' : 'is', values: [...(f.values ?? [])] })),
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

export function streamBody(d: StreamDraft, actions: ActionDef[]) {
  return {
    campaign_id: d.campaign_id,
    name: d.name.trim(),
    kind: d.kind,
    weight: d.weight === '' ? 0 : d.weight,
    enabled: d.enabled,
    js_check: d.js_check,
    filter_op: d.filter_op,
    // Every filter is sent whole: the server decodes over the stored list.
    filters: d.filters.map((f) => ({ type: f.type, mode: f.mode, values: f.values.map((v) => v.trim()).filter(Boolean) })),
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
  readOnly?: boolean
  onClose: () => void
  onSaved: (s: Stream, created: boolean, kindChanged: boolean) => void
}

export default function StreamEditor({ draft: initial, campaign, campaigns, whitepages, presets, readOnly, onClose, onSaved }: Props) {
  const meta = useMeta()
  const [d, setD] = useState<StreamDraft>(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tried, setTried] = useState(false)
  const set = (patch: Partial<StreamDraft>) => setD((x) => ({ ...x, ...patch }))

  const filterDefs = useMemo(() => new Map(meta.filters.map((f) => [f.type, f])), [meta.filters])
  const actionDef = meta.actions.find((a) => a.type === d.action_type)

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
  const groups = useMemo(() => {
    const out: { group: string; items: FilterDef[] }[] = []
    for (const f of meta.filters) {
      let g = out.find((x) => x.group === f.group)
      if (!g) out.push((g = { group: f.group, items: [] }))
      g.items.push(f)
    }
    return out
  }, [meta.filters])

  return (
    <Drawer
      title={d.id ? `Stream: ${initial.name}${readOnly ? ' (read-only)' : ''}` : 'New stream'}
      onClose={onClose}
      size="xl"
      footer={
        readOnly ? (
          <button className="btn" onClick={onClose}>
            Close
          </button>
        ) : (
        <>
          {error && <div className="field-error grow">{error}</div>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : d.id ? 'Save stream' : 'Create stream'}
          </button>
        </>
        )
      }
    >
      <fieldset className="plain" disabled={readOnly}>
      <div className="form-section">
        <div className="form-grid">
          <Field label="Name" error={tried && !d.name.trim() ? 'Name is required' : ''} className="span-2">
            <input className="input" autoFocus={!d.id} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Bots → whitepage" />
          </Field>
          <Field label="Kind" help={KIND_HELP[d.kind]} className="span-2">
            <Segmented
              value={d.kind}
              onChange={(kind) => set({ kind })}
              options={[
                { value: 'forced', label: 'Forced' },
                { value: 'regular', label: 'Regular' },
                { value: 'default', label: 'Default' },
              ]}
            />
          </Field>
          <Field label="Weight" help={campaign.rotation === 'weight' ? 'Share of matching traffic among regular streams. 0 excludes the stream from the draw.' : 'Used only when the campaign rotation is “weight” (currently “position”).'}>
            <NumberInput value={d.weight} min={0} max={100000} onChange={(weight) => set({ weight })} />
          </Field>
          <Field label="Status">
            <Toggle checked={d.enabled} onChange={(enabled) => set({ enabled })} label={d.enabled ? 'Enabled' : 'Disabled'} />
          </Field>
          <Field
            className="span-2"
            label="JS check"
            help="Before the action runs, the visitor's browser must execute a small script and reload. Works on the direct campaign URL only (JS and PHP integrations skip it), adds one extra round trip, and browsers that fail it are re-routed as bots."
          >
            <Toggle checked={d.js_check} onChange={(js_check) => set({ js_check })} label="Verify the browser with JavaScript" />
          </Field>
        </div>
      </div>

      <div className="form-section">
        <div className="section-head">
          <h4>Filters</h4>
          {d.filters.length > 1 && (
            <Segmented
              small
              value={d.filter_op === 'or' ? 'or' : 'and'}
              onChange={(filter_op) => set({ filter_op })}
              options={[
                { value: 'and', label: 'AND', title: 'Every filter must match' },
                { value: 'or', label: 'OR', title: 'Any filter may match' },
              ]}
            />
          )}
          <span className="muted grow">{d.filters.length === 0 ? 'No filters: the stream matches every visitor.' : d.filter_op === 'or' ? 'Matches when any filter passes.' : 'Matches when all filters pass.'}</span>
        </div>

        <div className="filters">
          {d.filters.map((f, i) => {
            const def = filterDefs.get(f.type)
            const err = tried ? filterError(f) : ''
            return (
              <div className={'filter-row' + (err ? ' invalid' : '')} key={i}>
                {i > 0 && <div className="filter-op">{d.filter_op === 'or' ? 'OR' : 'AND'}</div>}
                <div className="filter-main">
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
                    {err ? <div className="field-error">{err}</div> : def?.help ? <div className="field-help">{def.help}</div> : null}
                  </div>
                  <button className="icon-btn danger" title="Remove filter" onClick={() => set({ filters: d.filters.filter((_, j) => j !== i) })}>
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        <Dropdown
          className="btn small"
          label={
            <>
              <Plus size={14} /> Add filter
            </>
          }
        >
          {(close) => (
            <div className="menu menu-cols">
              {groups.map((g) => (
                <div key={g.group}>
                  <div className="menu-title">{g.group}</div>
                  {g.items.map((f) => (
                    <MenuItem
                      key={f.type}
                      onClick={() => {
                        set({ filters: [...d.filters, { type: f.type, mode: 'is', values: [] }] })
                        close()
                      }}
                    >
                      {f.label}
                    </MenuItem>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Dropdown>
      </div>

      <div className="form-section">
        <div className="section-head">
          <h4>Action</h4>
          <span className="muted grow">What the matched visitor gets.</span>
        </div>
        <div className="action-types">
          {meta.actions.map((a) => (
            <button
              type="button"
              key={a.type}
              className={'action-type' + (a.type === d.action_type ? ' active' : '')}
              title={a.description}
              onClick={() => {
                if (a.type !== d.action_type) set({ action_type: a.type, action_config: a.type === initial.action_type ? { ...initial.action_config } : defaultConfig(a) })
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
        {actionDef && <div className="muted action-desc">{actionDef.description}</div>}
        {actionDef && (
          <ActionForm
            key={actionDef.type}
            def={actionDef}
            config={d.action_config}
            onChange={(action_config) => set({ action_config })}
            errorFor={(f) => (tried ? fieldError(f) : '')}
            whitepages={whitepages}
            campaigns={campaigns.filter((c) => c.id !== campaign.id)}
            macros={meta.macros}
          />
        )}
      </div>

      <div className="form-section">
        <Field label="Note">
          <input className="input" value={d.note} onChange={(e) => set({ note: e.target.value })} placeholder="Optional, for your own reference" />
        </Field>
      </div>
      </fieldset>
    </Drawer>
  )
}

const KIND_HELP: Record<string, string> = {
  forced: 'Checked before everything else, top to bottom; the first match wins. Use it for traffic that must never reach an offer, such as bots.',
  regular: 'The main streams: first match by position, or a weighted draw among the matches, depending on the campaign rotation.',
  default: 'The fallback when no forced or regular stream matched. Usually has no filters.',
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
      return <div className="filter-flag">true</div>
  }
}

type TextEl = HTMLInputElement | HTMLTextAreaElement

function ActionForm({
  def,
  config,
  onChange,
  errorFor,
  whitepages,
  campaigns,
  macros,
}: {
  def: ActionDef
  config: ActionConfig
  onChange: (c: ActionConfig) => void
  errorFor: (f: ActionField) => string
  whitepages: Whitepage[]
  campaigns: Campaign[]
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
            case 'whitepage':
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
                  <Select
                    value={v ? String(v) : ''}
                    placeholder="Choose a whitepage…"
                    onChange={(s) => setVal(f.name, s ? Number(s) : '')}
                    options={[
                      // A whitepage set by the campaign owner is not in a co-editor's own list; keep it selectable.
                      ...(v && !whitepages.some((w) => w.id === Number(v)) ? [{ value: String(v), label: `Whitepage #${v} (current, not in your list)` }] : []),
                      ...whitepages.map((w) => ({ value: String(w.id), label: `${w.name} (${w.kind}, ${w.file_count} files)` })),
                    ]}
                  />
                </Field>
              )
            case 'campaign':
              return (
                <Field key={f.name} label={label} help={f.help} error={err} className="span-2">
                  <Select
                    value={v ? String(v) : ''}
                    placeholder="Choose a campaign…"
                    onChange={(s) => setVal(f.name, s ? Number(s) : '')}
                    options={[
                      ...(v && !campaigns.some((c) => c.id === Number(v)) ? [{ value: String(v), label: `Campaign #${v} (current, not editable by you)` }] : []),
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
