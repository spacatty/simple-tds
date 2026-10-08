import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { get } from '../api'
import { useInterval, useIsAdmin, useLoad } from '../hooks'
import type { Campaign, ReportRow, SystemInfo } from '../types'
import { DateRangePicker, rangeBuckets, useDateRange } from '../components/DateRangePicker'
import { BarList, TimeChart } from '../components/charts'
import { Card, ErrorBox, PageHeader, Skeleton } from '../components/ui'
import { emptyRow, loadReport } from '../reports'
import { fmtAgo, fmtInt, fmtMoney, fmtPct, humanize, ratioPct } from '../format'
import { countryLabel } from '../countries'

interface DashData {
  total: ReportRow
  timeline: ReportRow[]
  campaigns: ReportRow[]
  countries: ReportRow[]
  devices: ReportRow[]
}

export default function Dashboard() {
  const [range, setRange] = useDateRange()
  const buckets = useMemo(() => rangeBuckets(range), [range])

  const rep = useLoad<DashData>(async () => {
    const [total, timeline, campaigns, countries, devices] = await Promise.all([
      loadReport('total', range),
      loadReport(buckets.group, range),
      loadReport('campaign', range),
      loadReport('country', range),
      loadReport('device_type', range),
    ])
    return { total: total[0] ?? emptyRow('total'), timeline, campaigns, countries, devices }
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

  const t = rep.data?.total
  const campName = (id: string) => names.data?.find((c) => String(c.id) === id)?.name ?? (id === '0' ? 'No campaign' : `#${id}`)

  const tiles: { label: string; value: string; sub?: string; tone?: string }[] = t
    ? [
        { label: 'Clicks', value: fmtInt(t.clicks) },
        { label: 'Uniques', value: fmtInt(t.uniques), sub: ratioPct(t.uniques, t.clicks) + ' of clicks' },
        { label: 'Bots', value: ratioPct(t.bots, t.clicks), sub: fmtInt(t.bots) + ' clicks' },
        { label: 'Conversions', value: fmtInt(t.conversions), sub: t.rejected ? fmtInt(t.rejected) + ' rejected' : undefined },
        { label: 'CR', value: fmtPct(t.cr) },
        { label: 'Revenue', value: fmtMoney(t.revenue) },
        { label: 'Cost', value: fmtMoney(t.cost) },
        { label: 'Profit', value: fmtMoney(t.profit), tone: t.profit > 0 ? 'pos' : t.profit < 0 ? 'neg' : '' },
        { label: 'ROI', value: t.cost > 0 ? fmtPct(t.roi, 1) : '—', tone: t.cost > 0 ? (t.roi > 0 ? 'pos' : t.roi < 0 ? 'neg' : '') : '' },
      ]
    : []

  return (
    <div className="page">
      <PageHeader title="Dashboard">
        <DateRangePicker value={range} onChange={setRange} />
        <button className="btn" onClick={() => rep.reload()} title="Refresh">
          <RefreshCw size={14} className={rep.loading ? 'spin' : ''} />
        </button>
      </PageHeader>

      {/* Non-admins get no engine stats from api/system: no strip for them. */}
      {isAdmin && <HealthStrip sys={sys.data} error={sys.error} />}
      <ErrorBox error={rep.error} retry={rep.reload} />

      <div className="tiles">
        {!t
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
        <Card title={`Clicks by ${buckets.group}`}>
          {rep.data ? (
            <TimeChart
              data={series}
              series={[
                { key: 'clicks', label: 'Clicks', color: 'var(--series-1)' },
                { key: 'bots', label: 'Bots', color: 'var(--series-2)' },
              ]}
            />
          ) : (
            <Skeleton rows={6} />
          )}
        </Card>
        <Card title={`Conversions by ${buckets.group}`}>
          {rep.data ? <TimeChart area data={series} series={[{ key: 'conversions', label: 'Conversions', color: 'var(--series-3)' }]} /> : <Skeleton rows={6} />}
        </Card>
      </div>

      <div className="grid-3">
        <Card title="Top campaigns" actions={<Link to="/reports">All reports</Link>}>
          {rep.data ? (
            <BarList
              items={rep.data.campaigns.slice(0, 8).map((r) => ({ key: r.key, label: campName(r.key), value: r.clicks, extra: `${fmtInt(r.conversions)} conv` }))}
            />
          ) : (
            <Skeleton rows={5} />
          )}
        </Card>
        <Card title="Top countries">
          {rep.data ? (
            <BarList items={rep.data.countries.slice(0, 8).map((r) => ({ key: r.key || '-', label: r.key ? countryLabel(r.key) : 'Unknown', value: r.clicks, extra: `${fmtInt(r.conversions)} conv` }))} />
          ) : (
            <Skeleton rows={5} />
          )}
        </Card>
        <Card title="Devices">
          {rep.data ? (
            <BarList
              items={rep.data.devices.map((r) => ({ key: r.key || '-', label: humanize(r.key || 'unknown'), value: r.clicks, extra: ratioPct(r.clicks, t?.clicks ?? 0) }))}
            />
          ) : (
            <Skeleton rows={5} />
          )}
        </Card>
      </div>
    </div>
  )
}

function HealthStrip({ sys, error }: { sys?: SystemInfo; error: string }) {
  if (error && !sys) return <ErrorBox error={'System status unavailable: ' + error} />
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
      {item('PostgreSQL', h.postgres === 'ok', h.postgres === 'ok' ? 'OK' : 'Error', h.postgres)}
      {item('ClickHouse', h.clickhouse === 'ok', h.clickhouse === 'ok' ? 'OK' : 'Error', h.clickhouse)}
      {item('Write queue', stats.queue_len < 10000, fmtInt(stats.queue_len), 'Clicks waiting to be written to ClickHouse', true)}
      {item('Dropped clicks', stats.clicks_dropped === 0, fmtInt(stats.clicks_dropped), 'Clicks lost because the write queue was full (since start)')}
      {item(
        'Geo DB',
        geoOK,
        geoOK ? 'Loaded · ' + fmtAgo(geo.city.updated) : geo.city.loaded ? 'No ASN database' : 'Not loaded',
        geo.last_error || 'City and ASN databases',
        geo.city.loaded,
      )}
      {item('Written', true, fmtInt(stats.clicks_written), 'Clicks written since start')}
      <div className="health-item">
        <span className="muted">Active</span>
        <b>
          {fmtInt(stats.campaigns)} campaigns · {fmtInt(stats.domains)} domains
        </b>
      </div>
    </div>
  )
}
