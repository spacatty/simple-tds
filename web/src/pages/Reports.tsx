import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Download, RefreshCw } from 'lucide-react'
import { get } from '../api'
import { useLoad, useMeta } from '../hooks'
import type { Campaign, ConvKey, Domain, ReportRow, Stream } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { DateRangePicker, useDateRange } from '../components/DateRangePicker'
import { CategoryBarChart, TimeChart } from '../components/charts'
import { Card, Empty, ErrorBox, PageHeader, Segmented, Select } from '../components/ui'
import { COUNTRY_SELECT_OPTIONS } from '../components/CountrySelect'
import { METRICS, loadReport, sumRows } from '../reports'
import type { MetricKey } from '../reports'
import { csvEscape, downloadText, fmtInt, humanize, ymd } from '../format'
import { countryName, flag } from '../countries'

const GROUP_LABELS: Record<string, string> = {
  total: 'Total',
  day: 'Day',
  hour: 'Hour',
  campaign: 'Campaign',
  stream: 'Stream',
  domain: 'Domain',
  country: 'Country',
  region: 'Region',
  city: 'City',
  isp: 'ISP',
  device_type: 'Device type',
  os: 'OS',
  browser: 'Browser',
  lang: 'Language',
  ref_domain: 'Referrer domain',
  keyword: 'Keyword',
  action: 'Action (clicks only)',
  bot_reason: 'Bot reason (clicks only)',
  key: 'Conversion key (conversions only)',
  type: 'Conversion type (conversions only)',
}
const GROUP_SECTIONS: [string, string[]][] = [
  ['Time', ['total', 'day', 'hour']],
  ['Routing', ['campaign', 'stream', 'domain', 'action']],
  ['Geo', ['country', 'region', 'city', 'isp', 'lang']],
  ['Device', ['device_type', 'os', 'browser']],
  ['Source', ['ref_domain', 'keyword', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5']],
  ['Quality', ['bot_reason']],
  ['Conversions', ['key', 'type']],
]

export default function Reports() {
  const meta = useMeta()
  const [range, setRange] = useDateRange('7d')
  const [group, setGroup] = useState('day')
  const [search] = useSearchParams()
  const [f, setF] = useState({ campaign_id: search.get('campaign_id') ?? '', country: '', domain: '', bots: '' })
  const [metric, setMetric] = useState<MetricKey>('clicks')

  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])
  const domains = useLoad(() => get<Domain[]>('domains'), [])
  const streams = useLoad(() => get<Stream[]>('streams'), [])
  const keys = useLoad(() => get<ConvKey[]>('conversion-keys'), [])

  const rep = useLoad(() => loadReport(group, range, f), [group, range.from, range.to, f.campaign_id, f.country, f.domain, f.bots])
  const rows = useMemo(() => rep.data ?? [], [rep.data])
  const timeline = group === 'day' || group === 'hour'

  const groupOptions = useMemo(() => {
    const avail = new Set(meta.report_groups)
    const out: { value: string; label: string; group: string }[] = []
    const seen = new Set<string>()
    for (const [section, items] of GROUP_SECTIONS) {
      for (const g of items) {
        if (avail.has(g)) {
          out.push({ value: g, label: GROUP_LABELS[g] ?? humanize(g), group: section })
          seen.add(g)
        }
      }
    }
    for (const g of meta.report_groups) if (!seen.has(g)) out.push({ value: g, label: GROUP_LABELS[g] ?? humanize(g), group: 'Other' })
    return out
  }, [meta.report_groups])

  /** Plain-text name of a group key (ids resolved to names). */
  const keyText = (k: string): string => {
    switch (group) {
      case 'campaign':
        return k === '0' ? '(no campaign)' : camps.data?.find((c) => String(c.id) === k)?.name ?? `#${k} (deleted)`
      case 'stream':
        return k === '0' ? '(no stream)' : streams.data?.find((s) => String(s.id) === k)?.name ?? `#${k} (deleted)`
      case 'key':
        return keys.data?.find((x) => String(x.id) === k)?.name ?? `#${k} (deleted)`
      case 'country':
        return k ? `${countryName(k)} (${k})` : '(unknown)'
      case 'total':
        return 'Total'
      default:
        return k === '' ? '(empty)' : k
    }
  }

  const total = useMemo(() => sumRows(rows), [rows])
  const typeCols = useMemo(() => meta.conversion_types.filter((t) => t !== 'rejected' && rows.some((r) => (r.types?.[t] ?? 0) > 0)), [meta.conversion_types, rows])

  const columns: Column<ReportRow>[] = [
    {
      key: 'key',
      title: GROUP_LABELS[group]?.replace(/ \(.*\)$/, '') ?? humanize(group),
      sort: (r) => (timeline ? r.key : keyText(r.key).toLowerCase()),
      render: (r) => (
        <span className={timeline ? 'mono nowrap' : ''}>
          {group === 'country' && r.key ? flag(r.key) + ' ' : ''}
          {keyText(r.key)}
        </span>
      ),
    },
    ...METRICS.map(
      (m): Column<ReportRow> => ({
        key: m.key,
        title: m.label,
        headTitle: m.title,
        align: 'right',
        sort: (r) => r[m.key],
        className: m.key === metric ? 'col-active' : '',
        render: (r) => <span className={m.key === 'profit' || m.key === 'roi' ? (r[m.key] > 0 ? 'pos' : r[m.key] < 0 ? 'neg' : '') : ''}>{m.fmt(r[m.key])}</span>,
      }),
    ),
    ...typeCols.map((t): Column<ReportRow> => ({ key: 't_' + t, title: humanize(t), headTitle: `Conversions of type “${t}”`, align: 'right', sort: (r) => r.types?.[t] ?? 0, render: (r) => fmtInt(r.types?.[t] ?? 0) })),
  ]

  const metricDef = METRICS.find((m) => m.key === metric) ?? METRICS[0]
  const chartData = useMemo(() => {
    if (timeline) return rows.map((r) => ({ key: r.key, [metric]: r[metric] }))
    return [...rows]
      .sort((a, b) => b[metric] - a[metric])
      .slice(0, 20)
      .map((r) => ({ key: keyText(r.key), [metric]: r[metric] }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, metric, timeline, camps.data, streams.data, keys.data])

  const exportCSV = () => {
    const head = [group, ...METRICS.map((m) => m.key), ...typeCols]
    const lines = [head.map(csvEscape).join(',')]
    for (const r of rows) lines.push([keyText(r.key), ...METRICS.map((m) => r[m.key]), ...typeCols.map((t) => r.types?.[t] ?? 0)].map(csvEscape).join(','))
    lines.push(['TOTAL', ...METRICS.map((m) => total[m.key]), ...typeCols.map((t) => rows.reduce((n, r) => n + (r.types?.[t] ?? 0), 0))].map(csvEscape).join(','))
    downloadText(`report-${group}-${ymd(new Date(range.from * 1000))}_${ymd(new Date(range.to * 1000 - 1000))}.csv`, '﻿' + lines.join('\r\n'), 'text/csv')
  }

  return (
    <div className="page">
      <PageHeader title="Reports">
        <DateRangePicker value={range} onChange={setRange} />
        <button className="btn" onClick={() => rep.reload()} title="Refresh">
          <RefreshCw size={14} className={rep.loading ? 'spin' : ''} />
        </button>
      </PageHeader>

      <div className="toolbar wrap">
        <label className="inline-field">
          <span className="muted">Group by</span>
          <Select value={group} onChange={setGroup} options={groupOptions} />
        </label>
        <Select value={f.campaign_id} onChange={(campaign_id) => setF({ ...f, campaign_id })} placeholder="All campaigns" options={(camps.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))} />
        <Select value={f.country} onChange={(country) => setF({ ...f, country })} placeholder="All countries" options={COUNTRY_SELECT_OPTIONS} />
        <Select value={f.domain} onChange={(domain) => setF({ ...f, domain })} placeholder="All domains" options={(domains.data ?? []).map((d) => ({ value: d.name, label: d.name }))} />
        <Segmented
          small
          value={f.bots}
          onChange={(bots) => setF({ ...f, bots })}
          options={[
            { value: '', label: 'All traffic' },
            { value: 'exclude', label: 'No bots' },
            { value: 'only', label: 'Bots only' },
          ]}
        />
        <span className="grow" />
        <button className="btn" disabled={!rows.length} onClick={exportCSV}>
          <Download size={14} /> Export CSV
        </button>
      </div>

      <ErrorBox error={rep.error} retry={rep.reload} />

      {group !== 'total' && (
        <Card
          title={`${metricDef.label} by ${(GROUP_LABELS[group] ?? humanize(group)).replace(/ \(.*\)$/, '').toLowerCase()}${!timeline && rows.length > 20 ? ' — top 20' : ''}`}
          actions={<Select value={metric} onChange={(m) => setMetric(m as MetricKey)} options={METRICS.map((m) => ({ value: m.key, label: m.title ? `${m.label} — ${m.title}` : m.label }))} />}
        >
          {rows.length === 0 ? (
            <div className="muted pad">{rep.loading ? 'Loading…' : 'No data for this selection.'}</div>
          ) : timeline ? (
            <TimeChart data={chartData} series={[{ key: metric, label: metricDef.label, color: 'var(--series-1)' }]} fmt={metricDef.fmt} height={220} />
          ) : (
            <CategoryBarChart data={chartData} series={{ key: metric, label: metricDef.label, color: 'var(--series-1)' }} fmt={metricDef.fmt} height={220} />
          )}
        </Card>
      )}

      <div className="card">
        <DataTable
          key={group}
          columns={columns}
          rows={rep.data ? rows : undefined}
          rowKey={(r) => r.key}
          loading={rep.loading}
          maxHeight="calc(100vh - 220px)"
          empty={<Empty title="No data for this selection">Try a wider date range or fewer filters.</Empty>}
          footer={
            <tr>
              <td>Total · {fmtInt(rows.length)} rows</td>
              {METRICS.map((m) => (
                <td key={m.key} style={{ textAlign: 'right' }}>
                  {m.fmt(total[m.key])}
                </td>
              ))}
              {typeCols.map((t) => (
                <td key={t} style={{ textAlign: 'right' }}>
                  {fmtInt(rows.reduce((n, r) => n + (r.types?.[t] ?? 0), 0))}
                </td>
              ))}
            </tr>
          }
        />
      </div>
    </div>
  )
}
