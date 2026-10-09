import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ChevronRight, CornerDownRight, Download, MousePointerClick, RefreshCw, X } from 'lucide-react'
import { get } from '../api'
import { useLoad, useMeta } from '../hooks'
import type { Campaign, ConvKey, ReportRow, Stream } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { DateRangePicker, currentRange, rememberRange } from '../components/DateRangePicker'
import type { DateRange } from '../components/DateRangePicker'
import { CategoryBarChart, TimeChart } from '../components/charts'
import { Card, Empty, ErrorBox, FilterBar, FilterField, PageHeader, Segmented, Select } from '../components/ui'
import { METRICS, loadReport, sumRows } from '../reports'
import type { MetricKey } from '../reports'
import { CLICK_ONLY, CONV_ONLY, bucketRange, buildSearch, dimLabel, filterParams, paramFor, parseFilters, rangeFromSearch, writeRange } from '../filters'
import type { Crumb } from '../filters'
import { csvEscape, downloadText, fmtInt, humanize, ymd } from '../format'
import { countryName } from '../countries'
import { dimIcon } from '../components/icons'
import { t, tn, ts, tx } from '../i18n'

const GROUP_SECTIONS: [string, string[]][] = [
  [t('Time'), ['total', 'day', 'hour']],
  [t('Routing'), ['campaign', 'stream', 'domain', 'action']],
  [t('Geo'), ['country', 'region', 'city', 'isp', 'lang']],
  [t('Device'), ['device_type', 'os', 'browser']],
  [t('Source'), ['ref_domain', 'keyword', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5']],
  [t('Quality'), ['bot_reason']],
  [t('Conversions'), ['key', 'type']],
]
const clicksOnly = (name: string) => t('{name} (clicks only)', { name })
const convOnly = (name: string) => t('{name} (conversions only)', { name })
const GROUP_NOTE: Record<string, (name: string) => string> = { action: clicksOnly, bot_reason: clicksOnly, key: convOnly, type: convOnly }

// The order in which "drill into" is offered; the first applicable one is the suggested next step.
const DRILL_ORDER = ['campaign', 'stream', 'country', 'device_type', 'os', 'browser', 'day', 'hour', 'region', 'city', 'isp', 'lang', 'ref_domain', 'domain', 'keyword', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5', 'action', 'bot_reason', 'key', 'type']

export default function Reports() {
  const meta = useMeta()
  const [sp, setSp] = useSearchParams()
  const spKey = sp.toString()
  const filterable = useMemo(() => meta.report_filters ?? [], [meta.report_filters])
  const [metric, setMetric] = useState<MetricKey>('clicks')

  // Everything that defines the report lives in the URL: shareable, and Back undoes a drill step.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const range = useMemo(() => rangeFromSearch(sp, currentRange('7d')), [spKey])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const filters = useMemo(() => parseFilters(sp), [spKey])
  const group = meta.report_groups.includes(sp.get('group') ?? '') ? (sp.get('group') as string) : 'day'
  const timeline = group === 'day' || group === 'hour'

  const update = (fn: (n: URLSearchParams) => void, replace = false) => {
    const n = new URLSearchParams(sp)
    fn(n)
    setSp(n, { replace })
  }
  const setRange = (r: DateRange) => {
    rememberRange(r)
    update((n) => writeRange(n, r))
  }

  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])
  const streams = useLoad(() => get<Stream[]>('streams'), [])
  const keys = useLoad(() => get<ConvKey[]>('conversion-keys'), [])

  const apiFilters = useMemo(() => filterParams(filters), [filters])
  const rep = useLoad(() => loadReport(group, range, apiFilters), [group, range.from, range.to, JSON.stringify(apiFilters)])
  const rows = useMemo(() => rep.data ?? [], [rep.data])

  const groupOptions = useMemo(() => {
    const avail = new Set(meta.report_groups)
    const out: { value: string; label: string; group: string }[] = []
    const seen = new Set<string>()
    for (const [section, items] of GROUP_SECTIONS) {
      for (const g of items) {
        if (avail.has(g)) {
          out.push({ value: g, label: GROUP_NOTE[g]?.(dimLabel(g)) ?? dimLabel(g), group: section })
          seen.add(g)
        }
      }
    }
    for (const g of meta.report_groups) if (!seen.has(g)) out.push({ value: g, label: dimLabel(g), group: t('Other') })
    return out
  }, [meta.report_groups])

  /** Plain-text name of a value of a dimension (ids resolved to names). */
  const valueText = (dim: string, k: string): string => {
    switch (dim) {
      case 'campaign':
        return k === '0' ? t('(no campaign)') : camps.data?.find((c) => String(c.id) === k)?.name ?? `#${k}`
      case 'stream':
        return k === '0' ? t('(no stream)') : streams.data?.find((s) => String(s.id) === k)?.name ?? `#${k}`
      case 'key':
        return k === '0' ? t('(no key)') : keys.data?.find((x) => String(x.id) === k)?.name ?? `#${k}`
      case 'country':
        return k ? `${countryName(k)} (${k})` : t('(unknown)')
      case 'total':
        return t('Total')
      case 'action':
      case 'type':
        return k === '' ? t('(empty)') : ts(k)
      default:
        return k === '' ? t('(empty)') : k
    }
  }

  const total = useMemo(() => sumRows(rows), [rows])
  // Built-in types first, then whatever funnel stages the selection contains.
  const typeCols = useMemo(() => {
    const seen = new Set(rows.flatMap((r) => Object.keys(r.types ?? {})))
    const builtin = meta.conversion_types.filter((t) => seen.has(t))
    return [...builtin, ...[...seen].filter((t) => !builtin.includes(t)).sort()]
  }, [meta.conversion_types, rows])

  // ---- drill-down ----
  const rowParam = timeline ? 'time' : paramFor(group, filterable)
  const drillTargets = useMemo(() => {
    const used = new Set(filters.crumbs.map((c) => c.dim))
    const convSide = CONV_ONLY.includes(group) || filters.crumbs.some((c) => CONV_ONLY.includes(c.dim))
    const clickSide = CLICK_ONLY.includes(group) || filters.crumbs.some((c) => CLICK_ONLY.includes(c.dim))
    return DRILL_ORDER.filter((g) => {
      if (g === group || used.has(g) || !meta.report_groups.includes(g)) return false
      if (timeline && (g === 'day' || (g === 'hour' && group === 'hour'))) return false
      if (convSide && CLICK_ONLY.includes(g)) return false
      if (clickSide && CONV_ONLY.includes(g)) return false
      return true
    })
  }, [filters, group, timeline, meta.report_groups])

  /** Narrows the report to one row and regroups it. */
  const drill = (r: ReportRow, next: string) =>
    update((n) => {
      if (timeline) {
        const b = bucketRange(r.key)
        if (b) writeRange(n, b)
      } else if (rowParam) {
        n.delete(rowParam)
        n.set(rowParam, r.key)
      }
      n.set('group', next)
    })

  const clicksSearch = (extra?: { param: string; value: string }, rowRange?: DateRange | null) => {
    const f: Record<string, string> = {}
    for (const c of filters.crumbs) if (c.param !== 'key_id' && c.dim !== 'type') f[c.param] = c.value
    if (extra && extra.param !== 'key_id' && extra.param !== 'f.type') f[extra.param] = extra.value
    return buildSearch({ range: rowRange ?? range, filters: f, bots: filters.bots })
  }

  const crumbText = (c: Crumb) => valueText(c.dim, c.value)

  const columns: Column<ReportRow>[] = [
    {
      key: 'key',
      title: dimLabel(group),
      sort: (r) => (timeline ? r.key : valueText(group, r.key).toLowerCase()),
      render: (r) => (
        <span className={timeline ? 'mono nowrap' : 'with-icon'}>
          {dimIcon(group, r.key)}
          {valueText(group, r.key)}
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
        render: (r) => <span className={m.key === 'profit' || m.key === 'roi' ? (r[m.key] > 0 ? 'pos' : r[m.key] < 0 ? 'neg' : 'muted') : r[m.key] === 0 ? 'muted' : ''}>{m.fmt(r[m.key])}</span>,
      }),
    ),
    ...typeCols.map((ty): Column<ReportRow> => ({ key: 't_' + ty, title: ts(humanize(ty)), headTitle: t('Conversions of type “{type}”', { type: ty }), align: 'right', sort: (r) => r.types?.[ty] ?? 0, render: (r) => fmtInt(r.types?.[ty] ?? 0) })),
  ]

  const metricDef = METRICS.find((m) => m.key === metric) ?? METRICS[0]
  const chartVars = { metric: metricDef.label, dim: dimLabel(group).toLowerCase() }
  const chartData = useMemo(() => {
    if (timeline) return rows.map((r) => ({ key: r.key, [metric]: r[metric] }))
    return [...rows]
      .sort((a, b) => b[metric] - a[metric])
      .slice(0, 20)
      .map((r) => ({ key: valueText(group, r.key), [metric]: r[metric] }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, metric, timeline, group, camps.data, streams.data, keys.data])

  const exportCSV = () => {
    const head = [group, ...METRICS.map((m) => m.key), ...typeCols]
    const lines = [head.map(csvEscape).join(',')]
    for (const r of rows) lines.push([valueText(group, r.key), ...METRICS.map((m) => r[m.key]), ...typeCols.map((t) => r.types?.[t] ?? 0)].map(csvEscape).join(','))
    lines.push(['TOTAL', ...METRICS.map((m) => total[m.key]), ...typeCols.map((t) => rows.reduce((n, r) => n + (r.types?.[t] ?? 0), 0))].map(csvEscape).join(','))
    downloadText(`report-${group}-${ymd(new Date(range.from * 1000))}_${ymd(new Date(range.to * 1000 - 1000))}.csv`, '﻿' + lines.join('\r\n'), 'text/csv')
  }

  const campaignId = filters.crumbs.find((c) => c.dim === 'campaign')?.value ?? ''
  const canDrill = group !== 'total' && (timeline || !!rowParam) && drillTargets.length > 0

  return (
    <div className="page">
      <PageHeader title={t('Breakdown')} sub={t('Click any row to drill into it.')}>
        <Link className="btn" to={'/clicks' + clicksSearch()} title={t('Open the click log with the same filters')}>
          <MousePointerClick size={14} /> {t('View clicks')}
        </Link>
        <button className="btn" disabled={!rows.length} onClick={exportCSV}>
          <Download size={14} /> {t('Export CSV')}
        </button>
        <DateRangePicker value={range} onChange={setRange} />
        <button className="btn" onClick={() => rep.reload()} title={t('Refresh')} aria-label={t('Refresh')}>
          <RefreshCw size={14} className={rep.loading ? 'spin' : ''} />
        </button>
      </PageHeader>

      <FilterBar
        onReset={
          filters.crumbs.length > 0 || filters.bots
            ? () =>
                update((n) => {
                  filters.crumbs.forEach((c) => n.delete(c.param))
                  n.delete('bots')
                })
            : undefined
        }
        chips={
          filters.crumbs.length > 0 && (
            <>
              <span className="muted">{t('Filtered by')}</span>
              {filters.crumbs.map((c, i) => (
                <span className="crumb-wrap" key={c.param}>
                  {i > 0 && <ChevronRight size={13} className="muted" />}
                  <span className="crumb">
                    <span className="muted">{dimLabel(c.dim)}:</span> <b>{crumbText(c)}</b>
                    <button aria-label={t('Remove filter {name}', { name: dimLabel(c.dim) })} title={t('Remove this filter')} onClick={() => update((n) => n.delete(c.param))}>
                      <X size={12} />
                    </button>
                  </span>
                </span>
              ))}
            </>
          )
        }
      >
        <FilterField label={t('Group by')}>
          <Select value={group} onChange={(g) => update((n) => n.set('group', g))} options={groupOptions} />
        </FilterField>
        <FilterField label={t('Campaign')} active={!!campaignId}>
          <Select
            value={campaignId}
            onChange={(v) =>
              update((n) => {
                n.delete('campaign_id')
                n.delete('stream_id') // a stream belongs to one campaign
                if (v) n.set('campaign_id', v)
              })
            }
            placeholder={t('All campaigns')}
            options={(camps.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
          />
        </FilterField>
        <FilterField label={t('Traffic')} size="auto">
          <Segmented
            small
            className="bots"
            value={filters.bots}
            onChange={(bots) =>
              update((n) => {
                if (bots) n.set('bots', bots)
                else n.delete('bots')
              })
            }
            options={[
              { value: '', label: t('All traffic') },
              { value: 'exclude', label: t('No bots') },
              { value: 'only', label: t('Bots only') },
            ]}
          />
        </FilterField>
      </FilterBar>

      <ErrorBox error={rep.error} retry={rep.reload} />

      {group !== 'total' && (
        <Card
          title={!timeline && rows.length > 20 ? t('{metric} by {dim} — top 20', chartVars) : t('{metric} by {dim}', chartVars)}
          actions={<Select value={metric} onChange={(m) => setMetric(m as MetricKey)} options={METRICS.map((m) => ({ value: m.key, label: m.title ? `${m.label} — ${m.title}` : m.label }))} />}
        >
          {rows.length === 0 ? (
            <div className="muted pad">{rep.loading ? t('Loading…') : t('No data for this selection.')}</div>
          ) : timeline ? (
            <TimeChart data={chartData} series={[{ key: metric, label: metricDef.label, color: 'var(--series-1)' }]} fmt={metricDef.fmt} height={200} />
          ) : (
            <CategoryBarChart data={chartData} series={{ key: metric, label: metricDef.label, color: 'var(--series-1)' }} fmt={metricDef.fmt} height={200} />
          )}
        </Card>
      )}

      <div className="card">
        <DataTable
          key={group + '|' + spKey}
          columns={columns}
          rows={rep.data ? rows : undefined}
          rowKey={(r) => r.key}
          loading={rep.loading}
          maxHeight="calc(100vh - 200px)"
          empty={<Empty title={t('No data for this selection')}>{t('Try a wider date range or fewer filters.')}</Empty>}
          expand={
            canDrill
              ? (r) => (
                  <div className="drill">
                    <CornerDownRight size={15} className="muted" />
                    <span>{tx('Drill into {name} by', { name: <b>{valueText(group, r.key)}</b> })}</span>
                    {drillTargets.slice(0, 14).map((g, i) => (
                      <button key={g} className={'btn small' + (i === 0 ? ' primary' : '')} onClick={() => drill(r, g)}>
                        {dimLabel(g)}
                      </button>
                    ))}
                    <span className="grow" />
                    {!CONV_ONLY.includes(group) && (
                      <Link className="btn small" to={'/clicks' + (timeline ? clicksSearch(undefined, bucketRange(r.key)) : clicksSearch(rowParam ? { param: rowParam, value: r.key } : undefined))}>
                        <MousePointerClick size={13} /> {t('Clicks')}
                      </Link>
                    )}
                  </div>
                )
              : undefined
          }
          footer={
            <tr>
              {canDrill && <td />}
              <td>{tn(rows.length, 'Total · {n} row', 'Total · {n} rows', { n: fmtInt(rows.length) })}</td>
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
