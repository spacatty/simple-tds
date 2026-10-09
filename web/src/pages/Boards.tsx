import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowRight, BarChart3, Check, Globe, GripVertical, Maximize2, Pencil, Plus, Settings2, Trash2 } from 'lucide-react'
import { del, get, put } from '../api'
import { useLoad } from '../hooks'
import type { Board, BoardWidget, Campaign, ReportRow } from '../types'
import { rangeBuckets } from '../components/DateRangePicker'
import type { DateRange } from '../components/DateRangePicker'
import { BarList, Spark, TimeChart } from '../components/charts'
import { Dropdown, Empty, ErrorBox, Field, MenuItem, Modal, Segmented, Select, Skeleton, confirmDialog, toast, useBusy } from '../components/ui'
import { METRICS, loadReport, sumRows } from '../reports'
import type { MetricKey } from '../reports'
import { buildSearch, dimLabel } from '../filters'
import { fmtInt, ratioPct } from '../format'
import { countryName } from '../countries'
import { dimIcon } from '../components/icons'
import { DomainsWidget } from '../components/DomainHealth'
import FunnelDrawer, { useFunnel } from './FunnelDrawer'
import { t, tx } from '../i18n'

type WidgetType = BoardWidget['type']

const TYPES: { value: WidgetType; label: string; help: string }[] = [
  { value: 'stat', label: t('Number'), help: t('One figure for the period, with its trend.') },
  { value: 'chart', label: t('Chart'), help: t('One figure over time.') },
  { value: 'funnel', label: t('Funnel'), help: t('How far the clicks of a campaign get.') },
  { value: 'top', label: t('Top list'), help: t('The busiest values of one dimension.') },
  { value: 'domains', label: t('Domains'), help: t('How your domains are doing: reachable, pending, unreachable or on a blocklist. It does not depend on the period.') },
]
const DEFAULT_W: Record<WidgetType, number> = { stat: 3, chart: 6, funnel: 6, top: 4, domains: 4 }
const WIDTHS = [
  { value: '3', label: t('Quarter') },
  { value: '4', label: t('Third') },
  { value: '6', label: t('Half') },
  { value: '8', label: t('Two thirds') },
  { value: '12', label: t('Full width') },
]
const HEIGHTS = [
  { value: '0', label: t('Automatic') },
  { value: '160', label: t('Short') },
  { value: '260', label: t('Medium') },
  { value: '380', label: t('Tall') },
]
// The same limits as on the server.
const MIN_W = 2
const MIN_H = 100
const MAX_H = 1200
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

// A row of the board is always full: the widgets in it share the twelve
// columns, so making one wider takes the space from its neighbour and making
// it narrower gives the space back.

/** Indexes of the widgets row by row, the way the grid wraps these widths. */
function rowsOf(widths: number[]): number[][] {
  const rows: number[][] = []
  let sum = 0
  widths.forEach((w, i) => {
    if (!rows.length || sum + w > 12) {
      rows.push([])
      sum = 0
    }
    rows[rows.length - 1].push(i)
    sum += w
  })
  return rows
}

/** Twelve columns shared in proportion to the weights, nobody narrower than the minimum. */
function share(weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  const out = weights.map((w) => Math.max(MIN_W, Math.floor((w * 12) / sum)))
  let left = 12 - out.reduce((a, b) => a + b, 0)
  for (let k = 0; left !== 0 && k < 100; k++) {
    const j = k % out.length
    if (left > 0) {
      out[j]++
      left--
    } else if (out[j] > MIN_W) {
      out[j]--
      left++
    }
  }
  return out
}

/** The same widgets with every row stretched to the full width. */
function fit(list: BoardWidget[]): BoardWidget[] {
  const widths = list.map((w) => clamp(w.w || 12, MIN_W, 12))
  for (const row of rowsOf(widths)) share(row.map((i) => widths[i])).forEach((w, k) => (widths[row[k]] = w))
  return list.map((w, i) => (w.w === widths[i] ? w : { ...w, w: widths[i] }))
}

/**
 * Gives widget i a new width. The difference comes from, or goes to, its
 * neighbour in the row; a widget alone in a row that gets narrower pulls the
 * next one up beside it. With `wrap` a width the neighbour cannot make room
 * for is still applied and the row breaks; without it the width stops there.
 */
function setWidth(from: BoardWidget[], i: number, to: number, wrap: boolean): BoardWidget[] {
  const list = fit(from)
  const widths = list.map((w) => w.w)
  const row = rowsOf(widths).find((r) => r.includes(i)) ?? [i]
  const at = row.indexOf(i)
  if (row.length > 1) {
    const other = row[at + 1] ?? row[at - 1]
    const room = widths[i] + widths[other]
    if (to <= room - MIN_W || !wrap) {
      widths[i] = Math.min(to, room - MIN_W)
      widths[other] = room - widths[i]
    } else {
      widths[i] = to
    }
  } else if (i + 1 < list.length && to <= 12 - MIN_W) {
    widths[i] = to
    widths[i + 1] = 12 - to
  }
  return fit(list.map((w, j) => (w.w === widths[j] ? w : { ...w, w: widths[j] })))
}

/** A new widget joins the last row while everything in it still fits at its usual size. */
function withAdded(from: BoardWidget[], w: BoardWidget): BoardWidget[] {
  const list = fit(from)
  const last = rowsOf(list.map((x) => x.w)).pop() ?? []
  const wants = [...last.map((j) => DEFAULT_W[list[j].type] ?? 4), w.w]
  if (!last.length || wants.reduce((a, b) => a + b, 0) > 12) return [...list, { ...w, w: 12 }]
  const widths = share(wants)
  return [...list.map((x, j) => (last.includes(j) ? { ...x, w: widths[last.indexOf(j)] } : x)), { ...w, w: widths[widths.length - 1] }]
}
const TOP_DIMS = ['campaign', 'stream', 'country', 'device_type', 'os', 'browser', 'ref_domain', 'domain', 'keyword', 'sub1', 'sub2', 'sub3']
const metricOf = (key: string | undefined) => METRICS.find((m) => m.key === key) ?? METRICS[0]
// Colour follows what the figure is, as on the rest of the panel.
const TONE: Partial<Record<MetricKey, string>> = { bots: 'var(--warn)', conversions: 'var(--ok)', cr: 'var(--ok)', revenue: 'var(--ok)', profit: 'var(--ok)', rejected: 'var(--err)', cost: 'var(--series-2)' }

interface WidgetProps {
  w: BoardWidget
  range: DateRange
  tick: number
  campaigns: Campaign[]
}

const scopeOf = (w: BoardWidget) => ({ campaign_id: w.campaign_id || undefined, stream_id: w.stream_id || undefined })

function useTimeline(w: BoardWidget, range: DateRange, tick: number) {
  const buckets = useMemo(() => rangeBuckets(range), [range])
  const rep = useLoad(() => loadReport(buckets.group, range, scopeOf(w)), [w.campaign_id, w.stream_id, range.from, range.to, tick])
  const series = useMemo(() => {
    const byKey = new Map((rep.data ?? []).map((r) => [r.key, r]))
    return buckets.keys.map((k) => byKey.get(k))
  }, [rep.data, buckets])
  return { rep, buckets, series }
}

function StatWidget({ w, range, tick }: WidgetProps) {
  const m = metricOf(w.metric)
  const { rep, series } = useTimeline(w, range, tick)
  const total = useMemo(() => sumRows(rep.data ?? []), [rep.data])
  if (rep.error) return <ErrorBox error={rep.error} retry={rep.reload} />
  if (!rep.data) return <Skeleton rows={2} height={20} />
  const sub =
    m.key === 'bots'
      ? t('{pct} of clicks', { pct: ratioPct(total.bots, total.clicks) })
      : m.key === 'uniques'
        ? t('{pct} of clicks', { pct: ratioPct(total.uniques, total.clicks) })
        : m.key === 'conversions'
          ? `CR ${METRICS.find((x) => x.key === 'cr')?.fmt(total.cr)}`
          : m.key === 'profit' && total.cost > 0
            ? `ROI ${METRICS.find((x) => x.key === 'roi')?.fmt(total.roi)}`
            : ''
  const tone = m.key === 'profit' || m.key === 'roi' ? (total[m.key] > 0 ? ' pos' : total[m.key] < 0 ? ' neg' : '') : ''
  return (
    <div className="wstat">
      <div>
        <b className={'wdg-num' + tone}>{m.fmt(total[m.key])}</b>
        {sub && <small>{sub}</small>}
      </div>
      <Spark values={series.map((r) => r?.[m.key] ?? 0)} color={TONE[m.key] ?? 'var(--series-1)'} />
    </div>
  )
}

function ChartWidget({ w, range, tick }: WidgetProps) {
  const m = metricOf(w.metric)
  const { rep, buckets, series } = useTimeline(w, range, tick)
  if (rep.error) return <ErrorBox error={rep.error} retry={rep.reload} />
  if (!rep.data) return <Skeleton rows={5} />
  const data = buckets.keys.map((k, i) => ({ key: k, [m.key]: series[i]?.[m.key] ?? 0 }))
  return <TimeChart area data={data} series={[{ key: m.key, label: m.label, color: TONE[m.key] ?? 'var(--series-1)' }]} fmt={m.fmt} height={190} fill={!!w.h} />
}

function TopWidget({ w, range, tick, campaigns }: WidgetProps) {
  const dim = w.dim || 'country'
  const rep = useLoad(() => loadReport(dim, range, scopeOf(w)), [dim, w.campaign_id, w.stream_id, range.from, range.to, tick])
  if (rep.error) return <ErrorBox error={rep.error} retry={rep.reload} />
  if (!rep.data) return <Skeleton rows={5} />
  const total = rep.data.reduce((n, r) => n + r.clicks, 0)
  const name = (k: string) => (dim === 'campaign' ? (campaigns.find((c) => String(c.id) === k)?.name ?? `#${k}`) : dim === 'country' ? (k ? countryName(k) : t('(unknown)')) : k === '' ? t('(empty)') : dim === 'stream' ? `#${k}` : k)
  const items = [...rep.data]
    .sort((a, b) => b.clicks - a.clicks)
    // A widget of a set height scrolls, so it can hold more than fits at a glance.
    .slice(0, w.h ? 50 : 7)
    .map((r: ReportRow) => ({
      key: r.key || '-',
      label: (
        <span className="with-icon">
          {dimIcon(dim, r.key)}
          <span className="ellipsis">{name(r.key)}</span>
        </span>
      ),
      value: r.clicks,
      extra: ratioPct(r.clicks, total),
    }))
  return <BarList items={items} />
}

function FunnelWidget({ w, range, campaigns }: WidgetProps) {
  const campaign = campaigns.find((c) => c.id === w.campaign_id)
  if (!campaign) return <div className="muted pad-s">{t('This campaign is not available to you any more.')}</div>
  return <FunnelBody campaign={campaign} w={w} range={range} />
}

// Only the bars: the drops, events and links live in the full funnel, one click away in the header.
function FunnelBody({ campaign, w, range }: { campaign: Campaign; w: BoardWidget; range: DateRange }) {
  const f = useFunnel(campaign, range, { streamId: w.stream_id || undefined })
  if (f.error) return <ErrorBox error={f.error} retry={f.reload} />
  if (!f.loaded) return <Skeleton rows={4} />
  const rows = [{ key: '#clicks', name: t('Clicks'), reached: f.clicks, goal: false }, ...f.steps.map((s) => ({ key: s.key, name: s.name, reached: s.reached, goal: !!s.goal }))]
  return (
    <div className="wbars">
      {rows.map((r, i) => (
        <div key={r.key} className={'wbar' + (r.goal ? ' goal' : '')}>
          <span className="ellipsis">{r.name}</span>
          <b>{fmtInt(r.reached)}</b>
          <small>{i === 0 ? (f.clicks > 0 ? '100%' : '—') : ratioPct(r.reached, f.clicks)}</small>
          <div className="wbar-track">
            <div style={{ width: f.clicks > 0 ? `${Math.min(100, (r.reached / f.clicks) * 100)}%` : 0 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function widgetTitle(w: BoardWidget): string {
  if (w.title) return w.title
  switch (w.type) {
    case 'funnel':
      return t('Funnel')
    case 'top':
      return t('Top: {dim}', { dim: dimLabel(w.dim || 'country').toLowerCase() })
    case 'domains':
      return t('Domain health')
    default:
      return metricOf(w.metric).label
  }
}

/** One of the user's own dashboards: a grid of pinned widgets that can be rearranged in place. */
export function BoardView({ board, range, setRange, tick, onChange, onDeleted }: { board: Board; range: DateRange; setRange: (r: DateRange) => void; tick: number; onChange: (b: Board) => void; onDeleted: () => void }) {
  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])
  const campaigns = camps.data ?? []
  const [arranging, setArranging] = useState(false)
  const [editing, setEditing] = useState<{ index: number; draft: BoardWidget } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [funnelFor, setFunnelFor] = useState<BoardWidget | null>(null)
  const [busy, run] = useBusy()
  const grid = useRef<HTMLDivElement>(null)
  // The size under the pointer while a widget is being dragged; saved on release.
  const [drag, setDrag] = useState<{ index: number; list: BoardWidget[] } | null>(null)
  const stored = useMemo(() => fit(board.widgets ?? []), [board.widgets])
  const widgets = drag ? drag.list : stored
  // The order shown while a widget is being carried to a new place; saved on release.
  const [carry, setCarry] = useState<{ key: string; order: number[] } | null>(null)
  const keyOf = (i: number) => stored[i].id || String(i)
  const order = carry && carry.order.length === stored.length ? carry.order : stored.map((_, i) => i)
  // Fitted again in the order being tried, as the rows change with it.
  const shown = carry ? fit(order.map((i) => widgets[i])) : widgets
  const view = order.map((i, at) => ({ i, w: shown[at] }))
  const els = useRef(new Map<string, HTMLElement>())
  const places = useRef(new Map<string, { x: number; y: number }>())
  // The carried widget follows the pointer without a render per move.
  const carried = useRef<{ key: string; x: number; y: number; gx: number; gy: number } | null>(null)
  const dropped = useRef('')
  const follow = () => {
    const c = carried.current
    const el = c && els.current.get(c.key)
    const box = grid.current?.getBoundingClientRect()
    if (c && el && box) el.style.transform = `translate(${c.x - box.left - c.gx - el.offsetLeft}px, ${c.y - box.top - c.gy - el.offsetTop}px)`
  }
  // In edit mode a widget that ends up somewhere else slides there from
  // where it was instead of jumping. Offsets are used because they ignore the
  // transform of a slide still in progress.
  useLayoutEffect(() => {
    const now = new Map<string, { x: number; y: number }>()
    els.current.forEach((el, key) => {
      const at = { x: el.offsetLeft, y: el.offsetTop }
      const was = places.current.get(key)
      now.set(key, at)
      if (key === carried.current?.key) return follow()
      if (key === dropped.current) {
        // Released: glide from under the pointer into the slot.
        dropped.current = ''
        el.getBoundingClientRect()
        el.style.transform = ''
        return
      }
      if (!arranging || !was || (was.x === at.x && was.y === at.y)) return
      el.style.transition = 'none'
      el.style.transform = `translate(${was.x - at.x}px, ${was.y - at.y}px)`
      el.getBoundingClientRect()
      el.style.transition = ''
      el.style.transform = ''
    })
    places.current = now
  })

  const save = (next: BoardWidget[]) =>
    run(async () => {
      // Shown at once; the server's answer (with ids for new widgets) replaces it.
      next = fit(next)
      onChange({ ...board, widgets: next })
      try {
        onChange(await put<Board>(`dashboards/${board.id}`, { widgets: next }))
      } catch (e) {
        onChange(board)
        toast.err(e)
      }
    })
  const move = (i: number, by: number) => {
    const next = [...widgets]
    ;[next[i], next[i + by]] = [next[i + by], next[i]]
    save(next)
  }
  const resize = (i: number) => {
    const sizes = [3, 4, 6, 8, 12]
    const at = sizes.indexOf(widgets[i].w)
    save(setWidth(stored, i, sizes[(at + 1) % sizes.length], true))
  }
  const startResize = (e: ReactPointerEvent<HTMLElement>, i: number, axis: 'x' | 'y' | 'xy') => {
    const handle = e.currentTarget
    const box = handle.parentElement?.getBoundingClientRect()
    if (!box || !grid.current || busy || e.button !== 0) return
    e.preventDefault()
    const from = stored[i]
    const gap = parseFloat(getComputedStyle(grid.current).columnGap) || 0
    const column = (grid.current.clientWidth + gap) / 12
    const x0 = e.clientX
    const y0 = e.clientY
    let next = { index: i, list: stored }
    const onMove = (ev: PointerEvent) => {
      const w = axis === 'y' ? from.w : clamp(Math.round((box.width + ev.clientX - x0 + gap) / column), MIN_W, 12)
      const h = axis === 'x' ? (from.h ?? 0) : clamp(Math.round((box.height + ev.clientY - y0) / 10) * 10, MIN_H, MAX_H)
      next = { index: i, list: (w === from.w ? stored : setWidth(stored, i, w, false)).map((x, j) => (j === i ? { ...x, h } : x)) }
      setDrag(next)
    }
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onEnd)
      handle.removeEventListener('pointercancel', onEnd)
      setDrag(null)
      if (next.list.some((w, j) => w.w !== stored[j].w || (w.h ?? 0) !== (stored[j].h ?? 0))) save(next.list)
    }
    // Captured, so the drag goes on when the pointer leaves the thin handle.
    handle.setPointerCapture(e.pointerId)
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onEnd)
    handle.addEventListener('pointercancel', onEnd)
  }
  const startCarry = (e: ReactPointerEvent<HTMLElement>, i: number) => {
    const el = e.currentTarget.parentElement
    if (!el || busy || e.button !== 0 || (e.target as HTMLElement).closest('button, a')) return
    e.preventDefault()
    const key = keyOf(i)
    const box = el.getBoundingClientRect()
    let order = stored.map((_, j) => j)
    // The widget just swapped with: it is skipped until the pointer leaves it,
    // or two widgets of different sizes would trade places on every move.
    let last = -1
    carried.current = { key, x: e.clientX, y: e.clientY, gx: e.clientX - box.left, gy: e.clientY - box.top }
    setCarry({ key, order })
    const onMove = (ev: PointerEvent) => {
      const c = carried.current
      const board = grid.current?.getBoundingClientRect()
      if (!c || !board) return
      c.x = ev.clientX
      c.y = ev.clientY
      follow()
      const x = ev.clientX - board.left
      const y = ev.clientY - board.top
      const over = order.find((j) => {
        const o = j === i ? undefined : els.current.get(keyOf(j))
        return o && x >= o.offsetLeft && x < o.offsetLeft + o.offsetWidth && y >= o.offsetTop && y < o.offsetTop + o.offsetHeight
      })
      if (over === undefined) last = -1
      if (over === undefined || over === last) return
      last = over
      const to = order.indexOf(over)
      order = order.filter((j) => j !== i)
      order.splice(to, 0, i)
      setCarry({ key, order })
    }
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      carried.current = null
      dropped.current = key
      setCarry(null)
      if (order.some((j, at) => j !== at)) save(order.map((j) => stored[j]))
    }
    // On the window, not captured by the header: reordering moves the header in
    // the DOM, and a node that is moved loses its pointer capture.
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }
  const autoHeight = (i: number) => {
    if (!busy && stored[i].h) save(stored.map((w, j) => (j === i ? { ...w, h: 0 } : w)))
  }
  const remove = async () => {
    if (!(await confirmDialog({ title: t('Delete dashboard?'), message: tx('Dashboard <b>{name}</b> and its widgets will be deleted. No statistics are lost.', { b: (c) => <b>{c}</b>, name: board.name }) }))) return
    try {
      await del(`dashboards/${board.id}`)
      toast.ok(t('Dashboard deleted'))
      onDeleted()
    } catch (e) {
      toast.err(e)
    }
  }
  const rename = async () => {
    const name = (renaming ?? '').trim()
    setRenaming(null)
    if (!name || name === board.name) return
    try {
      onChange(await put<Board>(`dashboards/${board.id}`, { name }))
    } catch (e) {
      toast.err(e)
    }
  }
  const add = () => setEditing({ index: -1, draft: { id: '', type: 'stat', metric: 'clicks', w: DEFAULT_W.stat } })
  const scopeName = (w: BoardWidget) => (w.type === 'domains' ? t('Your domains') : w.campaign_id ? (campaigns.find((c) => c.id === w.campaign_id)?.name ?? `#${w.campaign_id}`) : t('All campaigns'))
  const funnelCampaign = funnelFor && campaigns.find((c) => c.id === funnelFor.campaign_id)

  return (
    <div className="board-wrap">
      <div className="board-bar">
        {renaming !== null ? (
          <input className="input board-rename" autoFocus value={renaming} maxLength={64} onChange={(e) => setRenaming(e.target.value)} onBlur={rename} onKeyDown={(e) => (e.key === 'Enter' ? rename() : e.key === 'Escape' ? setRenaming(null) : undefined)} />
        ) : (
          <span className="muted small">
            {widgets.length === 0 ? t('Empty dashboard') : arranging ? t('Edit mode: move, resize, change or remove the widgets.') : t('Your own dashboard — only you see it.')}
          </span>
        )}
        <span className="grow" />
        <button className="btn" onClick={add}>
          <Plus size={14} /> {t('Add widget')}
        </button>
        {widgets.length > 0 && (
          <button className={'btn ' + (arranging ? 'ok' : 'accent')} onClick={() => setArranging((a) => !a)} title={t('Move, resize and remove widgets')}>
            {arranging ? <Check size={14} /> : <Pencil size={14} />} {arranging ? t('Done') : t('Edit@@dashboard')}
          </button>
        )}
        <Dropdown align="right" className="btn" chevron={false} label={<Settings2 size={14} />} title={t('Dashboard settings')}>
          {(close) => (
            <div className="menu">
              <MenuItem
                onClick={() => {
                  close()
                  setRenaming(board.name)
                }}
              >
                <Pencil size={14} /> {t('Rename dashboard')}
              </MenuItem>
              <div className="menu-sep" />
              <MenuItem
                danger
                onClick={() => {
                  close()
                  remove()
                }}
              >
                <Trash2 size={14} /> {t('Delete dashboard')}
              </MenuItem>
            </div>
          )}
        </Dropdown>
      </div>

      {widgets.length === 0 ? (
        <div className="card">
          <Empty
            title={t('Nothing pinned yet')}
            action={
              <button className="btn primary" onClick={add}>
                <Plus size={15} /> {t('Add the first widget')}
              </button>
            }
          >
            {t('Add numbers, charts and top lists here, or open a funnel anywhere in the panel and press “Pin”.')}
          </Empty>
        </div>
      ) : (
        <div ref={grid} className={'board' + (arranging ? ' arranging' : '')}>
          {view.map(({ w, i }) => {
            const key = keyOf(i)
            const props: WidgetProps = { w, range, tick, campaigns }
            let body: ReactNode
            if (camps.loading && !camps.data) body = <Skeleton rows={3} />
            else if (w.type === 'chart') body = <ChartWidget {...props} />
            else if (w.type === 'funnel') body = <FunnelWidget {...props} />
            else if (w.type === 'top') body = <TopWidget {...props} />
            else if (w.type === 'domains') body = <DomainsWidget tick={tick} tall={!!w.h} />
            else body = <StatWidget {...props} />
            const filters = scopeOf(w)
            return (
              <section
                key={key}
                ref={(el) => {
                  if (el) els.current.set(key, el)
                  else els.current.delete(key)
                }}
                className={'wdg wdg-' + w.type + (w.h ? ' sized' : '') + (drag?.index === i ? ' resizing' : '') + (carry?.key === key ? ' carried' : '')}
                style={{ gridColumn: `span ${w.w}`, height: w.h || undefined, ['--metric' as string]: (w.type === 'stat' || w.type === 'chart') && TONE[metricOf(w.metric).key] ? TONE[metricOf(w.metric).key] : undefined }}>
                <header className="wdg-head" onPointerDown={arranging ? (e) => startCarry(e, i) : undefined} title={arranging ? t('Drag to move the widget') : undefined}>
                  {arranging && <GripVertical className="wdg-grip" size={14} />}
                  <div className="wdg-title">
                    <b className="ellipsis">{widgetTitle(w)}</b>
                    <span className="ellipsis">{scopeName(w)}</span>
                  </div>
                  {arranging ? (
                    <div className="wdg-tools">
                      <button className="icon-btn" disabled={busy || i === 0} onClick={() => move(i, -1)} title={t('Move earlier')}>
                        <ArrowLeft size={14} />
                      </button>
                      <button className="icon-btn" disabled={busy || i === widgets.length - 1} onClick={() => move(i, 1)} title={t('Move later')}>
                        <ArrowRight size={14} />
                      </button>
                      <button className="icon-btn" disabled={busy} onClick={() => resize(i)} title={t('Change the width')}>
                        <Maximize2 size={13} />
                      </button>
                      <button className="icon-btn" onClick={() => setEditing({ index: i, draft: { ...w } })} title={t('Widget settings')}>
                        <Pencil size={13} />
                      </button>
                      <button className="icon-btn danger" disabled={busy} onClick={() => save(widgets.filter((_, j) => j !== i))} title={t('Remove widget')}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ) : w.type === 'domains' ? (
                    <Link className="wdg-link" to="/domains" title={t('Open Domains')}>
                      <Globe size={13} />
                    </Link>
                  ) : w.type !== 'funnel' ? (
                    <Link className="wdg-link" to={'/reports' + buildSearch({ range, group: w.type === 'top' ? w.dim || 'country' : undefined, filters })} title={t('Open in Reports')}>
                      <BarChart3 size={13} />
                    </Link>
                  ) : (
                    campaigns.some((c) => c.id === w.campaign_id) && (
                      <button className="wdg-link" onClick={() => setFunnelFor(w)} title={t('Open the full funnel')}>
                        <Maximize2 size={13} />
                      </button>
                    )
                  )}
                </header>
                <div className="wdg-body">{body}</div>
                {arranging && (
                  <>
                    <div className="wdg-rs x" onPointerDown={(e) => startResize(e, i, 'x')} title={t('Drag to change the width')} />
                    <div className="wdg-rs y" onPointerDown={(e) => startResize(e, i, 'y')} onDoubleClick={() => autoHeight(i)} title={t('Drag to change the height; double-click to fit the content')} />
                    <div className="wdg-rs xy" onPointerDown={(e) => startResize(e, i, 'xy')} title={t('Drag to resize')} />
                    {drag?.index === i && <span className="wdg-size">{`${w.w}/12` + (w.h ? ` × ${w.h}` : '')}</span>}
                  </>
                )}
              </section>
            )
          })}
        </div>
      )}

      {editing && (
        <WidgetEditor
          draft={editing.draft}
          isNew={editing.index < 0}
          campaigns={campaigns}
          onClose={() => setEditing(null)}
          onSave={(w) => {
            save(
              editing.index < 0
                ? withAdded(stored, w)
                : setWidth(
                    stored.map((x, j) => (j === editing.index ? { ...w, w: x.w } : x)),
                    editing.index,
                    w.w,
                    true,
                  ),
            )
            setEditing(null)
          }}
        />
      )}
      {funnelFor && funnelCampaign && (
        <FunnelDrawer campaign={funnelCampaign} stream={funnelFor.stream_id ? { id: funnelFor.stream_id, name: funnelFor.title || `#${funnelFor.stream_id}` } : undefined} range={range} setRange={setRange} onClose={() => setFunnelFor(null)} />
      )}
    </div>
  )
}

/** The presets, plus the current size when it was set by dragging and matches none of them. */
function withCustom(presets: { value: string; label: string }[], n: number, label: string) {
  return presets.some((p) => p.value === String(n)) ? presets : [...presets, { value: String(n), label }]
}

function WidgetEditor({ draft, isNew, campaigns, onClose, onSave }: { draft: BoardWidget; isNew: boolean; campaigns: Campaign[]; onClose: () => void; onSave: (w: BoardWidget) => void }) {
  const [w, setW] = useState<BoardWidget>(draft)
  const [error, setError] = useState('')
  const set = (p: Partial<BoardWidget>) => setW((x) => ({ ...x, ...p }))
  const type = TYPES.find((x) => x.value === w.type) ?? TYPES[0]
  const submit = () => {
    if (w.type === 'funnel' && !w.campaign_id) return setError(t('Choose the campaign whose funnel to show.'))
    onSave({ ...w, campaign_id: w.type === 'domains' ? 0 : w.campaign_id, title: (w.title ?? '').trim(), metric: w.type === 'stat' || w.type === 'chart' ? w.metric || 'clicks' : '', dim: w.type === 'top' ? w.dim || 'country' : '', stream_id: w.type === 'funnel' && w.campaign_id === draft.campaign_id ? w.stream_id : 0 })
  }
  return (
    <Modal
      title={isNew ? t('Add widget') : t('Widget settings')}
      size="md"
      onClose={onClose}
      footer={
        <>
          {error && <div className="field-error grow">{error}</div>}
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn primary" onClick={submit}>
            {isNew ? t('Add widget') : t('Save')}
          </button>
        </>
      }
    >
      <Field label={t('Shows')} help={type.help}>
        <Segmented value={w.type} onChange={(v) => set({ type: v, w: isNew ? DEFAULT_W[v] : w.w })} options={TYPES.map((x) => ({ value: x.value, label: x.label }))} />
      </Field>
      {(w.type === 'stat' || w.type === 'chart') && (
        <Field label={t('Figure')}>
          <Select value={w.metric || 'clicks'} onChange={(metric) => set({ metric })} options={METRICS.map((m) => ({ value: m.key, label: m.title ? `${m.label} — ${m.title}` : m.label }))} />
        </Field>
      )}
      {w.type === 'top' && (
        <Field label={t('Dimension')}>
          <Select value={w.dim || 'country'} onChange={(dim) => set({ dim })} options={TOP_DIMS.map((d) => ({ value: d, label: dimLabel(d) }))} />
        </Field>
      )}
      {w.type !== 'domains' && (
        <Field label={t('Campaign')} help={w.type === 'funnel' ? t('A funnel always belongs to one campaign.') : t('Leave on “All campaigns” for everything you can see.')}>
          <Select
            value={w.campaign_id ? String(w.campaign_id) : ''}
            onChange={(v) => set({ campaign_id: v ? Number(v) : 0 })}
            placeholder={w.type === 'funnel' ? t('Choose a campaign…') : undefined}
            options={[...(w.type === 'funnel' ? [] : [{ value: '', label: t('All campaigns') }]), ...campaigns.map((c) => ({ value: String(c.id), label: c.name }))]}
          />
        </Field>
      )}
      <Field label={t('Title')} help={t('Optional: the widget names itself otherwise.')}>
        <input className="input" value={w.title ?? ''} maxLength={80} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <div className="form-grid wdg-form-size">
        <Field label={t('Width')}>
          <Select value={String(w.w)} onChange={(v) => set({ w: Number(v) })} options={withCustom(WIDTHS, w.w, t('{n} of 12 columns', { n: w.w }))} />
        </Field>
        <Field label={t('Height')}>
          <Select value={String(w.h ?? 0)} onChange={(v) => set({ h: Number(v) })} options={withCustom(HEIGHTS, w.h ?? 0, t('{n} px', { n: w.h ?? 0 }))} />
        </Field>
      </div>
      <div className="field-help wdg-form-hint">{t('In edit mode a widget can also be resized by dragging its edges.')}</div>
    </Modal>
  )
}
