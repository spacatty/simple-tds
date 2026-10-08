import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Bot, RefreshCw } from 'lucide-react'
import { get } from '../api'
import { useInterval, useIsAdmin, useLoad, useMeta } from '../hooks'
import type { Campaign, ReportRow, Row, Stream, SystemInfo } from '../types'
import { DateRangePicker, rangeBuckets, useDateRange } from '../components/DateRangePicker'
import type { DateRange } from '../components/DateRangePicker'
import { BarList, TimeChart } from '../components/charts'
import { Badge, Card, ErrorBox, PageHeader, Skeleton, Toggle } from '../components/ui'
import { emptyRow, loadReport, rangeParams } from '../reports'
import { buildSearch, paramFor } from '../filters'
import { fmtAgo, fmtDateTime, fmtInt, fmtMoney, fmtPct, humanize, ratioPct } from '../format'
import { Browser, BrowserIcon, Country, Device, DeviceIcon, Flag, Os, OsIcon } from '../components/icons'
import { t, tn, ts } from '../i18n'

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
  }, [range.from, range.to])

  const names = useLoad(() => get<Campaign[]>('campaigns'), [])
  const isAdmin = useIsAdmin()
  const sys = useLoad(() => (isAdmin ? get<SystemInfo>('system') : Promise.resolve(undefined)), [isAdmin])
  useInterval(() => sys.reload(), 15000, isAdmin)

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

  const tiles: { label: string; value: string; sub?: string; tone?: string }[] = tot
    ? [
        { label: t('Clicks'), value: fmtInt(tot.clicks) },
        { label: t('Uniques'), value: fmtInt(tot.uniques), sub: t('{pct} of clicks', { pct: ratioPct(tot.uniques, tot.clicks) }) },
        { label: t('Bots'), value: ratioPct(tot.bots, tot.clicks), sub: tn(tot.bots, '{n} click', '{n} clicks', { n: fmtInt(tot.bots) }) },
        { label: t('Conversions'), value: fmtInt(tot.conversions), sub: tot.rejected ? t('{n} rejected', { n: fmtInt(tot.rejected) }) : undefined },
        { label: 'CR', value: fmtPct(tot.cr) },
        { label: t('Revenue'), value: fmtMoney(tot.revenue) },
        { label: t('Cost'), value: fmtMoney(tot.cost) },
        { label: t('Profit'), value: fmtMoney(tot.profit), tone: tot.profit > 0 ? 'pos' : tot.profit < 0 ? 'neg' : '' },
        { label: 'ROI', value: tot.cost > 0 ? fmtPct(tot.roi, 1) : '—', tone: tot.cost > 0 ? (tot.roi > 0 ? 'pos' : tot.roi < 0 ? 'neg' : '') : '' },
      ]
    : []

  return (
    <div className="page">
      <PageHeader title={t('Dashboard')}>
        <DateRangePicker value={range} onChange={setRange} />
        <button className="btn" onClick={() => rep.reload()} title={t('Refresh')} aria-label={t('Refresh')}>
          <RefreshCw size={14} className={rep.loading ? 'spin' : ''} />
        </button>
      </PageHeader>

      {/* Non-admins get no engine stats from api/system: no strip for them. */}
      {isAdmin && <HealthStrip sys={sys.data} error={sys.error} />}
      <ErrorBox error={rep.error} retry={rep.reload} />

      <div className="tiles nine">
        {!tot
          ? Array.from({ length: 9 }).map((_, i) => (
              <div className="tile" key={i}>
                <Skeleton rows={2} />
              </div>
            ))
          : tiles.map((x) => (
              <div className="tile" key={x.label}>
                <div className="tile-label">{x.label}</div>
                <div className={'tile-value ' + (x.tone ?? '')}>{x.value}</div>
                <div className="tile-sub">{x.sub ?? ' '}</div>
              </div>
            ))}
      </div>

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
    </div>
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
                        {dev && by('device_type', dev, <DeviceIcon type={dev} />, t('Clicks from {device} devices', { device: dev }))}
                        {os && by('os', os, <span className="with-icon"><OsIcon os={os} />{os}</span>, t('Clicks from {name}', { name: os }))}
                        {str(r.browser) && by('browser', str(r.browser), <span className="with-icon"><BrowserIcon browser={str(r.browser)} /><span className="c-opt">{str(r.browser)}</span></span>, t('Clicks from {name}', { name: str(r.browser) }))}
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

function HealthStrip({ sys, error }: { sys?: SystemInfo; error: string }) {
  if (error && !sys) return <ErrorBox error={t('System status unavailable: {error}', { error })} />
  if (!sys) return <div className="health" />
  if (!sys.stats || !sys.geo) return null
  const stats = sys.stats
  const geo = sys.geo
  const item = (label: string, ok: boolean, text: string, title?: string, warn?: boolean) => (
    <div className="health-item" title={title}>
      <span className={'dot ' + (ok ? 'ok' : warn ? 'warn' : 'err')} />
      <span className="muted">{label}</span>
      <b>{text}</b>
    </div>
  )
  const h = sys.health
  const geoOK = geo.city.loaded && geo.asn.loaded
  return (
    <div className="health">
      {item('PostgreSQL', h.postgres === 'ok', h.postgres === 'ok' ? 'OK' : t('Error'), ts(h.postgres))}
      {item('ClickHouse', h.clickhouse === 'ok', h.clickhouse === 'ok' ? 'OK' : t('Error'), ts(h.clickhouse))}
      {item(t('Write queue'), stats.queue_len < 10000, fmtInt(stats.queue_len), t('Clicks waiting to be written to ClickHouse'), true)}
      {item(t('Dropped clicks'), stats.clicks_dropped === 0, fmtInt(stats.clicks_dropped), t('Clicks lost because the write queue was full (since start)'))}
      {item(
        t('Geo DB'),
        geoOK,
        geoOK ? t('Loaded · {ago}', { ago: fmtAgo(geo.city.updated) }) : geo.city.loaded ? t('No ASN database') : t('Not loaded'),
        ts(geo.last_error) || t('City and ASN databases'),
        geo.city.loaded,
      )}
      {item(t('Written'), true, fmtInt(stats.clicks_written), t('Clicks written since start'))}
      <div className="health-item">
        <span className="muted">{t('Active')}</span>
        <b>
          {tn(stats.campaigns, '{n} campaign', '{n} campaigns', { n: fmtInt(stats.campaigns) })} · {tn(stats.domains, '{n} domain', '{n} domains', { n: fmtInt(stats.domains) })}
        </b>
      </div>
    </div>
  )
}
