import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, MousePointerClick } from 'lucide-react'
import { useLoad } from '../hooks'
import type { Campaign, ReportRow, Stream } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { DateRangePicker } from '../components/DateRangePicker'
import type { DateRange } from '../components/DateRangePicker'
import { CategoryBarChart, TimeChart } from '../components/charts'
import { Drawer, Empty, ErrorBox, Select, Skeleton } from '../components/ui'
import { METRICS, emptyRow, loadReport } from '../reports'
import type { MetricKey } from '../reports'
import { buildSearch, dimLabel } from '../filters'
import { fmtInt, fmtMoney, fmtPct, ratioPct } from '../format'
import { countryName, flag } from '../countries'

const GROUPS = ['day', 'hour', 'country', 'device_type', 'os', 'browser', 'ref_domain', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'bot_reason', 'action']

/** Drill-down for one stream without leaving the campaign. */
export default function StreamStats({ campaign, stream, range, setRange, onClose }: { campaign: Campaign; stream: Stream; range: DateRange; setRange: (r: DateRange) => void; onClose: () => void }) {
  const [group, setGroup] = useState('day')
  const [metric, setMetric] = useState<MetricKey>('clicks')
  const scope = { campaign_id: campaign.id, stream_id: stream.id }

  const total = useLoad(async () => (await loadReport('total', range, scope))[0] ?? emptyRow('total'), [stream.id, range.from, range.to])
  const rep = useLoad(() => loadReport(group, range, scope), [stream.id, group, range.from, range.to])
  const rows = useMemo(() => rep.data ?? [], [rep.data])
  const timeline = group === 'day' || group === 'hour'
  const t = total.data

  const keyText = (k: string) => (group === 'country' ? (k ? `${flag(k)} ${countryName(k)}` : '(unknown)') : k === '' ? '(empty)' : k)
  const metricDef = METRICS.find((m) => m.key === metric) ?? METRICS[0]
  const chartData = useMemo(() => {
    if (timeline) return rows.map((r) => ({ key: r.key, [metric]: r[metric] }))
    return [...rows]
      .sort((a, b) => b[metric] - a[metric])
      .slice(0, 15)
      .map((r) => ({ key: group === 'country' ? r.key || '?' : r.key || '(empty)', [metric]: r[metric] }))
  }, [rows, metric, timeline, group])

  const columns: Column<ReportRow>[] = [
    { key: 'key', title: dimLabel(group), sort: (r) => r.key, render: (r) => <span className={timeline ? 'mono nowrap' : ''}>{keyText(r.key)}</span> },
    ...METRICS.filter((m) => m.key !== 'rejected' && m.key !== 'epc').map(
      (m): Column<ReportRow> => ({ key: m.key, title: m.label, headTitle: m.title, align: 'right', sort: (r) => r[m.key], className: m.key === metric ? 'col-active' : '', render: (r) => <span className={r[m.key] === 0 ? 'muted' : ''}>{m.fmt(r[m.key])}</span> }),
    ),
  ]

  const kpis: [string, string][] = t
    ? [
        ['Clicks', fmtInt(t.clicks)],
        ['Uniques', fmtInt(t.uniques)],
        ['Bots', ratioPct(t.bots, t.clicks)],
        ['Conversions', fmtInt(t.conversions)],
        ['CR', fmtPct(t.cr)],
        ['Revenue', fmtMoney(t.revenue)],
        ['Cost', fmtMoney(t.cost)],
        ['Profit', fmtMoney(t.profit)],
      ]
    : []

  const filters = { campaign_id: campaign.id, stream_id: stream.id }

  return (
    <Drawer
      size="xl"
      onClose={onClose}
      title={
        <>
          <BarChart3 size={16} /> {stream.name} <span className="muted small">· {campaign.name}</span>
        </>
      }
      footer={
        <>
          <Link className="btn" to={'/clicks' + buildSearch({ range, filters })}>
            <MousePointerClick size={14} /> View clicks
          </Link>
          <Link className="btn" to={'/reports' + buildSearch({ range, group, filters })}>
            <BarChart3 size={14} /> Open in Reports
          </Link>
          <span className="grow" />
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="toolbar wrap" style={{ marginBottom: 12 }}>
        <DateRangePicker value={range} onChange={setRange} />
      </div>
      <ErrorBox error={total.error || rep.error} retry={() => (total.reload(), rep.reload())} />
      <div className="kpis">
        {!t ? (
          <Skeleton rows={2} />
        ) : (
          kpis.map(([l, v]) => (
            <div className="kpi" key={l}>
              <span>{l}</span>
              <b>{v}</b>
            </div>
          ))
        )}
      </div>

      <div className="toolbar wrap" style={{ margin: '14px 0 10px' }}>
        <label className="inline-field">
          <span className="muted">Group by</span>
          <Select value={group} onChange={setGroup} options={GROUPS.map((g) => ({ value: g, label: dimLabel(g) }))} />
        </label>
        <label className="inline-field">
          <span className="muted">Chart</span>
          <Select value={metric} onChange={(m) => setMetric(m as MetricKey)} options={METRICS.map((m) => ({ value: m.key, label: m.label }))} />
        </label>
      </div>

      {rows.length > 0 &&
        (timeline ? (
          <TimeChart data={chartData} series={[{ key: metric, label: metricDef.label, color: 'var(--series-1)' }]} fmt={metricDef.fmt} height={180} />
        ) : (
          <CategoryBarChart data={chartData} series={{ key: metric, label: metricDef.label, color: 'var(--series-1)' }} fmt={metricDef.fmt} height={180} />
        ))}

      <div className="card" style={{ marginTop: 12 }}>
        <DataTable key={group} columns={columns} rows={rep.data ? rows : undefined} rowKey={(r) => r.key} loading={rep.loading} defaultSort={timeline ? undefined : { key: 'clicks', dir: 'desc' }} empty={<Empty title="No traffic on this stream in the selected period" />} />
      </div>
    </Drawer>
  )
}
