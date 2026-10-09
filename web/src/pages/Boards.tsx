import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowRight, BarChart3, LayoutGrid, Maximize2, Pencil, Plus, Settings2, Trash2 } from 'lucide-react'
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
import { ratioPct } from '../format'
import { countryName } from '../countries'
import { dimIcon } from '../components/icons'
import FunnelDrawer, { FunnelSteps, useFunnel } from './FunnelDrawer'
import { t, tx } from '../i18n'

type WidgetType = BoardWidget['type']

const TYPES: { value: WidgetType; label: string; help: string }[] = [
  { value: 'stat', label: t('Number'), help: t('One figure for the period, with its trend.') },
  { value: 'chart', label: t('Chart'), help: t('One figure over time.') },
  { value: 'funnel', label: t('Funnel'), help: t('How far the clicks of a campaign get.') },
  { value: 'top', label: t('Top list'), help: t('The busiest values of one dimension.') },
]
const DEFAULT_W: Record<WidgetType, number> = { stat: 3, chart: 6, funnel: 6, top: 4 }
const WIDTHS = [
  { value: '3', label: t('Quarter') },
  { value: '4', label: t('Third') },
  { value: '6', label: t('Half') },
  { value: '8', label: t('Two thirds') },
  { value: '12', label: t('Full width') },
]
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
  return <TimeChart area data={data} series={[{ key: m.key, label: m.label, color: TONE[m.key] ?? 'var(--series-1)' }]} fmt={m.fmt} height={190} />
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
    .slice(0, 7)
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

function FunnelWidget({ w, range, campaigns, open }: WidgetProps & { open: () => void }) {
  const campaign = campaigns.find((c) => c.id === w.campaign_id)
  if (!campaign) return <div className="muted pad-s">{t('This campaign is not available to you any more.')}</div>
  return <FunnelBody campaign={campaign} w={w} range={range} open={open} />
}

function FunnelBody({ campaign, w, range, open }: { campaign: Campaign; w: BoardWidget; range: DateRange; open: () => void }) {
  const f = useFunnel(campaign, range, { streamId: w.stream_id || undefined })
  if (f.error) return <ErrorBox error={f.error} retry={f.reload} />
  if (!f.loaded) return <Skeleton rows={4} />
  return (
    <div className="wfunnel">
      <FunnelSteps compact clicks={f.clicks} steps={f.steps} currency={campaign.currency} />
      <button className="btn small ghost" onClick={open}>
        <Maximize2 size={12} /> {t('Open the full funnel')}
      </button>
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
  const widgets = board.widgets ?? []

  const save = (next: BoardWidget[]) =>
    run(async () => {
      // Shown at once; the server's answer (with ids for new widgets) replaces it.
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
    save(widgets.map((w, j) => (j === i ? { ...w, w: sizes[(at + 1) % sizes.length] } : w)))
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
  const scopeName = (w: BoardWidget) => (w.campaign_id ? (campaigns.find((c) => c.id === w.campaign_id)?.name ?? `#${w.campaign_id}`) : t('All campaigns'))
  const funnelCampaign = funnelFor && campaigns.find((c) => c.id === funnelFor.campaign_id)

  return (
    <div className="board-wrap">
      <div className="board-bar">
        {renaming !== null ? (
          <input className="input board-rename" autoFocus value={renaming} maxLength={64} onChange={(e) => setRenaming(e.target.value)} onBlur={rename} onKeyDown={(e) => (e.key === 'Enter' ? rename() : e.key === 'Escape' ? setRenaming(null) : undefined)} />
        ) : (
          <span className="muted small">
            {widgets.length === 0 ? t('Empty dashboard') : arranging ? t('Arrange mode: move, resize, change or remove the widgets.') : t('Your own dashboard — only you see it.')}
          </span>
        )}
        <span className="grow" />
        <button className="btn" onClick={add}>
          <Plus size={14} /> {t('Add widget')}
        </button>
        {widgets.length > 0 && (
          <button className={'btn' + (arranging ? ' primary' : '')} onClick={() => setArranging((a) => !a)} title={t('Move, resize and remove widgets')}>
            <LayoutGrid size={14} /> {arranging ? t('Done') : t('Arrange')}
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
        <div className={'board' + (arranging ? ' arranging' : '')}>
          {widgets.map((w, i) => {
            const props: WidgetProps = { w, range, tick, campaigns }
            let body: ReactNode
            if (camps.loading && !camps.data) body = <Skeleton rows={3} />
            else if (w.type === 'chart') body = <ChartWidget {...props} />
            else if (w.type === 'funnel') body = <FunnelWidget {...props} open={() => setFunnelFor(w)} />
            else if (w.type === 'top') body = <TopWidget {...props} />
            else body = <StatWidget {...props} />
            const filters = scopeOf(w)
            return (
              <section key={w.id || i} className={'wdg wdg-' + w.type} style={{ gridColumn: `span ${w.w}` }}>
                <header className="wdg-head">
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
                  ) : (
                    w.type !== 'funnel' && (
                      <Link className="wdg-link" to={'/reports' + buildSearch({ range, group: w.type === 'top' ? w.dim || 'country' : undefined, filters })} title={t('Open in Reports')}>
                        <BarChart3 size={13} />
                      </Link>
                    )
                  )}
                </header>
                <div className="wdg-body">{body}</div>
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
            save(editing.index < 0 ? [...widgets, w] : widgets.map((x, j) => (j === editing.index ? w : x)))
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

function WidgetEditor({ draft, isNew, campaigns, onClose, onSave }: { draft: BoardWidget; isNew: boolean; campaigns: Campaign[]; onClose: () => void; onSave: (w: BoardWidget) => void }) {
  const [w, setW] = useState<BoardWidget>(draft)
  const [error, setError] = useState('')
  const set = (p: Partial<BoardWidget>) => setW((x) => ({ ...x, ...p }))
  const type = TYPES.find((x) => x.value === w.type) ?? TYPES[0]
  const submit = () => {
    if (w.type === 'funnel' && !w.campaign_id) return setError(t('Choose the campaign whose funnel to show.'))
    onSave({ ...w, title: (w.title ?? '').trim(), metric: w.type === 'stat' || w.type === 'chart' ? w.metric || 'clicks' : '', dim: w.type === 'top' ? w.dim || 'country' : '', stream_id: w.type === 'funnel' && w.campaign_id === draft.campaign_id ? w.stream_id : 0 })
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
      <Field label={t('Campaign')} help={w.type === 'funnel' ? t('A funnel always belongs to one campaign.') : t('Leave on “All campaigns” for everything you can see.')}>
        <Select
          value={w.campaign_id ? String(w.campaign_id) : ''}
          onChange={(v) => set({ campaign_id: v ? Number(v) : 0 })}
          placeholder={w.type === 'funnel' ? t('Choose a campaign…') : undefined}
          options={[...(w.type === 'funnel' ? [] : [{ value: '', label: t('All campaigns') }]), ...campaigns.map((c) => ({ value: String(c.id), label: c.name }))]}
        />
      </Field>
      <div className="row gap">
        <Field label={t('Title')} className="grow" help={t('Optional: the widget names itself otherwise.')}>
          <input className="input" value={w.title ?? ''} maxLength={80} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field label={t('Width')} style={{ width: 150 }}>
          <Select value={String(w.w)} onChange={(v) => set({ w: Number(v) })} options={WIDTHS} />
        </Field>
      </div>
    </Modal>
  )
}
