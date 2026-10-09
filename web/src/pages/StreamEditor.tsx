import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Ban, BookmarkPlus, Braces, Check, ChevronRight, Code2, CornerDownRight, ExternalLink, Eye, FileCode2, FileText, Pencil, Plus, Search, Split, Trash2, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { del, errMsg, get, post, put } from '../api'
import { useMeta } from '../hooks'
import type { ActionConfig, ActionDef, ActionField, Campaign, Filter, FilterDef, GeoPreset, Stage, Stream, StreamPreset, Whitepage } from '../types'
import { Chips, Drawer, Dropdown, Field, MenuItem, MultiSelect, Notice, NumberInput, Segmented, Select, Toggle, confirmDialog, toast } from '../components/ui'
import { CountrySelect } from '../components/CountrySelect'
import { CodeEditor, languageOf } from '../components/CodeEditor'
import type { CodeEditorHandle } from '../components/CodeEditor'
import { StageLinks } from './Stages'
import { t, tn, ts, tx } from '../i18n'

export const ACTION_ICONS: Record<string, LucideIcon> = {
  status: Ban,
  text: FileText,
  js: Braces,
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

/** Built-in presets come from the server in English; own presets are shown as the user named them. */
export const presetName = (p: StreamPreset) => (p.builtin ? ts(p.name) : p.name)

const cloneFilters = (fs: Filter[] | null | undefined): Filter[] => (fs ?? []).map((f) => ({ type: f.type, mode: f.mode === 'is_not' ? 'is_not' : 'is', values: [...(f.values ?? [])], ...(f.bypass ? { bypass: true } : {}) }))

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

const cleanFilters = (fs: Filter[]) => fs.map((f) => ({ type: f.type, mode: f.mode, values: f.values.map((v) => v.trim()).filter(Boolean), ...(f.bypass ? { bypass: true } : {}) }))

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
  /** The tracker domain shown in conversion URLs. */
  domain: string
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
  forced: t('Checked before everything else, top to bottom; the first match wins. For traffic that must never reach an offer.'),
  regular: t('The main streams: first match by position, or a weighted draw among the matches, depending on the campaign rotation.'),
  default: t('The fallback when no intercepting or regular stream matched. Usually has no filters.'),
}

export default function StreamEditor({ draft: initial, campaign, campaigns, whitepages, presets, domain, streamPresets, onPresetsChanged, readOnly, refNames, onClose, onSaved }: Props) {
  const meta = useMeta()
  const [d, setD] = useState<StreamDraft>(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tried, setTried] = useState(false)
  // Reference material rather than settings: folded until asked for.
  const [stagesOpen, setStagesOpen] = useState(false)
  const set = (patch: Partial<StreamDraft>) => setD((x) => ({ ...x, ...patch }))

  const filterDefs = useMemo(() => new Map(meta.filters.map((f) => [f.type, f])), [meta.filters])
  const actionDef = meta.actions.find((a) => a.type === d.action_type)
  const baseline = useMemo(() => JSON.stringify(streamBody(initial, meta.actions)), [initial, meta.actions])
  const dirty = !readOnly && JSON.stringify(streamBody(d, meta.actions)) !== baseline

  const filterError = (f: Filter): string => {
    const def = filterDefs.get(f.type)
    if (!def) return t('Unknown filter type')
    if (def.input !== 'none' && f.values.filter((v) => v.trim()).length === 0) return t('Add at least one value')
    return ''
  }
  const fieldError = (f: ActionField): string => {
    if (!f.required) return ''
    const v = d.action_config[f.name]
    return v === undefined || v === null || v === '' || v === 0 ? t('Required') : ''
  }
  const invalid = !d.name.trim() || d.filters.some((f) => filterError(f)) || (actionDef?.fields ?? []).some((f) => fieldError(f))

  const close = async () => {
    if (dirty && !(await confirmDialog({ title: t('Discard unsaved changes?'), confirmLabel: t('Discard'), message: t('The changes you made to this stream have not been saved.') }))) return
    onClose()
  }

  const save = async () => {
    setTried(true)
    if (invalid) {
      setError(t('Fix the highlighted fields first.'))
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
  const filterOptions = meta.filters.map((f) => ({ value: f.type, label: ts(f.label), group: ts(f.group) }))

  const applyFilterPreset = async (p: StreamPreset) => {
    if (d.filters.length > 0 && !(await confirmDialog({ title: t('Replace the current filters?'), danger: false, confirmLabel: t('Replace'), message: tx('Preset <b>{name}</b> will replace the filters of this stream ({count}).', { b: (c) => <b>{c}</b>, name: presetName(p), count: tn(d.filters.length, '{n} filter', '{n} filters') }) }))) return
    set({ filters: cloneFilters(p.data.filters), filter_op: p.data.filter_op === 'or' ? 'or' : 'and' })
  }
  const applyActionPreset = (p: StreamPreset) => {
    const def = meta.actions.find((a) => a.type === p.data.action_type)
    if (!def) return toast.err(t('Preset “{name}” uses an action this server does not have', { name: presetName(p) }))
    set({ action_type: def.type, action_config: { ...defaultConfig(def), ...(p.data.action_config ?? {}) } })
  }

  const showWeight = d.kind === 'regular'
  const stages = campaign.stages ?? []
  // Set by the action form while it has a text field a macro can go into.
  const insertMacro = useRef<((macro: string) => void) | null>(null)
  const hasText = (actionDef?.fields ?? []).some((f) => f.type === 'text' || f.type === 'textarea' || f.type === 'code')

  return (
    <Drawer
      title={
        <>
          {d.id ? (readOnly ? t('Stream') : t('Edit stream')) : t('New stream')}
          {readOnly && <span className="badge neutral">{t('read-only')}</span>}
          {dirty && <span className="badge warn">{t('unsaved')}</span>}
        </>
      }
      onClose={close}
      size="xl"
      footer={
        readOnly ? (
          <button className="btn" onClick={onClose}>
            {t('Close')}
          </button>
        ) : (
          <>
            {error && <div className="field-error grow">{error}</div>}
            <button className="btn" onClick={close}>
              {t('Cancel')}
            </button>
            <button className="btn primary" disabled={busy || (!!d.id && !dirty)} onClick={save}>
              {busy ? t('Saving…') : d.id ? t('Save stream') : t('Create stream')}
            </button>
          </>
        )
      }
    >
      <fieldset className="plain se" disabled={readOnly}>
        {/* ---- header ---- */}
        <section className="se-head">
          <div className="se-top">
            <div className="se-name">
              <input className={'input input-lg' + (tried && !d.name.trim() ? ' invalid' : '')} autoFocus={!d.id} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder={t('Stream name, e.g. DE mobile → offer A')} aria-label={t('Stream name')} />
              {tried && !d.name.trim() && <div className="field-error">{t('Name is required')}</div>}
            </div>
            <Segmented
              className="kinds"
              value={d.kind}
              onChange={(kind) => set({ kind })}
              options={[
                { value: 'forced', label: t('Intercepting'), title: KIND_HELP.forced },
                { value: 'regular', label: t('Regular'), title: KIND_HELP.regular },
                { value: 'default', label: t('Default'), title: KIND_HELP.default },
              ]}
            />
          </div>
          <div className="se-opts">
            <Toggle checked={d.enabled} onChange={(enabled) => set({ enabled })} label={t('Enabled')} />
            <Toggle
              checked={d.js_check}
              onChange={(js_check) => set({ js_check })}
              label={t('JS check')}
              title={t("Before the action runs, the visitor's browser must execute a small script and reload. Works on the direct campaign URL only (JS and PHP integrations skip it), adds one extra round trip, and browsers that fail it are re-routed as bots.")}
            />
            {showWeight && (
              <label className="se-opt" title={campaign.rotation === 'weight' ? t('Share of matching traffic among regular streams. 0 excludes the stream from the draw.') : t('Used only when the campaign rotation is “weight” (currently “position”).')}>
                <span>{campaign.rotation === 'weight' ? t('Weight') : t('Weight (unused)')}</span>
                <NumberInput className="input-sm w-80" value={d.weight} min={0} max={100000} onChange={(weight) => set({ weight })} />
              </label>
            )}
          </div>
          <div className="se-hint">
            {KIND_HELP[d.kind]}
            {d.js_check && ' ' + t('JS check: direct campaign URL only; one extra round trip; browsers that fail are re-routed as bots.')}
          </div>
        </section>

        {/* ---- filters ---- */}
        <section className="se-section">
          <header className="se-section-head">
            <h4>{t('Filters')}</h4>
            <Segmented
              small
              className="ops"
              value={d.filter_op === 'or' ? 'or' : 'and'}
              onChange={(filter_op) => set({ filter_op })}
              options={[
                { value: 'and', label: t('AND'), title: t('Every filter must match') },
                { value: 'or', label: t('OR'), title: t('Any filter may match') },
              ]}
            />
            <span className="muted grow ellipsis">
              {d.filters.length === 0
                ? t('No filters: matches every visitor.')
                : d.filters.every((f) => f.bypass)
                  ? t('Every filter is bypassed: matches every visitor.')
                  : d.filter_op === 'or'
                    ? t('Matches when any filter passes.')
                    : t('Matches when all filters pass.')}
            </span>
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
                <div className={'filter-row' + (err ? ' invalid' : '') + (f.bypass ? ' bypass' : '')} key={i}>
                  <span className={'filter-join' + (i === 0 ? '' : d.filter_op === 'or' ? ' or' : ' and')}>{i === 0 ? t('IF') : d.filter_op === 'or' ? t('OR') : t('AND')}</span>
                  <Select className="filter-type" value={f.type} options={filterOptions} onChange={(type) => setFilter(i, { type, values: [] })} />
                  <div className={'mode-pill ' + (f.mode === 'is_not' ? 'not' : 'is')}>
                    <button type="button" className={f.mode !== 'is_not' ? 'active' : ''} onClick={() => setFilter(i, { mode: 'is' })}>
                      {t('IS')}
                    </button>
                    <button type="button" className={f.mode === 'is_not' ? 'active' : ''} onClick={() => setFilter(i, { mode: 'is_not' })}>
                      {t('IS NOT')}
                    </button>
                  </div>
                  <div className="filter-value">
                    <FilterValue def={def} values={f.values} onChange={(values) => setFilter(i, { values })} presets={presets} />
                    {err ? <div className="field-error">{err}</div> : def?.help && def.input !== 'none' ? <div className="field-help">{ts(def.help)}</div> : null}
                  </div>
                  <button
                    type="button"
                    className={'icon-btn filter-bypass' + (f.bypass ? ' active' : '')}
                    aria-pressed={!!f.bypass}
                    title={f.bypass ? t('Bypassed: this filter is ignored. Click to apply it again.') : t('Bypass: keep this filter but ignore it when matching')}
                    onClick={() => setFilter(i, { bypass: !f.bypass })}
                  >
                    {/* One drawing instead of two icons, so the knob can slide between the states. */}
                    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect className="track" x={2} y={6} width={20} height={12} rx={6} />
                      <circle className="knob" cx={16} cy={12} r={2} />
                    </svg>
                  </button>
                  <button type="button" className="icon-btn danger" title={t('Remove filter')} onClick={() => set({ filters: d.filters.filter((_, j) => j !== i) })}>
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
            <h4>{t('Action')}</h4>
            <span className="muted grow ellipsis">{actionDef?.description ? ts(actionDef.description) : t('What the matched visitor gets.')}</span>
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
                  title={ts(a.description)}
                  onClick={() => {
                    if (a.type !== d.action_type) set({ action_type: a.type, action_config: a.type === initial.action_type ? { ...initial.action_config } : defaultConfig(a) })
                  }}
                >
                  <Icon size={17} />
                  <span>{ts(a.label)}</span>
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
              stages={stages}
              insertRef={insertMacro}
              readOnly={readOnly}
            />
          )}
        </section>

        {/* ---- conversions ---- */}
        {/* <details>, not a button: it must still open inside the disabled (read-only) fieldset. */}
        <details className="se-section se-fold" open={stagesOpen} onToggle={(e) => setStagesOpen(e.currentTarget.open)}>
          <summary className="se-section-head">
            <ChevronRight size={16} className="se-fold-icon" />
            <h4>{stages.length > 0 ? t('Funnel stages') : t('Conversions')}</h4>
            {stages.length > 0 && <span className="count">{stages.length}</span>}
            <span className="muted grow ellipsis">{stages.length > 0 ? t('Ready-to-use URLs for every stage of this campaign’s funnel.') : t('The postback URL that reports a conversion for clicks of this campaign.')}</span>
          </summary>
          {stagesOpen && <StageLinks stages={stages} domain={domain} onInsert={hasText && !readOnly ? (m) => insertMacro.current?.(m) : undefined} />}
        </details>

        <section className="se-section">
          <Field label={t('Note')}>
            <input className="input" value={d.note} onChange={(e) => set({ note: e.target.value })} placeholder={t('Optional, for your own reference')} />
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
      <Dropdown align="right" className="btn small ghost" label={t('Apply preset')} title={t('Presets: built-in and your own')}>
        {(close) => (
          <div className="menu preset-menu">
            {list.length === 0 && <div className="muted pad-s">{t('No presets yet. Set this section up and use “Save as preset”.')}</div>}
            {list.map((p, i) =>
              renaming && p.id === renaming.id ? (
                <form
                  key={p.id}
                  className="row gap-s pad-s"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    if (renaming.name.trim() && (await act(() => put(`stream-presets/${renaming.id}`, { name: renaming.name.trim() }), t('Preset renamed')))) setRenaming(null)
                  }}
                >
                  <input className="input input-sm grow" autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: renaming.id, name: e.target.value })} />
                  <button className="icon-btn" disabled={busy || !renaming.name.trim()} title={t('Save name')}>
                    <Check size={14} />
                  </button>
                  <button type="button" className="icon-btn" title={t('Cancel')} onClick={() => setRenaming(null)}>
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
                    <span className="grow ellipsis">{presetName(p)}</span>
                    {p.builtin && <span className="badge neutral">{t('built-in')}</span>}
                  </button>
                  {!p.builtin && p.id !== undefined && (
                    <>
                      <button type="button" className="icon-btn" title={t('Rename preset')} onClick={() => setRenaming({ id: p.id as number, name: p.name })}>
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn danger"
                        title={t('Delete preset')}
                        disabled={busy}
                        onClick={async () => {
                          if (await confirmDialog({ title: t('Delete preset?'), message: tx('Preset <b>{name}</b> will be deleted. Streams that used it keep their settings.', { b: (c) => <b>{c}</b>, name: p.name }) })) act(() => del(`stream-presets/${p.id}`), t('Preset deleted'))
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
        className="btn small ghost"
        chevron={false}
        disabled={!canSave}
        title={canSave ? t('Save the current setup as a reusable preset') : t('Complete this section first')}
        label={
          <>
            <BookmarkPlus size={14} /> {t('Save as preset…')}
          </>
        }
      >
        {(close) => (
          <form
            className="pad-s preset-save"
            onSubmit={async (e) => {
              e.preventDefault()
              if (!name.trim()) return
              if (await act(() => post('stream-presets', { name: name.trim(), kind, data: getData() }), t('Preset “{name}” saved', { name: name.trim() }))) {
                setName('')
                close()
              }
            }}
          >
            <div className="field-label">{t('Preset name')}</div>
            <div className="row gap-s">
              <input className="input input-sm grow" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'filters' ? t('e.g. Tier-1 mobile') : t('e.g. Main whitepage')} />
              <button className="btn small primary" disabled={busy || !name.trim()}>
                {t('Save')}
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
      // The search works in both the server's English and the language on screen.
      if (s && ![f.label, ts(f.label), f.type, f.group, ts(f.group)].some((x) => x.toLowerCase().includes(s))) continue
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
          <Plus size={14} /> {t('Add filter')}
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
              placeholder={t('Search filters…')}
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
            {groups.length === 0 && <div className="muted pad-s">{t('No filter matches “{q}”.', { q })}</div>}
            {groups.map((g) => (
              <div key={g.group} className="filter-menu-group">
                <div className="menu-title">{ts(g.group)}</div>
                {g.items.map((f) => (
                  <MenuItem
                    key={f.type}
                    title={ts(f.help)}
                    onClick={() => {
                      onAdd(f.type)
                      setQ('')
                      close()
                    }}
                  >
                    {ts(f.label)}
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
  if (!def) return <Notice tone="warn">{t('This filter type is not known to the server any more. Remove it.')}</Notice>
  switch (def.input) {
    case 'countries':
      return <CountrySelect values={values} onChange={onChange} presets={presets} />
    case 'select':
      return <MultiSelect values={values} onChange={onChange} options={(def.options ?? []).map((o) => ({ value: o, label: o }))} placeholder={t('Choose…')} searchable={(def.options ?? []).length > 8} />
    case 'tags':
      return <Chips values={values} onChange={onChange} placeholder={t('Type a value and press Enter')} />
    case 'lines':
      return <textarea className="input mono" rows={Math.min(8, Math.max(2, values.length + 1))} value={values.join('\n')} placeholder={t('One value per line')} onChange={(e) => onChange(e.target.value === '' ? [] : e.target.value.split('\n'))} />
    default:
      return <div className="filter-flag">{def.help ? ts(def.help) : t('No value needed')}</div>
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
  stages,
  insertRef,
  readOnly,
}: {
  def: ActionDef
  config: ActionConfig
  onChange: (c: ActionConfig) => void
  errorFor: (f: ActionField) => string
  whitepages: Whitepage[]
  campaigns: Campaign[]
  refNames?: RefNames
  macros: string[]
  /** The campaign funnel: its browser stages become {event:…} macros. */
  stages: Stage[]
  insertRef: { current: ((macro: string) => void) | null }
  readOnly?: boolean
}) {
  const fields = def.fields ?? []
  const els = useRef<Record<string, TextEl | null>>({})
  // Code fields are editors of their own: they insert at their cursor themselves.
  const editors = useRef<Record<string, { current: CodeEditorHandle | null }>>({})
  const editor = (name: string) => (editors.current[name] ??= { current: null })
  const last = useRef<{ name: string; start: number; end: number } | null>(null)
  const textFields = fields.filter((f) => f.type === 'text' || f.type === 'textarea' || f.type === 'code')

  const setVal = (name: string, v: unknown) => onChange({ ...config, [name]: v })
  const track = (name: string) => (e: { currentTarget: TextEl }) => {
    last.current = { name, start: e.currentTarget.selectionStart ?? e.currentTarget.value.length, end: e.currentTarget.selectionEnd ?? e.currentTarget.value.length }
  }

  const insertMacro = (macro: string) => {
    const target = last.current && textFields.some((f) => f.name === last.current!.name) ? last.current : textFields[0] ? { name: textFields[0].name, start: -1, end: -1 } : null
    if (!target) return
    const token = `{${macro}}`
    const ed = editors.current[target.name]?.current
    if (ed) return ed.insert(token)
    const cur = String(config[target.name] ?? '')
    const start = target.start < 0 ? cur.length : Math.min(target.start, cur.length)
    const end = target.end < 0 ? cur.length : Math.min(target.end, cur.length)
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

  insertRef.current = textFields.length > 0 ? insertMacro : null
  // "event:STAGE" stands for one macro per browser stage of this campaign.
  const browserStages = stages.filter((st) => st.public)
  const macroList = macros.filter((m) => m !== 'event:STAGE')

  const preview = async (id: number) => {
    try {
      const r = await get<{ url: string }>(`whitepages/${id}/preview-url`)
      window.open(r.url, '_blank', 'noopener')
    } catch (e) {
      toast.err(e)
    }
  }

  if (fields.length === 0) return <div className="action-panel muted">{t('This action has no settings.')}</div>

  return (
    <div className="action-panel">
      <div className="form-grid">
        {fields.map((f) => {
          const v = config[f.name]
          const err = errorFor(f)
          const help = ts(f.help)
          const label = (
            <>
              {ts(f.label)}
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
                <Field key={f.name} help={help} error={err} className="span-2">
                  <Toggle checked={v === true} onChange={(b) => setVal(f.name, b)} label={ts(f.label)} />
                </Field>
              )
            case 'number':
              return (
                <Field key={f.name} label={label} help={help} error={err}>
                  <NumberInput value={typeof v === 'number' ? v : v === undefined || v === null || v === '' ? '' : Number(v) || 0} onChange={(n) => setVal(f.name, n)} />
                </Field>
              )
            case 'select':
              return (
                <Field key={f.name} label={label} help={help} error={err}>
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
                      tx('No whitepages uploaded yet. <a>Upload one</a> first.', { a: (c) => <Link to="/whitepages">{c}</Link> })
                    ) : (
                      help
                    )
                  }
                >
                  <div className="row gap-s">
                    <Select
                      className="grow"
                      value={v ? String(v) : ''}
                      placeholder={t('Choose a whitepage…')}
                      onChange={(s) => setVal(f.name, s ? Number(s) : '')}
                      options={[
                        // A whitepage set by the campaign owner is not in a co-editor's own list; keep it selectable.
                        ...(v && !own ? [{ value: String(v), label: refNames?.whitepages[String(v)] ? t("{name} (owner's)", { name: refNames.whitepages[String(v)] }) : t('Whitepage #{id} (not available)', { id: String(v) }) }] : []),
                        ...whitepages.map((w) => ({ value: String(w.id), label: `${w.name} (${w.kind}, ${tn(w.file_count, '{n} file', '{n} files')})` })),
                      ]}
                    />
                    {/* The fieldset may be disabled (read-only view); a link still works there. */}
                    {own && (
                      <a
                        className="btn"
                        href="#preview"
                        title={t('Open a sandboxed preview in a new tab')}
                        onClick={(e) => {
                          e.preventDefault()
                          preview(Number(v))
                        }}
                      >
                        <Eye size={14} /> {t('Preview')}
                      </a>
                    )}
                  </div>
                </Field>
              )
            }
            case 'campaign':
              return (
                <Field key={f.name} label={label} help={help} error={err} className="span-2">
                  <Select
                    value={v ? String(v) : ''}
                    placeholder={t('Choose a campaign…')}
                    onChange={(s) => setVal(f.name, s ? Number(s) : '')}
                    options={[
                      ...(v && !campaigns.some((c) => c.id === Number(v)) ? [{ value: String(v), label: refNames?.campaigns[String(v)] ? t("{name} (owner's)", { name: refNames.campaigns[String(v)] }) : t('Campaign #{id} (not available)', { id: String(v) }) }] : []),
                      ...campaigns.map((c) => ({ value: String(c.id), label: c.enabled ? c.name : t('{name} (disabled)', { name: c.name }) })),
                    ]}
                  />
                </Field>
              )
            case 'code':
              return (
                <Field key={f.name} label={label} help={help} error={err} className="span-2">
                  <CodeEditor
                    value={String(v ?? '')}
                    onChange={(code) => setVal(f.name, code)}
                    language={f.lang ?? languageOf(config.content_type)}
                    readOnly={readOnly}
                    macros={[...macroList.filter((m) => !m.includes(':')), ...browserStages.map((st) => 'event:' + st.key)]}
                    minHeight={f.required ? 260 : 120}
                    invalid={!!err}
                    handle={editor(f.name)}
                    ariaLabel={ts(f.label)}
                    onFocus={() => (last.current = { name: f.name, start: -1, end: -1 })}
                  />
                </Field>
              )
            case 'textarea':
              return (
                <Field key={f.name} label={label} help={help} error={err} className="span-2">
                  <textarea className="input" rows={3} spellCheck={false} value={String(v ?? '')} onChange={(e) => setVal(f.name, e.target.value)} {...textProps} />
                </Field>
              )
            default:
              return (
                <Field key={f.name} label={label} help={help} error={err} className="span-2">
                  <input className="input mono" spellCheck={false} value={String(v ?? '')} onChange={(e) => setVal(f.name, e.target.value)} {...textProps} />
                </Field>
              )
          }
        })}
      </div>
      {textFields.length > 0 && (
        <div className="macros">
          <div className="field-label">{t('Macros — click to insert into the focused field')}</div>
          <div className="macro-chips">
            {macroList.map((m) => (
              <button type="button" key={m} className="macro" onMouseDown={(e) => e.preventDefault()} onClick={() => insertMacro(m)}>
                {'{' + m + '}'}
              </button>
            ))}
            {browserStages.map((st) => (
              <button type="button" key={st.key} className="macro dyn" title={t('Funnel stage “{name}”: the URL the page requests to report it for this click', { name: st.name })} onMouseDown={(e) => e.preventDefault()} onClick={() => insertMacro('event:' + st.key)}>
                {'{event:' + st.key + '}'}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
