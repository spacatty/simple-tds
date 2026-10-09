import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDown, MousePointerClick, RefreshCw, Settings2, Star, Target } from 'lucide-react'
import { get } from '../api'
import { canRead, useLoad, useMeta } from '../hooks'
import type { Campaign, FunnelRow, Stream } from '../types'
import { DateRangePicker, rangeBuckets } from '../components/DateRangePicker'
import type { DateRange } from '../components/DateRangePicker'
import { TimeChart } from '../components/charts'
import { Drawer, ErrorBox, Notice, Segmented, Select, Skeleton } from '../components/ui'
import { loadReport, rangeParams } from '../reports'
import { buildSearch, dimLabel } from '../filters'
import { fmtInt, fmtMoney, fmtPct, fmtSpan, ratioPct } from '../format'
import { countryName } from '../countries'
import { dimIcon, FunnelIcon } from '../components/icons'
import { PinMenu } from '../components/PinMenu'
import { t, tx } from '../i18n'

/** One bar of the funnel picture. */
export interface FunnelStepView {
  key: string
  name: string
  goal?: boolean
  public?: boolean
  reached: number
  events?: number
  revenue?: number
  median?: number
  /** Where the number leads: the clicks that got this far, the ones that stopped before, the events. */
  links?: { reached?: string; lost?: string; events?: string }
}

type StreamRef = { id: number; name: string }

const BREAKDOWNS = ['stream', 'country', 'device_type', 'os', 'browser', 'domain', 'ref_domain', 'keyword', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5']

const share = (part: number, total: number) => (total > 0 ? (part / total) * 100 : 0)

/**
 * A campaign's funnel for a period, as a list of steps. With stages it is the
 * campaign's own funnel; without them, the plain path from click to conversion.
 */
export function useFunnel(campaign: Campaign, range: DateRange, opts: { streamId?: number; strict?: boolean; bots?: string } = {}) {
  const stages = useMemo(() => campaign.stages ?? [], [campaign.stages])
  const keys = stages.map((s) => s.key).join(',')
  const bots = opts.bots ?? 'exclude'
  const scope = { campaign_id: campaign.id, stream_id: opts.streamId }
  const res = useLoad(async () => {
    if (stages.length > 0) {
      const r = await get<{ rows: FunnelRow[] | null }>('reports/funnel', { ...scope, group: 'total', strict: opts.strict ? '1' : '', bots, ...rangeParams(range) })
      return { row: r.rows?.[0], plain: undefined }
    }
    return { row: undefined, plain: (await loadReport('total', range, scope))[0] }
  }, [campaign.id, keys, opts.streamId, opts.strict, bots, range.from, range.to])

  const view = useMemo(() => {
    const clicksLink = (extra: Record<string, string>) => '/clicks' + buildSearch({ range, filters: scope, bots, extra })
    const row = res.data?.row
    const plain = res.data?.plain
    if (stages.length === 0) {
      // No funnel configured: what the tracker knows anyway.
      const clicks = plain?.clicks ?? 0
      const humans = Math.max(0, clicks - (plain?.bots ?? 0))
      const steps: FunnelStepView[] = [
        { key: '#humans', name: t('Not bots'), reached: humans, links: { reached: '/clicks' + buildSearch({ range, filters: scope, bots: 'exclude' }) } },
        { key: '#conv', name: t('Conversions'), goal: true, reached: Math.min(humans, plain?.conversions ?? 0), events: plain?.conversions ?? 0, revenue: plain?.revenue ?? 0, links: { events: '/conversions?' + new URLSearchParams({ campaign_id: String(campaign.id) }).toString() } },
      ]
      return { clicks, cost: plain?.cost ?? 0, steps, clicksLink: '/clicks' + buildSearch({ range, filters: scope }) }
    }
    const clicks = row?.clicks ?? 0
    const steps = stages.map((s, i): FunnelStepView => {
      // Right after the stages change the report on screen still has the old ones.
      const st = row?.steps?.[i] ?? { reached: 0, events: 0, revenue: 0 }
      const lost: Record<string, string> = { not_reached: s.key }
      if (i > 0) lost.reached = stages[i - 1].key
      return {
        key: s.key,
        name: s.name || s.key,
        goal: s.goal,
        public: s.public,
        reached: st.reached,
        events: st.events,
        revenue: st.revenue,
        median: st.median_sec,
        links: { reached: clicksLink({ reached: s.key }), lost: clicksLink(lost), events: '/conversions?' + new URLSearchParams({ campaign_id: String(campaign.id), type: s.key }).toString() },
      }
    })
    return { clicks, cost: row?.cost ?? 0, steps, clicksLink: clicksLink({}) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res.data, stages, range.from, range.to, bots, opts.streamId, campaign.id])

  return { ...view, stages, loading: res.loading, loaded: !!res.data, error: res.error, reload: res.reload }
}

/** The funnel itself: one bar per step, and what was lost between them. */
export function FunnelSteps({ clicks, steps, currency, clicksLink, compact }: { clicks: number; steps: FunnelStepView[]; currency?: string; clicksLink?: string; compact?: boolean }) {
  // The step that loses the largest share of what reached it.
  let worst = -1
  let worstRate = 0
  steps.forEach((s, i) => {
    const prev = i === 0 ? clicks : steps[i - 1].reached
    const rate = prev > 0 ? 1 - s.reached / prev : 0
    if (prev > 0 && rate > worstRate) {
      worstRate = rate
      worst = i
    }
  })
  const num = (n: number, to?: string) =>
    to ? (
      <Link className="fnl-num" to={to}>
        {fmtInt(n)}
      </Link>
    ) : (
      <span className="fnl-num">{fmtInt(n)}</span>
    )
  return (
    <div className={'fnl' + (compact ? ' compact' : '')}>
      <div className="fnl-step top">
        <span className="fnl-ix">
          <MousePointerClick size={12} />
        </span>
        <div className="fnl-name">
          <b className="ellipsis">{t('Clicks')}</b>
        </div>
        <div className="fnl-track">
          <div className="fnl-bar" style={{ width: clicks > 0 ? '100%' : 0 }} />
        </div>
        {num(clicks, clicksLink)}
        <span className="fnl-pct">{clicks > 0 ? '100%' : '—'}</span>
      </div>
      {steps.map((s, i) => {
        const prev = i === 0 ? clicks : steps[i - 1].reached
        const lost = Math.max(0, prev - s.reached)
        const meta: ReactNode[] = []
        if (!compact && s.events !== undefined && s.events !== s.reached)
          meta.push(
            s.links?.events ? (
              <Link key="e" to={s.links.events} title={t('Events received for this stage, repeats included. Opens them in the conversion log.')}>
                {t('{n} events', { n: fmtInt(s.events) })}
              </Link>
            ) : (
              <span key="e">{t('{n} events', { n: fmtInt(s.events) })}</span>
            ),
          )
        if (s.revenue) meta.push(<span key="r" className="tone-good">{fmtMoney(s.revenue, currency)}</span>)
        if (!compact && s.reached > 0 && s.median) meta.push(<span key="m" title={t('Median time from the click to its first event of this stage')}>{t('{span} from click', { span: fmtSpan(s.median) })}</span>)
        return (
          <div key={s.key} className="fnl-group">
            <div className={'fnl-drop' + (i === worst && lost > 0 ? ' worst' : '')}>
              <ArrowDown size={12} />
              <span>
                <b>{ratioPct(s.reached, prev)}</b> {t('continue')}
              </span>
              {lost > 0 && (
                <span className="fnl-lost">
                  {s.links?.lost ? (
                    <Link to={s.links.lost} title={t('Clicks that got to the previous step and no further. Opens them in the click log.')}>
                      {t('−{n} lost', { n: fmtInt(lost) })}
                    </Link>
                  ) : (
                    t('−{n} lost', { n: fmtInt(lost) })
                  )}
                </span>
              )}
              {i === worst && lost > 0 && steps.length > 1 && <span className="tag err">{t('biggest drop')}</span>}
            </div>
            <div className={'fnl-step' + (s.goal ? ' goal' : '')}>
              <span className="fnl-ix">{s.goal ? <Star size={11} /> : i + 1}</span>
              <div className="fnl-name" title={s.key.startsWith('#') ? undefined : s.key}>
                <b className="ellipsis">{s.name}</b>
                {!compact && s.goal && <span className="tag info">{t('goal')}</span>}
                {!compact && s.public && <span className="tag">{t('browser')}</span>}
              </div>
              <div className="fnl-track">
                <div className="fnl-bar" style={{ width: `${Math.min(100, share(s.reached, clicks))}%` }} />
              </div>
              {num(s.reached, s.links?.reached)}
              <span className="fnl-pct" title={t('Share of all clicks of the period')}>
                {ratioPct(s.reached, clicks, clicks > 0 && s.reached / clicks < 0.1 ? 2 : 1)}
              </span>
              {meta.length > 0 && <div className="fnl-meta">{meta}</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Funnel analysis of a campaign, or of one of its streams: the steps, the trend, and a breakdown by any dimension. */
export function FunnelView({ campaign, stream, range, setRange, toolbarEnd }: { campaign: Campaign; stream?: StreamRef; range: DateRange; setRange: (r: DateRange) => void; toolbarEnd?: ReactNode }) {
  const meta = useMeta()
  const [strict, setStrict] = useState('')
  const [bots, setBots] = useState('exclude')
  const groups = BREAKDOWNS.filter((g) => meta.report_groups.includes(g) && !(g === 'stream' && stream))
  const [group, setGroup] = useState(groups[0] ?? 'country')
  const f = useFunnel(campaign, range, { streamId: stream?.id, strict: strict === '1', bots })
  const staged = f.stages.length > 0
  const keys = f.stages.map((s) => s.key).join(',')
  const params = { campaign_id: campaign.id, stream_id: stream?.id, strict, bots, ...rangeParams(range) }
  const bucket = rangeBuckets(range).group

  const trend = useLoad(() => (staged ? get<{ rows: FunnelRow[] | null }>('reports/funnel', { ...params, group: bucket }) : Promise.resolve(undefined)), [campaign.id, stream?.id, keys, strict, bots, bucket, range.from, range.to])
  const split = useLoad(() => (staged ? get<{ rows: FunnelRow[] | null }>('reports/funnel', { ...params, group }) : Promise.resolve(undefined)), [campaign.id, stream?.id, keys, strict, bots, group, range.from, range.to])
  const streams = useLoad(() => (group === 'stream' && staged ? get<Stream[] | null>('streams') : Promise.resolve(null)), [group, staged])

  const goalIx = Math.max(0, f.steps.findIndex((s) => s.goal))
  const goal = f.steps[goalIx]
  const revenue = f.steps.reduce((n, s) => n + (s.revenue ?? 0), 0)
  const profit = revenue - f.cost
  const cur = campaign.currency
  const tiles: { label: string; value: string; sub?: string; tone?: string }[] = [
    { label: bots === 'exclude' && staged ? t('Clicks, no bots') : t('Clicks'), value: fmtInt(f.clicks) },
    { label: t('Reached the goal'), value: fmtInt(goal?.reached ?? 0), sub: goal?.name },
    { label: t('Click → goal'), value: ratioPct(goal?.reached ?? 0, f.clicks, 2), sub: goal?.median && goal.reached > 0 ? t('in {span} (median)', { span: fmtSpan(goal.median) }) : undefined, tone: 'tone-accent' },
    { label: t('Revenue'), value: fmtMoney(revenue, cur), sub: f.clicks > 0 ? t('{value} per click', { value: fmtMoney(revenue / f.clicks) }) : undefined },
    { label: t('Profit'), value: fmtMoney(profit, cur), sub: t('cost {value}', { value: fmtMoney(f.cost) }), tone: profit > 0 ? 'tone-good' : profit < 0 ? 'tone-bad' : '' },
  ]

  const trendData = useMemo(() => (trend.data?.rows ?? []).map((r) => ({ key: r.key, cr: share(r.steps?.[goalIx]?.reached ?? 0, r.clicks), first: share(r.steps?.[0]?.reached ?? 0, r.clicks) })), [trend.data, goalIx])
  const trendSeries = [
    ...(goalIx > 0 ? [{ key: 'first', label: t('Click → {stage}', { stage: f.steps[0]?.name ?? '' }), color: 'var(--series-1)' }] : []),
    { key: 'cr', label: t('Click → {stage}', { stage: goal?.name ?? '' }), color: 'var(--series-3)' },
  ]

  const rows = split.data?.rows ?? []
  // Cells are tinted by how the row does against the best row of the same stage.
  const best = f.stages.map((_, i) => Math.max(0, ...rows.filter((r) => r.clicks >= 5).map((r) => share(r.steps?.[i]?.reached ?? 0, r.clicks))))
  const keyText = (k: string) => {
    if (group === 'stream') return k === '0' ? t('(no stream)') : (streams.data?.find((s) => String(s.id) === k)?.name ?? `#${k}`)
    if (group === 'country') return k ? countryName(k) : t('(unknown)')
    return k === '' ? t('(empty)') : k
  }

  return (
    <div className="fnv">
      <div className="toolbar wrap fnv-bar">
        <DateRangePicker value={range} onChange={setRange} />
        <button className="btn" onClick={() => (f.reload(), trend.reload(), split.reload())} title={t('Refresh')} aria-label={t('Refresh')}>
          <RefreshCw size={14} className={f.loading ? 'spin' : ''} />
        </button>
        {staged && (
          <>
            <Segmented
              small
              value={strict}
              onChange={setStrict}
              options={[
                { value: '', label: t('Any order'), title: t('A click has reached a stage once any event of that stage arrived for it.') },
                { value: '1', label: t('In order'), title: t('In order: a click reaches a stage only after passing every earlier stage first.') },
              ]}
            />
            <Segmented
              small
              value={bots}
              onChange={setBots}
              options={[
                { value: 'exclude', label: t('No bots') },
                { value: '', label: t('All traffic') },
              ]}
            />
          </>
        )}
        <span className="grow" />
        {toolbarEnd}
      </div>

      <ErrorBox error={f.error} retry={f.reload} />
      {!staged && (
        <Notice>
          {canRead(campaign)
            ? tx('This campaign has no funnel stages yet, so this is the plain path from click to conversion. <a>Set up stages</a> to see every step a visitor takes.', { a: (c) => <Link to={`/campaigns/${campaign.id}?tab=funnel`}>{c}</Link> })
            : t('This campaign has no funnel stages, so this is the plain path from click to conversion.')}
        </Notice>
      )}

      <div className="fnv-tiles">
        {tiles.map((x) => (
          <div className="fnv-tile" key={x.label}>
            <span>{x.label}</span>
            {f.loaded ? <b className={x.tone || undefined}>{x.value}</b> : <Skeleton rows={1} height={18} />}
            {x.sub && f.loaded && <small className="ellipsis">{x.sub}</small>}
          </div>
        ))}
      </div>

      <section className="fnv-card">
        <header>
          <h4>{t('Steps')}</h4>
          <span className="muted small">{t('Clicks of the selected period and how far each of them got since — a purchase made days later still counts for the day of its click.')}</span>
        </header>
        {f.loaded ? <FunnelSteps clicks={f.clicks} steps={f.steps} currency={cur} clicksLink={f.clicksLink} /> : <Skeleton rows={5} height={18} />}
        {staged && strict === '1' && <div className="field-help">{t('The numbers open the matching clicks and events in the logs. The logs do not check the order of stages, so with “In order” they can show a few more clicks.')}</div>}
      </section>

      {staged && trendData.filter((d) => d.cr > 0 || d.first > 0).length > 1 && (
        <section className="fnv-card">
          <header>
            <h4>{t('Conversion over time')}</h4>
            <span className="muted small">{bucket === 'hour' ? t('Share of each hour’s clicks that got to the stage.') : t('Share of each day’s clicks that got to the stage.')}</span>
          </header>
          <TimeChart data={trendData} series={trendSeries} fmt={(v) => fmtPct(v, 1)} height={170} />
        </section>
      )}

      {staged && (
        <section className="fnv-card">
          <header>
            <h4>{t('Breakdown')}</h4>
            <span className="muted small grow">{t('Reached each stage, and the share of the row’s clicks. Greener cells convert closer to the best row.')}</span>
            <Select className="input-sm" value={group} onChange={setGroup} options={groups.map((g) => ({ value: g, label: dimLabel(g) }))} />
          </header>
          <ErrorBox error={split.error} retry={split.reload} />
          {!split.data ? (
            !split.error && <Skeleton rows={4} height={16} />
          ) : rows.length === 0 ? (
            <div className="muted pad">{t('No clicks in this period')}</div>
          ) : (
            <div className="table-wrap" style={{ overflowX: 'auto' }}>
              <table className="table fnv-table">
                <thead>
                  <tr>
                    <th>{dimLabel(group)}</th>
                    <th className="r">{t('Clicks')}</th>
                    {f.stages.map((s) => (
                      <th key={s.key} className="r" title={t('{key}: clicks that reached it, and the share of the row’s clicks', { key: s.key })}>
                        {s.name || s.key}
                        {s.goal && ' ★'}
                      </th>
                    ))}
                    <th className="r">{t('Revenue')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 50).map((r) => (
                    <tr key={r.key}>
                      <td>
                        <span className="with-icon">
                          {dimIcon(group, r.key)}
                          <span className="ellipsis">{keyText(r.key)}</span>
                        </span>
                      </td>
                      <td className="r tnum">{fmtInt(r.clicks)}</td>
                      {f.stages.map((s, i) => {
                        const reached = r.steps?.[i]?.reached ?? 0
                        const rate = share(reached, r.clicks)
                        const heat = best[i] > 0 && r.clicks >= 5 ? Math.round((rate / best[i]) * 22) : 0
                        return (
                          <td key={s.key} className="r tnum nowrap" style={heat > 0 ? { background: `color-mix(in srgb, var(--ok) ${heat}%, transparent)` } : undefined}>
                            {fmtInt(reached)} <span className="muted small">{fmtPct(rate, rate > 0 && rate < 10 ? 2 : 1)}</span>
                          </td>
                        )
                      })}
                      <td className="r tnum">{fmtMoney((r.steps ?? []).reduce((n, st) => n + st.revenue, 0), cur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 50 && <div className="field-help">{t('Showing the {shown} rows with the most clicks of {total}.', { shown: 50, total: fmtInt(rows.length) })}</div>}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

/** The funnel of a campaign (or one stream) in a drawer, wherever the campaign is on screen. */
export default function FunnelDrawer({ campaign, stream, range, setRange, onClose, toolbarEnd }: { campaign: Campaign; stream?: StreamRef; range: DateRange; setRange: (r: DateRange) => void; onClose: () => void; toolbarEnd?: ReactNode }) {
  const filters = { campaign_id: campaign.id, stream_id: stream?.id }
  return (
    <Drawer
      size="xl"
      onClose={onClose}
      title={
        <>
          <FunnelIcon size={16} /> {t('Funnel')} <span className="muted small">· {stream ? `${stream.name} · ${campaign.name}` : campaign.name}</span>
        </>
      }
      footer={
        <>
          <Link className="btn" to={'/clicks' + buildSearch({ range, filters })}>
            <MousePointerClick size={14} /> {t('View clicks')}
          </Link>
          <Link className="btn" to={'/conversions?' + new URLSearchParams({ campaign_id: String(campaign.id) }).toString()}>
            <Target size={14} /> {t('Conversions')}
          </Link>
          {canRead(campaign) && (
            <Link className="btn" to={`/campaigns/${campaign.id}?tab=funnel`} onClick={onClose}>
              <Settings2 size={14} /> {t('Funnel stages')}
            </Link>
          )}
          <span className="grow" />
          <button className="btn primary" onClick={onClose}>
            {t('Close')}
          </button>
        </>
      }
    >
      <FunnelView campaign={campaign} stream={stream} range={range} setRange={setRange} toolbarEnd={toolbarEnd ?? <PinMenu widget={{ type: 'funnel', campaign_id: campaign.id, stream_id: stream?.id, title: stream?.name, w: 6 }} />} />
    </Drawer>
  )
}
