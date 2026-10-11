import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { BarChart3, Bookmark, MousePointerClick, Pin, PinOff, Plus, Save, Trash2 } from 'lucide-react'
import { del, get, post, put } from '../api'
import type { Params } from '../api'
import { useApp, useLoad, useMeta, usePref } from '../hooks'
import type { Campaign, Landing, ReportPreset, SplitRow, Stream, SuppressRule } from '../types'
import { Dropdown, ErrorBox, Field, FilterField, MenuItem, Modal, Select, Skeleton, Toggle, confirmDialog, toast, useBusy } from '../components/ui'
import type { SelectOption } from '../components/ui'
import { dimIcon } from '../components/icons'
import { dimLabel, paramFor, valueText } from '../filters'
import { fmtInt, fmtPct, ratioPct } from '../format'
import { BUILTIN_PINS_DEFAULT, BUILTIN_PINS_PREF, BUILTIN_PRESETS, TOP_PATH, builtinHref, builtinOf, presetHref, presetQuery, reloadReportPresets, useReportPresets } from '../reportPresets'
import type { BuiltinPreset } from '../reportPresets'
import { t, tn } from '../i18n'
import { GROUP_SECTIONS } from './Reports'
import SplitReport, { MIN_CR_CLICKS } from './SplitReport'
import type { SplitLinks, SplitSpec } from './SplitReport'

const DEFAULT_DIM = 'country'
/** The full address of the referring page: only under a referrer domain, and only clicks keep it. */
const PAGES = 'referer'
/** What a row unfolds into unless the address says otherwise. */
const DEFAULT_SUB: Record<string, string> = { country: 'city', region: 'city', city: 'isp', ref_domain: PAGES, campaign: 'stream', stream: 'country' }
const MAX_SUB_ROWS = 50
const MAIN_FILTERS = ['campaign', 'country', 'device_type', 'os', 'bots', 'banned']
const MORE_FILTERS = ['stream', 'domain', 'action', 'region', 'city', 'isp', 'lang', 'browser', 'ref_domain', 'keyword', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'bot_reason']

/** Whether two query strings say the same, whatever the order of their parameters. */
function sameQuery(a: string, b: string): boolean {
  const norm = (q: string) => [...new URLSearchParams(q)].map(([k, v]) => k + '=' + v).sort().join('&')
  return norm(a) === norm(b)
}

/** The report constructor: the values of any dimension ranked, each unfolding by a second one. */
export default function TopReport() {
  const meta = useMeta()
  const nav = useNavigate()
  const [sp, setSp] = useSearchParams()
  const dims = useMemo(() => meta.report_splits ?? [], [meta.report_splits])
  const filterable = useMemo(() => meta.report_filters ?? [], [meta.report_filters])
  const dim = dims.includes(sp.get('dim') ?? '') ? (sp.get('dim') as string) : DEFAULT_DIM

  const subs = useMemo(() => [...(dim === 'ref_domain' ? [PAGES] : []), ...dims.filter((d) => d !== dim)], [dims, dim])
  const wanted = sp.get('sub') ?? DEFAULT_SUB[dim] ?? ''
  const sub = subs.includes(wanted) ? wanted : subs.includes('country') ? 'country' : 'campaign'

  const update = (fn: (n: URLSearchParams) => void) => {
    const n = new URLSearchParams(sp)
    fn(n)
    setSp(n)
  }

  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])
  const streams = useLoad(() => get<Stream[]>('streams'), [])
  const landings = useLoad(() => get<Landing[]>('landings'), [])

  const presets = useReportPresets()
  const preset = presets?.find((p) => String(p.id) === sp.get('preset'))
  const builtin = preset ? undefined : builtinOf(sp)
  // With suppressed sources shown, the referrers on the viewer's own list are told apart.
  const me = useApp().user.id
  const rules = useLoad(() => get<SuppressRule[] | null>('suppress-rules'), [])
  const bannedRefs = useMemo(() => (rules.data ?? []).filter((r) => r.kind === 'referer' && r.owner_id === me).map((r) => r.value), [rules.data, me])
  const query = presetQuery(sp, dim)
  const [saving, setSaving] = useState(false)

  const spec = useMemo<SplitSpec>(() => {
    /** Plain-text name of a value of a dimension (ids resolved to names). */
    const name = (d: string, k: string): string => {
      switch (d) {
        case 'campaign':
          return k === '0' ? t('(no campaign)') : camps.data?.find((c) => String(c.id) === k)?.name ?? `#${k}`
        case 'stream':
          return k === '0' ? t('(no stream)') : streams.data?.find((s) => String(s.id) === k)?.name ?? `#${k}`
        case 'landing':
          return k === '0' ? t('(no landing)') : landings.data?.find((l) => String(l.id) === k)?.name ?? `#${k}`
        case 'landing_preset': {
          // "<landing id>:<preset id>"; preset 0 is the landing shown with its default values.
          const [lid, pid] = k.split(':')
          if (lid === '0') return t('(no landing)')
          const l = landings.data?.find((x) => String(x.id) === lid)
          const p = pid === '0' ? t('default values') : l?.presets?.find((x) => String(x.id) === pid)?.name ?? `#${pid}`
          return `${l?.name ?? '#' + lid} · ${p}`
        }
        default:
          return valueText(d, k)
      }
    }
    const param = paramFor(dim, filterable)
    const label = dimLabel(dim)
    const groupOptions: SelectOption[] = []
    for (const [section, items] of GROUP_SECTIONS) for (const g of items) if (dims.includes(g)) groupOptions.push({ value: g, label: dimLabel(g), group: section })
    for (const g of dims) if (!groupOptions.some((o) => o.value === g)) groupOptions.push({ value: g, label: dimLabel(g), group: t('Other') })

    return {
      id: 'top-' + dim,
      title: preset ? preset.name : builtin ? builtin.name : t('Top lists'),
      sub: t('The values of any dimension, ranked. Save a view as a preset to keep it in the sidebar.'),
      endpoint: 'reports/split',
      params: { dim },
      dim,
      param,
      column: label,
      name: (k) => name(dim, k),
      cell: (k, r) => (
        <span className="with-icon">
          {dimIcon(dim, k, r?.country)}
          {name(dim, k)}
          {dim === 'ref_domain' && k !== '' && bannedRefs.some((d) => k === d || k.endsWith('.' + d)) && (
            <span className="tag warn" title={t('On your suppress list')}>
              {t('suppressed')}
            </span>
          )}
        </span>
      ),
      actions: <PresetMenu presets={presets} current={preset} builtin={builtin} query={query} onSaveAs={() => setSaving(true)} />,
      main: [
        {
          key: 'dim',
          node: (
            <FilterField key="dim" label={t('Rank')}>
              <Select
                value={dim}
                options={groupOptions}
                onChange={(d) =>
                  update((n) => {
                    n.set('dim', d)
                    // What a row unfolds into belongs to the dimension that was shown, and so does a built-in view.
                    n.delete('sub')
                    n.delete('view')
                  })
                }
              />
            </FilterField>
          ),
        },
        ...MAIN_FILTERS,
      ],
      more: MORE_FILTERS,
      tiles: (s) => [
        { label: t('Distinct values'), value: fmtInt(s.count) },
        { label: t('Clicks with a value'), value: fmtInt(s.clicks), sub: t('{pct} of clicks', { pct: ratioPct(s.clicks, s.all) }) },
        { label: t('Clicks without a value'), value: fmtInt(s.blank), sub: t('{pct} of clicks', { pct: ratioPct(s.blank, s.all) }) },
      ],
      topTitle: (metric) => t('{dim}: top 10 by {metric}', { dim: label, metric }),
      allTitle: t('All values'),
      searchPlaceholder: t('Search…'),
      count: (n) => tn(n, '{n} value', '{n} values', { n: fmtInt(n) }),
      crEmpty: t('No value with at least {n} non-bot clicks has converted in this period.', { n: MIN_CR_CLICKS }),
      crNote: t('Only values with at least {n} non-bot clicks are ranked.', { n: MIN_CR_CLICKS }),
      expand: param
        ? (r, params, links) => (
            <SubRows
              // An id of zero is "none", which the id filters cannot ask for.
              narrow={param.endsWith('_id') && r.key === '0' ? null : { [param]: r.key }}
              sub={sub}
              subs={subs}
              setSub={(v) => update((n) => n.set('sub', v))}
              params={params}
              links={links}
              name={name}
            />
          )
        : undefined,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dim, sub, subs, dims, filterable, camps.data, streams.data, landings.data, presets, preset, builtin, bannedRefs, query])

  return (
    <>
      <SplitReport spec={spec} />
      {saving && <SavePreset query={query} suggested={preset ? '' : dimLabel(dim)} onClose={() => setSaving(false)} onSaved={(p) => nav(presetHref(p))} />}
    </>
  )
}

/** One row of the report by a second dimension. */
function SubRows({ narrow, sub, subs, setSub, params, links, name }: { narrow: Params | null; sub: string; subs: string[]; setSub: (v: string) => void; params: Params; links: SplitLinks; name: (dim: string, key: string) => string }) {
  const pages = sub === PAGES
  const key = JSON.stringify(narrow)
  const rep = useLoad(async () => {
    if (!narrow) return []
    const r = await get<{ rows: SplitRow[] | null }>(pages ? 'reports/referrers/urls' : 'reports/split', { ...params, ...narrow, ...(pages ? {} : { dim: sub }) })
    return r.rows ?? []
  }, [key, params, sub])
  const all = rep.data ?? []
  const rows = all.slice(0, MAX_SUB_ROWS)
  const subLabel = (d: string) => (d === PAGES ? t('Page') : dimLabel(d))
  // Only clicks keep the page, so its rows carry no conversions.
  const nums: ('clicks' | 'uniques' | 'mobile' | 'desktop' | 'bots' | 'conversions')[] = pages ? ['clicks', 'uniques', 'mobile', 'desktop', 'bots'] : ['clicks', 'uniques', 'mobile', 'desktop', 'bots', 'conversions']
  return (
    <div className="ref-pages">
      <div className="row gap-s">
        <span className="muted">{t('Break down by')}</span>
        <Select value={sub} onChange={setSub} options={subs.map((d) => ({ value: d, label: subLabel(d) }))} />
        <span className="muted grow">{all.length > rows.length ? t('The {n} that sent the most clicks, of {total}', { n: rows.length, total: fmtInt(all.length) }) : ''}</span>
        <Link className="btn small" to={links.clicks}>
          <MousePointerClick size={13} /> {t('Clicks')}
        </Link>
        <Link className="btn small" to={links.breakdown}>
          <BarChart3 size={13} /> {t('Breakdown')}
        </Link>
      </div>
      <ErrorBox error={rep.error} retry={rep.reload} />
      {!rep.data && !rep.error && <Skeleton rows={3} />}
      {rep.data && rows.length === 0 && <div className="muted">{t('No data for this selection.')}</div>}
      {rows.length > 0 && (
        <table className={'table' + (rep.loading ? ' reloading' : '')}>
          <thead>
            <tr>
              <th>{subLabel(sub)}</th>
              <th style={{ textAlign: 'right' }}>{t('Clicks')}</th>
              <th style={{ textAlign: 'right' }}>{t('Uniques')}</th>
              <th style={{ textAlign: 'right' }}>{t('Mobile')}</th>
              <th style={{ textAlign: 'right' }}>{t('Desktop')}</th>
              <th style={{ textAlign: 'right' }}>{t('Bots')}</th>
              {!pages && (
                <>
                  <th style={{ textAlign: 'right' }} title={t('Conversions (excluding rejected)')}>
                    {t('Conv.')}
                  </th>
                  <th style={{ textAlign: 'right' }} title={t('Conversions / non-bot clicks')}>
                    {t('CR')}
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                {/* Text, not a link: a referring page is whatever the visitor's browser sent. */}
                {pages ? (
                  <td className="ref-url" title={r.key}>
                    {r.key === '' ? t('(empty)') : r.key}
                  </td>
                ) : (
                  <td className={r.key === '' ? 'muted' : ''}>
                    <span className="with-icon">
                      {dimIcon(sub, r.key, r.country)}
                      {name(sub, r.key)}
                    </span>
                  </td>
                )}
                {nums.map((k) => (
                  <td key={k} style={{ textAlign: 'right' }} className={r[k] === 0 ? 'muted' : ''}>
                    {fmtInt(r[k])}
                  </td>
                ))}
                {!pages && (
                  <td style={{ textAlign: 'right' }} className={r.cr === 0 ? 'muted' : ''}>
                    {fmtPct(r.cr)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** The saved views: open one, keep the open one up to date, pin, delete, or save what is on screen. */
function PresetMenu({ presets, current, builtin, query, onSaveAs }: { presets: ReportPreset[] | undefined; current: ReportPreset | undefined; builtin: BuiltinPreset | undefined; query: string; onSaveAs: () => void }) {
  const nav = useNavigate()
  const [pins, setPins] = usePref<string>(BUILTIN_PINS_PREF, BUILTIN_PINS_DEFAULT)
  const pinnedKeys = pins.split(',').filter(Boolean)
  const flipPin = (key: string) => setPins((pinnedKeys.includes(key) ? pinnedKeys.filter((k) => k !== key) : [...pinnedKeys, key]).join(','))
  const [busy, run] = useBusy()
  const changed = !!current && !sameQuery(current.query, query)
  const change = (fn: () => Promise<unknown>, done?: () => void) =>
    run(async () => {
      await fn()
      await reloadReportPresets()
      done?.()
    })
  const remove = async (p: ReportPreset) => {
    if (!(await confirmDialog({ title: t('Delete the preset “{name}”?', { name: p.name }), confirmLabel: t('Delete'), danger: true }))) return
    // The view stays on screen, as a report that is no longer saved.
    change(() => del(`report-presets/${p.id}`), () => p.id === current?.id && nav(TOP_PATH + '?' + query, { replace: true }))
  }
  return (
    <Dropdown
      align="right"
      className="btn"
      title={t('Saved views of this report')}
      label={
        <>
          <Bookmark size={14} /> {t('Presets')}
          {changed && <span className="preset-dot" title={t('Changed since it was saved')} />}
        </>
      }
    >
      {(close) => (
        <div className="menu pin-menu">
          <div className="menu-title">{t('Built-in')}</div>
          {BUILTIN_PRESETS.map((b) => (
            <div className="preset-row" key={b.key}>
              <button type="button" className={'menu-item' + (b === builtin ? ' selected' : '')} onClick={() => (close(), nav(builtinHref(b)))}>
                <span className="grow ellipsis">{b.name}</span>
              </button>
              <button type="button" className="icon-btn" title={pinnedKeys.includes(b.key) ? t('Remove from the sidebar') : t('Show in the sidebar')} aria-label={pinnedKeys.includes(b.key) ? t('Remove from the sidebar') : t('Show in the sidebar')} onClick={() => flipPin(b.key)}>
                {pinnedKeys.includes(b.key) ? <Pin size={14} /> : <PinOff size={14} />}
              </button>
            </div>
          ))}
          <div className="menu-sep" />
          <div className="menu-title">{t('Report presets')}</div>
          {!presets && (
            <div className="pad-s">
              <Skeleton rows={2} />
            </div>
          )}
          {presets?.length === 0 && <div className="muted small pad-s">{t('Nothing saved yet. Set the report up and save it under a name.')}</div>}
          {(presets ?? []).map((p) => (
            <div className="preset-row" key={p.id}>
              <button type="button" className={'menu-item' + (p.id === current?.id ? ' selected' : '')} onClick={() => (close(), nav(presetHref(p)))}>
                <span className="grow ellipsis">{p.name}</span>
              </button>
              <button
                type="button"
                className="icon-btn"
                disabled={busy}
                title={p.pinned ? t('Remove from the sidebar') : t('Show in the sidebar')}
                aria-label={p.pinned ? t('Remove from the sidebar') : t('Show in the sidebar')}
                onClick={() => change(() => put(`report-presets/${p.id}`, { pinned: !p.pinned }))}
              >
                {p.pinned ? <Pin size={14} /> : <PinOff size={14} />}
              </button>
              <button type="button" className="icon-btn" disabled={busy} title={t('Delete')} aria-label={t('Delete')} onClick={() => (close(), remove(p))}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <div className="menu-sep" />
          {current && (
            <MenuItem disabled={busy || !changed} onClick={() => change(() => put(`report-presets/${current.id}`, { query }), () => (close(), toast.ok(t('Preset “{name}” updated', { name: current.name }))))}>
              <Save size={14} /> <span className="grow ellipsis">{t('Save changes to “{name}”', { name: current.name })}</span>
            </MenuItem>
          )}
          <MenuItem onClick={() => (close(), onSaveAs())}>
            <Plus size={14} /> {t('Save as a new preset…')}
          </MenuItem>
        </div>
      )}
    </Dropdown>
  )
}

function SavePreset({ query, suggested, onClose, onSaved }: { query: string; suggested: string; onClose: () => void; onSaved: (p: ReportPreset) => void }) {
  const [name, setName] = useState(suggested)
  const [pinned, setPinned] = useState(true)
  const [busy, run] = useBusy()
  const save = () =>
    run(async () => {
      const p = await post<ReportPreset>('report-presets', { name: name.trim(), query, pinned })
      await reloadReportPresets()
      toast.ok(t('Preset “{name}” saved', { name: p.name }))
      onClose()
      onSaved(p)
    })
  return (
    <Modal
      title={t('Save as a preset')}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={save}>
            {t('Save')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && !busy) save()
        }}
      >
        <Field label={t('Name')} help={t('The preset keeps the ranked dimension, the period and every filter as they are now.')}>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        </Field>
        <Toggle checked={pinned} onChange={setPinned} label={t('Show in the sidebar')} />
      </form>
    </Modal>
  )
}
