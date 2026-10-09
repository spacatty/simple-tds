import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, Bot, LayoutDashboard, Plus, RefreshCw } from 'lucide-react'
import { get, post } from '../api'
import { useInterval, useIsAdmin, useLoad, useMeta } from '../hooks'
import type { Board, Campaign, ReportRow, Row, Stream, SystemInfo } from '../types'
import { DateRangePicker, rangeBuckets, useDateRange } from '../components/DateRangePicker'
import type { DateRange } from '../components/DateRangePicker'
import { BarList, Spark, TimeChart } from '../components/charts'
import { Badge, Card, ErrorBox, Field, Modal, PageHeader, Skeleton, Toggle, toast, useBusy } from '../components/ui'
import { emptyRow, loadReport, rangeParams } from '../reports'
import { buildSearch, paramFor } from '../filters'
import { fmtDateTime, fmtInt, fmtMoney, fmtPct, humanize, ratioPct } from '../format'
import { Browser, BrowserIcon, Country, Device, DeviceIcon, Flag, Os, OsIcon } from '../components/icons'
import { t, tn, ts } from '../i18n'
import { errMsg } from '../api'
import { BoardView } from './Boards'
import { systemProblems } from './Status'

interface DashData {
  total: ReportRow
  timeline: ReportRow[]
  campaigns: ReportRow[]
  countries: ReportRow[]
  devices: ReportRow[]
  systems: ReportRow[]
  browsers: ReportRow[]
}

export default function Dashboard() {
  const [range, setRange] = useDateRange()
  const [sp, setSp] = useSearchParams()
  const boards = useLoad(() => get<Board[] | null>('dashboards'), [])
  const [tick, setTick] = useState(0)
  const [creating, setCreating] = useState(false)
  // The open dashboard lives in the address (?board=3), so reload and Back keep it.
  const boardId = Number(sp.get('board')) || 0
  const list = boards.data ?? []
  const board = list.find((b) => b.id === boardId)
  const open = (id: number) => setSp(id ? { board: String(id) } : {}, { replace: false })
  // A dashboard that is gone (deleted in another tab) falls back to the overview.
  useEffect(() => {
    if (boardId && boards.data && !board) setSp({}, { replace: true })
  }, [boardId, boards.data, board, setSp])
  const setBoard = (b: Board) => boards.setData((all) => (all ?? []).map((x) => (x.id === b.id ? b : x)))

  return (
    <div className="page">
      <PageHeader title={t('Dashboard')}>
        <DateRangePicker value={range} onChange={setRange} />
        <button className="btn" onClick={() => setTick((n) => n + 1)} title={t('Refresh')} aria-label={t('Refresh')}>
          <RefreshCw size={14} />
        </button>
      </PageHeader>

      <div className="dash-tabs" role="tablist">
        <button role="tab" aria-selected={!board} className={!board ? 'active' : ''} onClick={() => open(0)}>
          <LayoutDashboard size={14} /> {t('Overview')}
        </button>
        {list.map((b) => (
          <button key={b.id} role="tab" aria-selected={b.id === board?.id} className={b.id === board?.id ? 'active' : ''} onClick={() => open(b.id)} title={b.name}>
            <span className="ellipsis">{b.name}</span>
          </button>
        ))}
        <button className="dash-tab-add" onClick={() => setCreating(true)} title={t('Compose a dashboard of your own from numbers, charts, top lists and funnels')}>
          <Plus size={14} /> {t('New dashboard')}
        </button>
      </div>
      <ErrorBox error={boards.error} retry={boards.reload} />

      {board ? (
        <BoardView
          key={board.id}
          board={board}
          range={range}
          setRange={setRange}
          tick={tick}
          onChange={setBoard}
          onDeleted={() => {
            boards.setData((all) => (all ?? []).filter((x) => x.id !== board.id))
            open(0)
          }}
        />
      ) : (
        <Overview range={range} tick={tick} />
      )}

      {creating && (
        <CreateBoard
          onClose={() => setCreating(false)}
          onCreated={(b) => {
            boards.setData((all) => [...(all ?? []), b])
            setCreating(false)
            open(b.id)
          }}
        />
      )}
    </div>
  )
}

function CreateBoard({ onClose, onCreated }: { onClose: () => void; onCreated: (b: Board) => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const submit = () =>
    run(async () => {
      setError('')
      try {
        const b = await post<Board>('dashboards', { name, widgets: [] })
        toast.ok(t('Dashboard created'))
        onCreated(b)
      } catch (e) {
        setError(errMsg(e))
      }
    })
  return (
    <Modal
      title={t('New dashboard')}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={submit}>
            {t('Create')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) submit()
        }}
      >
        <Field label={t('Name')} help={t('A dashboard of your own: add numbers, charts and top lists, and pin funnels from any campaign. Only you see it.')}>
          <input className="input" autoFocus value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. Morning check')} />
        </Field>
        {error && <div className="field-error">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

/** The built-in dashboard: everything the viewer can see, for the period. */
function Overview({ range, tick }: { range: DateRange; tick: number }) {
  const buckets = useMemo(() => rangeBuckets(range), [range])

  const rep = useLoad<DashData>(async () => {
    const [total, timeline, campaigns, countries, devices, systems, browsers] = await Promise.all([
      loadReport('total', range),
      loadReport(buckets.group, range),
      loadReport('campaign', range),
      loadReport('country', range),
      loadReport('device_type', range),
      loadReport('os', range),
      loadReport('browser', range),
    ])
    return { total: total[0] ?? emptyRow('total'), timeline, campaigns, countries, devices, systems, browsers }
  }, [range.from, range.to, tick])

  const names = useLoad(() => get<Campaign[]>('campaigns'), [])
  const isAdmin = useIsAdmin()
  const sys = useLoad(() => (isAdmin ? get<SystemInfo>('system') : Promise.resolve(undefined)), [isAdmin])
  useInterval(() => sys.reload(), 30000, isAdmin)
  const problems = systemProblems(sys.data)

  const series = useMemo(() => {
    const byKey = new Map((rep.data?.timeline ?? []).map((r) => [r.key, r]))
    return buckets.keys.map((k) => {
      const r = byKey.get(k)
      return { key: k, clicks: r?.clicks ?? 0, uniques: r?.uniques ?? 0, bots: r?.bots ?? 0, conversions: r?.conversions ?? 0 }
    })
  }, [rep.data, buckets])

  const tot = rep.data?.total
  const meta = useMeta()
  /** A top list: its rows link to the click log filtered by that value. */
  const top = (rows: ReportRow[], dim: string, label: (key: string) => ReactNode, extra: (r: ReportRow) => string) => {
    const param = paramFor(dim, meta.report_filters ?? [])
    return [...rows]
      .sort((a, b) => b.clicks - a.clicks)
      .slice(0, 6)
      .map((r) => ({
        key: r.key || '-',
        label: param ? (
          <Link className="top-link" to={'/clicks' + buildSearch({ range, filters: { [param]: r.key } })} title={t('Show these clicks')}>
            {label(r.key)}
          </Link>
        ) : (
          label(r.key)
        ),
        value: r.clicks,
        extra: extra(r),
      }))
  }
  const share = (r: ReportRow) => ratioPct(r.clicks, tot?.clicks ?? 0)
  const conv = (r: ReportRow) => t('{n} conv', { n: fmtInt(r.conversions) })
  const campName = (id: string) => names.data?.find((c) => String(c.id) === id)?.name ?? (id === '0' ? t('No campaign') : `#${id}`)

  const spark = (key: 'clicks' | 'conversions') => series.map((p) => p[key])
  const sign = (v: number) => (v > 0 ? ' pos' : v < 0 ? ' neg' : '')

  return (
    <>
      {/* Admins hear about trouble here; the details live on System → Status. */}
      {isAdmin && problems.length > 0 && (
        <Link to="/status" className={'dash-alert ' + (problems.some((p) => p.level === 'err') ? 'err' : 'warn')}>
          <AlertTriangle size={15} />
          <span className="grow">{problems[0].text}{problems.length > 1 ? ' ' + tn(problems.length - 1, '(+{n} more)', '(+{n} more)') : ''}</span>
          <b>{t('Open status')}</b>
        </Link>
      )}
      <ErrorBox error={rep.error} retry={rep.reload} />

      <section className="score">
        <div className="score-block m-traffic">
          <header>{t('Traffic')}</header>
          <div className="score-hero">
            {tot ? <b>{fmtInt(tot.clicks)}</b> : <Skeleton rows={1} height={30} />}
            <span>{t('clicks@@unit')}</span>
            {tot && <Spark values={spark('clicks')} color="var(--series-1)" />}
          </div>
          <dl>
            <div>
              <dt>{t('Uniques')}</dt>
              <dd>
                {tot ? fmtInt(tot.uniques) : '·'} <small>{tot ? ratioPct(tot.uniques, tot.clicks) : ''}</small>
              </dd>
            </div>
            <div>
              <dt>{t('Bots')}</dt>
              <dd className={tot && tot.bots > 0 ? 'tone-warn' : ''}>
                {tot ? ratioPct(tot.bots, tot.clicks) : '·'} <small>{tot ? fmtInt(tot.bots) : ''}</small>
              </dd>
            </div>
          </dl>
        </div>
        <div className="score-block m-conv">
          <header>{t('Conversions')}</header>
          <div className="score-hero">
            {tot ? <b>{fmtInt(tot.conversions)}</b> : <Skeleton rows={1} height={30} />}
            <span>{t('conversions@@unit')}</span>
            {tot && <Spark values={spark('conversions')} color="var(--series-3)" />}
          </div>
          <dl>
            <div>
              <dt>CR</dt>
              <dd className={tot && tot.cr > 0 ? 'tone-accent' : ''}>{tot ? fmtPct(tot.cr) : '·'}</dd>
            </div>
            <div>
              <dt>{t('Rejected')}</dt>
              <dd>{tot ? fmtInt(tot.rejected) : '·'}</dd>
            </div>
            <div>
              <dt title={t('Revenue per non-bot click')}>EPC</dt>
              <dd>{tot ? tot.epc.toFixed(4) : '·'}</dd>
            </div>
          </dl>
        </div>
        <div className="score-block m-money">
          <header>{t('Money')}</header>
          <div className="score-hero">
            {tot ? <b className={sign(tot.profit)}>{fmtMoney(tot.profit)}</b> : <Skeleton rows={1} height={30} />}
            <span>{t('profit@@unit')}</span>
          </div>
          <dl>
            <div>
              <dt>{t('Revenue')}</dt>
              <dd>{tot ? fmtMoney(tot.revenue) : '·'}</dd>
            </div>
            <div>
              <dt>{t('Cost')}</dt>
              <dd>{tot ? fmtMoney(tot.cost) : '·'}</dd>
            </div>
            <div>
              <dt>ROI</dt>
              <dd className={tot && tot.cost > 0 ? sign(tot.roi) : ''}>{tot && tot.cost > 0 ? fmtPct(tot.roi, 1) : '—'}</dd>
            </div>
          </dl>
        </div>
      </section>

      <div className="grid-2">
        <Card title={buckets.group === 'hour' ? t('Clicks by hour') : t('Clicks by day')}>
          {rep.data ? (
            <TimeChart
              data={series}
              series={[
                { key: 'clicks', label: t('Clicks'), color: 'var(--series-1)' },
                { key: 'bots', label: t('Bots'), color: 'var(--series-2)' },
              ]}
            />
          ) : (
            <Skeleton rows={6} />
          )}
        </Card>
        <Card title={buckets.group === 'hour' ? t('Conversions by hour') : t('Conversions by day')}>
          {rep.data ? <TimeChart area data={series} series={[{ key: 'conversions', label: t('Conversions'), color: 'var(--series-3)' }]} /> : <Skeleton rows={6} />}
        </Card>
      </div>

      <RecentClicks range={range} campaigns={names.data ?? []} />

      <div className="dash-tops">
        <Card title={t('Campaigns')} actions={<Link to={'/reports' + buildSearch({ range, group: 'campaign' })}>{t('Report')}</Link>}>
          {rep.data ? <BarList items={top(rep.data.campaigns, 'campaign', campName, conv)} /> : <Skeleton rows={5} />}
        </Card>
        <Card title={t('Countries')} actions={<Link to={'/reports' + buildSearch({ range, group: 'country' })}>{t('Report')}</Link>}>
          {rep.data ? <BarList items={top(rep.data.countries, 'country', (k) => (k ? <Country code={k} /> : t('Unknown')), conv)} /> : <Skeleton rows={5} />}
        </Card>
        <Card title={t('Devices')} actions={<Link to={'/reports' + buildSearch({ range, group: 'device_type' })}>{t('Report')}</Link>}>
          {rep.data ? <BarList items={top(rep.data.devices, 'device_type', (k) => <Device type={k || 'unknown'} />, share)} /> : <Skeleton rows={5} />}
        </Card>
        <Card title={t('Operating systems')} actions={<Link to={'/reports' + buildSearch({ range, group: 'os' })}>{t('Report')}</Link>}>
          {rep.data ? <BarList items={top(rep.data.systems, 'os', (k) => (k ? <Os os={k} /> : t('Unknown')), share)} /> : <Skeleton rows={5} />}
        </Card>
        <Card title={t('Browsers')} actions={<Link to={'/reports' + buildSearch({ range, group: 'browser' })}>{t('Report')}</Link>}>
          {rep.data ? <BarList items={top(rep.data.browsers, 'browser', (k) => (k ? <Browser browser={k} /> : t('Unknown')), share)} /> : <Skeleton rows={5} />}
        </Card>
      </div>
    </>
  )
}

const RECENT = 10
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

/** The latest requests of the period with what happened to each: a live view for debugging. */
function RecentClicks({ range, campaigns }: { range: DateRange; campaigns: Campaign[] }) {
  const nav = useNavigate()
  const meta = useMeta()
  const [live, setLive] = useState(true)
  const res = useLoad(() => get<{ rows: Row[] | null; total: number }>('clicks', { ...rangeParams(range), limit: RECENT, offset: 0 }), [range.from, range.to])
  const streams = useLoad(() => get<Stream[]>('streams'), [])
  useInterval(() => res.reload(), 5000, live)

  const rows = res.data?.rows ?? []
  const campName = (id: unknown) => campaigns.find((c) => c.id === Number(id))?.name ?? (Number(id) ? `#${id}` : '—')
  const streamName = (id: unknown) => streams.data?.find((x) => x.id === Number(id))?.name ?? (Number(id) ? `#${id}` : '—')
  const clicks = (filters: Record<string, string | number>, extra?: Record<string, string>) => '/clicks' + buildSearch({ range, filters, extra })
  /** A cell value that opens the click log filtered by it. */
  const by = (dim: string, value: string, body: ReactNode, title: string) => {
    const param = paramFor(dim, meta.report_filters ?? [])
    if (!param || !value) return body
    return (
      <Link className="top-link" to={clicks({ [param]: value })} title={title} onClick={(e) => e.stopPropagation()}>
        {body}
      </Link>
    )
  }

  return (
    <Card
      title={
        <>
          {t('Latest requests')}
          {res.data && <span className="muted small"> · {t('{n} in this period', { n: fmtInt(res.data.total) })}</span>}
        </>
      }
      pad={false}
      actions={
        <>
          <Toggle checked={live} onChange={setLive} label={t('Live')} title={t('Refresh every 5 seconds')} />
          <Link to={clicks({})}>{t('Full log')}</Link>
        </>
      }
    >
      <ErrorBox error={res.error} retry={res.reload} />
      {!res.data ? (
        !res.error && (
          <div className="card-body">
            <Skeleton rows={4} />
          </div>
        )
      ) : rows.length === 0 ? (
        <div className="muted pad">{t('No requests in this period yet. Send a visitor to a campaign link and it shows up here within seconds.')}</div>
      ) : (
        <div className="table-wrap recent">
          <table className="table">
            <thead>
              <tr>
                <th>{t('Time')}</th>
                <th>{t('Campaign · stream')}</th>
                <th>{t('Result')}</th>
                <th className="c-opt">IP</th>
                <th>{t('Country')}</th>
                <th>{t('Device')}</th>
                <th>{t('Referrer')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const cc = str(r.country)
                const os = str(r.os)
                const dev = str(r.device_type)
                return (
                  <tr key={str(r.click_id) || str(r.ts) + str(r.ip)} className="clickable" title={t('Open this click in the log')} onClick={() => nav(clicks({}, { click_id: str(r.click_id) }))}>
                    <td className="nowrap mono">{fmtDateTime(r.ts).slice(11)}</td>
                    <td>
                      <span className="ellipsis recent-route">
                        {campName(r.campaign_id)} <span className="muted">› {streamName(r.stream_id)}</span>
                      </span>
                    </td>
                    <td>
                      <span className="row gap-s nowrap">
                        <Badge tone={truthy(r.is_bot) ? 'neutral' : 'info'}>{ts(humanize(str(r.action) || 'none'))}</Badge>
                        {truthy(r.is_bot) && (
                          <Badge tone="err" title={str(r.bot_reason)}>
                            <Bot size={12} /> <span className="ellipsis">{str(r.bot_reason) || t('bot')}</span>
                          </Badge>
                        )}
                        {truthy(r.is_dc) && <Badge tone="warn">{t('DC')}</Badge>}
                        {truthy(r.is_unique) && !truthy(r.is_bot) && <Badge tone="ok">{t('unique')}</Badge>}
                      </span>
                    </td>
                    <td className="c-opt">
                      <Link className="mono" to={clicks({}, { ip: str(r.ip) })} title={t('Every click from this IP')} onClick={(e) => e.stopPropagation()}>
                        {str(r.ip)}
                      </Link>
                    </td>
                    <td>
                      {cc ? (
                        by(
                          'country',
                          cc,
                          <span className="with-icon">
                            <Flag code={cc} />
                            {cc}
                            {r.city ? <span className="c-opt ellipsis"> · {str(r.city)}</span> : null}
                          </span>,
                          t('Clicks from this country'),
                        )
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <span className="with-icon">
                        {dev && by('device_type', dev, <DeviceIcon type={dev} title={humanize(dev)} />, t('Clicks from {device} devices', { device: dev }))}
                        {os && by('os', os, <OsIcon os={os} title={os} />, t('Clicks from {name}', { name: os }))}
                        {str(r.browser) && by('browser', str(r.browser), <BrowserIcon browser={str(r.browser)} title={str(r.browser)} />, t('Clicks from {name}', { name: str(r.browser) }))}
                        {!dev && !os && !r.browser && <span className="muted">—</span>}
                      </span>
                    </td>
                    <td>
                      {str(r.ref_domain) || str(r.referer) ? (
                        by('ref_domain', str(r.ref_domain), <span className="ellipsis recent-ref">{str(r.ref_domain) || str(r.referer)}</span>, str(r.referer) || t('Clicks from this referrer'))
                      ) : (
                        <span className="muted">{t('direct')}</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
