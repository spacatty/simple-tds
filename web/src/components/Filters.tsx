// The filter panel shared by the reports and the logs. Pages pick fields from
// one catalogue: the few they pin stay on the first row, the rest unfold in
// sections, and whatever is in force is listed underneath. Everything is read
// from and written to the URL (see ../filters).
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search, SlidersHorizontal, TextSearch, X } from 'lucide-react'
import { errMsg, get } from '../api'
import type { Params } from '../api'
import { useDebounced } from '../hooks'
import type { Campaign, ConvKey, Stream } from '../types'
import { PLAIN_PARAMS, dimLabel, parseFilters, urlFilterParams, valueText } from '../filters'
import { fmtInt } from '../format'
import { t } from '../i18n'
import { dimIcon } from './icons'
import { FilterField, Segmented, Select, useFloating, useOutside } from './ui'

export type SectionId = 'routing' | 'geo' | 'device' | 'source' | 'quality' | 'conv'

const SECTIONS: [SectionId, string][] = [
  ['routing', t('Routing')],
  ['geo', t('Geo')],
  ['device', t('Device')],
  ['source', t('Source')],
  ['quality', t('Quality')],
  ['conv', t('Conversions')],
]

interface FieldDef {
  label: string
  section: SectionId
  kind: 'campaign' | 'stream' | 'key' | 'values' | 'text' | 'bots' | 'flag'
  /** The URL parameter the field writes. */
  param: string
  /** values: the dimension whose values are offered. */
  dim?: string
  /** values: the parameter of the "contains" filter the typed text can become. */
  like?: string
  /** values: a short list whose names differ from its values, searched in the browser. */
  local?: boolean
  placeholder?: string
  mono?: boolean
  size?: 'sm' | 'md' | 'lg' | 'auto'
  /** flag: what "only" and "exclude" are called. */
  only?: string
  exclude?: string
}

const values = (dim: string, section: SectionId, extra: Partial<FieldDef> = {}): FieldDef => ({ label: dimLabel(dim), section, kind: 'values', param: 'f.' + dim, dim, ...extra })

const BOTS: Record<string, string> = { exclude: t('No bots'), only: t('Bots only') }

/** Every filter a page can offer, by id. */
const FIELDS: Record<string, FieldDef> = {
  campaign: { label: t('Campaign'), section: 'routing', kind: 'campaign', param: 'campaign_id' },
  stream: { label: t('Stream'), section: 'routing', kind: 'stream', param: 'stream_id' },
  domain: values('domain', 'routing'),
  action: values('action', 'routing', { local: true }),
  country: values('country', 'geo', { local: true }),
  region: values('region', 'geo', { like: 'like.region' }),
  city: values('city', 'geo', { like: 'like.city' }),
  isp: values('isp', 'geo', { like: 'like.isp' }),
  lang: values('lang', 'geo'),
  device_type: values('device_type', 'device', { label: t('Device'), local: true }),
  os: values('os', 'device'),
  browser: values('browser', 'device'),
  ua: { label: 'User-Agent', section: 'device', kind: 'text', param: 'like.ua', placeholder: t('Contains…'), size: 'lg' },
  ref_domain: values('ref_domain', 'source', { label: t('Referrer'), like: 'like.referer' }),
  keyword: values('keyword', 'source', { like: 'like.keyword' }),
  sub1: values('sub1', 'source', { like: 'like.sub1' }),
  sub2: values('sub2', 'source', { like: 'like.sub2' }),
  sub3: values('sub3', 'source', { like: 'like.sub3' }),
  sub4: values('sub4', 'source', { like: 'like.sub4' }),
  sub5: values('sub5', 'source', { like: 'like.sub5' }),
  bots: { label: t('Traffic'), section: 'quality', kind: 'bots', param: 'bots', size: 'auto' },
  bot_reason: values('bot_reason', 'quality'),
  ip: { label: t('IP address'), section: 'quality', kind: 'text', param: 'ip', placeholder: t('Address, prefix or CIDR'), mono: true },
  unique: { label: t('Uniqueness'), section: 'quality', kind: 'flag', param: 'unique', size: 'sm', only: t('Unique only'), exclude: t('Repeat only') },
  dc: { label: t('Datacenter'), section: 'quality', kind: 'flag', param: 'dc', size: 'sm', only: t('Datacenter only'), exclude: t('No datacenters') },
  click_id: { label: t('Click ID'), section: 'quality', kind: 'text', param: 'click_id', placeholder: t('Exact match'), mono: true },
  key: { label: t('Key'), section: 'conv', kind: 'key', param: 'key_id' },
  sender_ip: { label: t('Sender IP'), section: 'conv', kind: 'text', param: 'ip', placeholder: t('Address, prefix or CIDR'), mono: true, size: 'sm' },
}

/** A catalogue field by its id, or a control of the page's own. */
export type FilterItem = string | { key: string; node: ReactNode; section?: SectionId }

/** A filter of the page's own that is in force, so the panel can list and reset it. */
export interface CustomFilter {
  key: string
  label: string
  text: string
  /** The URL parameters that carry it. */
  params: string[]
}

const LS_OPEN = 'tds_filters_open'
function loadOpen(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(LS_OPEN) ?? '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

interface PanelProps {
  /** Names the page: whether its extra filters are unfolded is remembered under it. */
  id: string
  sp: URLSearchParams
  update: (fn: (n: URLSearchParams) => void, replace?: boolean) => void
  /** The first row. */
  main: FilterItem[]
  /** What unfolds under "More filters", grouped by section. */
  more?: FilterItem[]
  /** The period (and whatever else the page narrows by) for the lists of values. */
  lookup: Params
  /** Where the values are counted: clicks unless the page shows conversions. */
  source?: 'clicks' | 'conversions'
  campaigns?: Campaign[]
  streams?: Stream[]
  keys?: ConvKey[]
  custom?: CustomFilter[]
  /** Parameters that only make sense within one campaign and go when it changes. */
  campaignDeps?: string[]
  /** Names for values the panel cannot name itself (a landing id, say). */
  names?: (dim: string, value: string) => string | undefined
}

interface Chip {
  key: string
  label: string
  text: string
  params: string[]
  mono?: boolean
  /** Its field is not on the first row. */
  hidden: boolean
}

export function FilterPanel({ id, sp, update, main, more = [], lookup, source = 'clicks', campaigns, streams, keys, custom = [], campaignDeps = [], names }: PanelProps) {
  const [open, setOpen] = useState(() => loadOpen()[id] ?? false)
  const toggle = () => {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(LS_OPEN, JSON.stringify({ ...loadOpen(), [id]: next }))
    } catch {
      /* private mode */
    }
  }

  const spKey = sp.toString()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const state = useMemo(() => parseFilters(sp), [spKey])
  const lookupKey = JSON.stringify(lookup)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scope = useMemo<Params>(() => ({ ...lookup, ...urlFilterParams(sp), source }), [lookupKey, spKey, source])

  const setParam = (param: string, v: string, replace = false) =>
    update((n) => {
      n.delete(param)
      if (v !== '') n.set(param, v)
    }, replace)
  const setValues = (param: string, vals: string[]) =>
    update((n) => {
      n.delete(param)
      vals.forEach((v) => n.append(param, v))
    })

  const campaignId = sp.get('campaign_id') ?? ''
  const campName = (v: string) => campaigns?.find((c) => String(c.id) === v)?.name ?? `#${v}`

  const defs = (items: FilterItem[]) => items.flatMap((it) => (typeof it === 'string' && FIELDS[it] ? [FIELDS[it]] : []))
  const pageDefs = [...defs(main), ...defs(more)]
  const mainParams = new Set(defs(main).flatMap((d) => (d.like ? [d.param, d.like] : [d.param])))
  const defFor = (param: string) => pageDefs.find((d) => d.param === param || d.like === param) ?? Object.values(FIELDS).find((d) => d.param === param || d.like === param)

  const field = (fid: string): ReactNode => {
    const d = FIELDS[fid]
    if (!d) return null
    const cur = sp.get(d.param) ?? ''
    switch (d.kind) {
      case 'campaign':
        return (
          <FilterField key={fid} label={d.label} active={!!cur}>
            <Select
              value={cur}
              onChange={(v) =>
                update((n) => {
                  // A stream, and a funnel stage, belong to one campaign.
                  for (const k of ['campaign_id', 'stream_id', ...campaignDeps]) n.delete(k)
                  if (v) n.set('campaign_id', v)
                })
              }
              placeholder={t('All campaigns')}
              options={(campaigns ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
            />
          </FilterField>
        )
      case 'stream':
        return (
          <FilterField key={fid} label={d.label} active={!!cur}>
            <Select
              value={cur}
              onChange={(v) => setParam(d.param, v)}
              placeholder={t('All streams')}
              options={(streams ?? []).filter((s) => !campaignId || String(s.campaign_id) === campaignId).map((s) => ({ value: String(s.id), label: campaignId ? s.name : `${s.name} · ${campName(String(s.campaign_id))}` }))}
            />
          </FilterField>
        )
      case 'key':
        return (
          <FilterField key={fid} label={d.label} active={!!cur}>
            <Select value={cur} onChange={(v) => setParam(d.param, v)} placeholder={t('All keys')} options={(keys ?? []).map((k) => ({ value: String(k.id), label: k.name }))} />
          </FilterField>
        )
      case 'values': {
        const vals = sp.getAll(d.param)
        const like = d.like ? (sp.get(d.like) ?? '') : ''
        const likeParam = d.like
        return (
          <FilterField key={fid} label={d.label} active={vals.length > 0 || !!like}>
            <ValuePicker
              dim={d.dim ?? fid}
              label={d.label}
              values={vals}
              like={like}
              local={d.local}
              lookup={scope}
              onChange={(v) => setValues(d.param, v)}
              onLike={likeParam ? (text) => setParam(likeParam, text) : undefined}
              onClear={() =>
                update((n) => {
                  n.delete(d.param)
                  if (likeParam) n.delete(likeParam)
                })
              }
              name={(v) => names?.(d.dim ?? fid, v) ?? valueText(d.dim ?? fid, v)}
            />
          </FilterField>
        )
      }
      case 'text':
        return (
          <FilterField key={fid} label={d.label} size={d.size} active={!!cur}>
            <TextFilter value={cur} onChange={(v) => setParam(d.param, v, true)} placeholder={d.placeholder} mono={d.mono} />
          </FilterField>
        )
      case 'bots':
        return (
          <FilterField key={fid} label={d.label} size="auto">
            <Segmented small className="bots" value={state.bots} onChange={(v) => setParam('bots', v)} options={[{ value: '', label: t('All') }, { value: 'exclude', label: BOTS.exclude }, { value: 'only', label: BOTS.only }]} />
          </FilterField>
        )
      case 'flag':
        return (
          <FilterField key={fid} label={d.label} size={d.size} active={cur === 'only' || cur === 'exclude'}>
            <Select
              value={cur}
              onChange={(v) => setParam(d.param, v)}
              placeholder={t('All')}
              options={[
                { value: 'only', label: d.only ?? '' },
                { value: 'exclude', label: d.exclude ?? '' },
              ]}
            />
          </FilterField>
        )
    }
  }
  const render = (it: FilterItem): ReactNode => (typeof it === 'string' ? field(it) : <span key={it.key} style={{ display: 'contents' }}>{it.node}</span>)

  // ---- what is in force ----
  const idName = (dim: string, v: string) => {
    if (dim === 'campaign') return campName(v)
    if (dim === 'stream') return streams?.find((s) => String(s.id) === v)?.name ?? `#${v}`
    if (dim === 'key') return keys?.find((k) => String(k.id) === v)?.name ?? `#${v}`
    return undefined
  }
  const listed = (items: string[]) => (items.length > 3 ? `${items.slice(0, 3).join(', ')} +${items.length - 3}` : items.join(', '))
  const chips: Chip[] = []
  for (const c of state.crumbs) {
    const d = defFor(c.param)
    const label = d?.label ?? dimLabel(c.dim)
    chips.push({
      key: c.param,
      label: c.like ? t('{name} contains', { name: label }) : label,
      text: c.like ? c.values[0] : listed(c.values.map((v) => names?.(c.dim, v) ?? idName(c.dim, v) ?? valueText(c.dim, v))),
      params: [c.param],
      hidden: !mainParams.has(c.param),
    })
  }
  if (state.bots) chips.push({ key: 'bots', label: FIELDS.bots.label, text: BOTS[state.bots], params: ['bots'], hidden: !mainParams.has('bots') })
  for (const p of PLAIN_PARAMS) {
    const v = sp.get(p)
    if (!v) continue
    const d = defFor(p)
    chips.push({ key: p, label: d?.label ?? p, text: d?.kind === 'flag' ? ((v === 'only' ? d.only : v === 'exclude' ? d.exclude : v) ?? v) : v, params: [p], mono: d?.mono, hidden: !mainParams.has(p) })
  }
  sp.forEach((v, k) => {
    // Postback parameters of a conversion.
    if (k.startsWith('p.') && k.length > 2 && v !== '') chips.push({ key: k, label: k.slice(2), text: v, params: [k], mono: true, hidden: false })
  })
  for (const c of custom) chips.push({ ...c, hidden: false })
  const hiddenCount = chips.filter((c) => c.hidden).length

  const sections = SECTIONS.map(([sid, title]) => ({ sid, title, items: more.filter((it) => (typeof it === 'string' ? FIELDS[it]?.section : it.section) === sid) })).filter((s) => s.items.length > 0)

  return (
    <div className="filterbar">
      <div className="filterbar-fields">
        {main.map(render)}
        <div className="filterbar-actions">
          {sections.length > 0 && (
            <button type="button" className={'btn' + (open ? ' open' : '')} aria-expanded={open} onClick={toggle}>
              <SlidersHorizontal size={14} /> {t('More filters')}
              {hiddenCount > 0 && <span className="count-pill">{hiddenCount}</span>}
              <ChevronDown size={14} className={open ? 'flip' : ''} />
            </button>
          )}
          {chips.length > 0 && (
            <button type="button" className="btn ghost" onClick={() => update((n) => chips.forEach((c) => c.params.forEach((p) => n.delete(p))))}>
              <X size={14} /> {t('Reset filters')}
            </button>
          )}
        </div>
      </div>
      {open && sections.length > 0 && (
        <div className="filterbar-sections">
          {sections.map((s) => (
            <div className="fsec" key={s.sid} role="group" aria-label={s.title}>
              <div className="fsec-title">{s.title}</div>
              <div className="fsec-fields">{s.items.map(render)}</div>
            </div>
          ))}
        </div>
      )}
      {chips.length > 0 && (
        <nav className="filterbar-chips" aria-label={t('Active filters')}>
          <span className="muted">{t('Filtered by')}</span>
          {chips.map((c) => (
            <span className="crumb" key={c.key}>
              <span className={'muted' + (c.mono && c.key.startsWith('p.') ? ' mono' : '')}>{c.label}:</span> <b className={'ellipsis' + (c.mono ? ' mono' : '')} title={c.text}>{c.text}</b>
              <button type="button" aria-label={t('Remove filter {name}', { name: c.label })} title={t('Remove this filter')} onClick={() => update((n) => c.params.forEach((p) => n.delete(p)))}>
                <X size={12} />
              </button>
            </span>
          ))}
        </nav>
      )}
    </div>
  )
}

/** A typed filter: kept locally while typing and handed over once the user pauses. */
function TextFilter({ value, onChange, placeholder, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  const [text, setText] = useState(value)
  // The URL can change under the field (a reset, a link in a row); what is being typed is not overwritten by its own echo.
  useEffect(() => setText((cur) => (cur.trim() === value ? cur : value)), [value])
  const settled = useDebounced(text, 400)
  useEffect(() => {
    if (settled === text && settled.trim() !== value) onChange(settled.trim())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled])
  return <input className={'input' + (mono ? ' mono' : '')} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} />
}

interface ValueRow {
  value: string
  count: number
}

const REMOTE_LIMIT = 50
/** Dimensions whose values come with a flag or an icon: their rows keep a column for it. */
const ICON_DIMS = ['country', 'device_type', 'os', 'browser']

/**
 * Picks values of one dimension from those the selection really has, the most
 * frequent first. Typing narrows the list (the server also offers values that
 * only resemble the text, so a typo still finds its target), and where the
 * field allows it the text itself can become a "contains" filter.
 */
function ValuePicker({
  dim,
  label,
  values,
  like,
  local,
  lookup,
  onChange,
  onLike,
  onClear,
  name,
}: {
  dim: string
  label: string
  values: string[]
  like: string
  local?: boolean
  /** Everything else that narrows the selection: the list shows what is left to pick from. */
  lookup: Params
  onChange: (values: string[]) => void
  onLike?: (text: string) => void
  onClear: () => void
  name: (value: string) => string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  // Row under the keyboard cursor; -1 until an arrow key is pressed.
  const [active, setActive] = useState(-1)
  const [rows, setRows] = useState<ValueRow[]>()
  const [error, setError] = useState('')
  const btn = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  useOutside(btn, () => setOpen(false), open, panel)
  useFloating(btn, panel, open, 'left')

  const typed = q.trim()
  const search = useDebounced(local ? '' : typed, 250)
  const lookupKey = JSON.stringify(lookup)
  useEffect(() => {
    if (!open) return
    let stale = false
    get<{ rows: ValueRow[] | null }>('reports/values', { ...lookup, dim, search, limit: local ? 300 : REMOTE_LIMIT })
      .then((r) => {
        if (stale) return
        setRows(r.rows ?? [])
        setError('')
      })
      .catch((e) => {
        if (!stale) setError(errMsg(e))
      })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lookupKey, dim, search, local])
  useEffect(() => {
    if (open) return
    setQ('')
    setActive(-1)
  }, [open])

  const picked = useMemo(() => new Set(values), [values])
  const shown = useMemo(() => {
    let list = rows ?? []
    const s = typed.toLowerCase()
    if (local && s) list = list.filter((r) => name(r.value).toLowerCase().includes(s) || r.value.toLowerCase() === s)
    if (s) return list
    // What is picked stays in sight even when the selection no longer has it.
    const have = new Set(list.map((r) => r.value))
    return [...values.filter((v) => !have.has(v)).map((v) => ({ value: v, count: -1 })), ...list]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, typed, values, local])

  const likeRow = onLike && typed ? 1 : 0
  const total = likeRow + shown.length
  const flip = (v: string) => onChange(picked.has(v) ? values.filter((x) => x !== v) : [...values, v])
  const applyLike = () => {
    onLike?.(typed)
    setOpen(false)
    btn.current?.focus()
  }
  const move = (to: number) => {
    setActive(to)
    panel.current?.querySelectorAll('.menu-item')[to]?.scrollIntoView({ block: 'nearest' })
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (total) move(e.key === 'ArrowDown' ? (active + 1) % total : active <= 0 ? total - 1 : active - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // Without a row chosen, Enter takes the text as written where that is possible, the best match otherwise.
      const at = active >= 0 ? active : 0
      if (likeRow && at === 0) applyLike()
      else if (shown[at - likeRow] && (active >= 0 || typed)) flip(shown[at - likeRow].value)
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') {
        e.stopPropagation()
        e.preventDefault()
        btn.current?.focus()
      }
      setOpen(false)
    }
  }

  const more = values.length + (like ? 1 : 0) - 1
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={'input vp' + (open ? ' open' : '')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' || open) return
          e.preventDefault()
          setOpen(true)
        }}
      >
        {values.length > 0 ? (
          <span className="vp-text with-icon">
            {dimIcon(dim, values[0])}
            <span className="ellipsis">{name(values[0])}</span>
          </span>
        ) : like ? (
          <span className="vp-text ellipsis">{t('contains “{text}”', { text: like })}</span>
        ) : (
          <span className="vp-text vp-none">{t('Any')}</span>
        )}
        {more > 0 && <span className="count-pill">+{more}</span>}
      </button>
      {open &&
        createPortal(
          <div ref={panel} className="popover floating vp-pop">
            <div className="vp-search">
              <Search size={14} />
              <input
                autoFocus
                className="input"
                value={q}
                aria-label={label}
                placeholder={onLike ? t('Search, or type a part of it') : t('Search…')}
                onChange={(e) => {
                  setQ(e.target.value)
                  setActive(-1)
                }}
                onKeyDown={onKey}
              />
            </div>
            <div className="vp-list" role="listbox" aria-multiselectable="true" aria-label={label}>
              {likeRow > 0 && (
                <button type="button" tabIndex={-1} className={'menu-item vp-like' + (active === 0 ? ' active' : '')} onMouseDown={(e) => e.preventDefault()} onClick={applyLike} title={t('Keep everything whose {name} has this text in it', { name: label.toLowerCase() })}>
                  <span className="check">
                    <TextSearch size={14} />
                  </span>
                  <span className="grow ellipsis">{t('Contains “{text}”', { text: typed })}</span>
                  {/* i18n-ignore */}
                  <kbd>Enter</kbd>
                </button>
              )}
              {error && <div className="field-error pad-s">{error}</div>}
              {!rows && !error && <div className="muted pad-s">{t('Loading…')}</div>}
              {rows && shown.length === 0 && <div className="muted pad-s">{typed ? t('Nothing found') : t('No values in this selection')}</div>}
              {shown.map((r, i) => {
                const on = picked.has(r.value)
                const icon = dimIcon(dim, r.value)
                return (
                  // tabIndex -1: the list is driven from the search box, which keeps the focus.
                  <button type="button" tabIndex={-1} role="option" aria-selected={on} key={r.value} className={'menu-item' + (on ? ' selected' : '') + (i + likeRow === active ? ' active' : '')} onMouseDown={(e) => e.preventDefault()} onClick={() => flip(r.value)}>
                    <span className="check">{on && <Check size={14} />}</span>
                    {ICON_DIMS.includes(dim) && <span className="opt-prefix">{icon}</span>}
                    <span className={'grow ellipsis' + (r.value === '' ? ' muted' : '')} title={name(r.value)}>
                      {name(r.value)}
                    </span>
                    {r.count >= 0 && <span className="muted tnum">{fmtInt(r.count)}</span>}
                  </button>
                )
              })}
            </div>
            <div className="vp-foot">
              <span className="muted">
                {!local && !typed && rows && rows.length >= REMOTE_LIMIT ? t('The {n} most frequent — type to find others', { n: REMOTE_LIMIT }) : values.length > 0 ? t('{n} selected', { n: values.length }) : ''}
              </span>
              <button type="button" className="btn small ghost" disabled={values.length === 0 && !like} onClick={onClear}>
                {t('Clear')}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
