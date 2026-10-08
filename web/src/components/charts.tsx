import type { ReactNode } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { fmtCompact, fmtInt } from '../format'
import { t } from '../i18n'

export interface Series {
  key: string
  label: string
  /** CSS colour, normally one of the --series-N variables. */
  color: string
}

interface TipProps {
  active?: boolean
  label?: string | number
  payload?: { dataKey?: string | number; value?: number | string }[]
  series: Series[]
  fmt: (v: number) => string
}

// Values and labels stay in text colours; the swatch carries identity.
function ChartTip({ active, label, payload, series, fmt }: TipProps) {
  if (!active || !payload || !payload.length) return null
  return (
    <div className="chart-tip">
      <div className="chart-tip-label">{label}</div>
      {payload.map((p) => {
        const s = series.find((x) => x.key === p.dataKey)
        return (
          <div className="chart-tip-row" key={String(p.dataKey)}>
            <span className="swatch" style={{ background: s?.color }} />
            <span className="grow">{s?.label ?? String(p.dataKey)}</span>
            <b>{fmt(Number(p.value ?? 0))}</b>
          </div>
        )
      })}
    </div>
  )
}

export function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null
  return (
    <div className="chart-legend">
      {series.map((s) => (
        <span key={s.key}>
          <span className="swatch" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  )
}

/** "2026-01-31 14:00" → "14:00"; "2026-01-31" → "01-31" */
export function shortBucket(k: string): string {
  if (k.length > 10) return k.slice(11)
  return k.length === 10 ? k.slice(5) : k
}

const axisTick = { fontSize: 11, fill: 'var(--text-3)' }
const margin = { top: 8, right: 12, bottom: 0, left: 0 }

export function TimeChart({
  data,
  series,
  height = 200,
  fmt = fmtInt,
  area,
}: {
  data: Record<string, string | number>[]
  series: Series[]
  height?: number
  fmt?: (v: number) => string
  area?: boolean
}) {
  const common = (
    <>
      <CartesianGrid stroke="var(--grid)" vertical={false} />
      <XAxis dataKey="key" tickFormatter={shortBucket} tick={axisTick} tickLine={false} axisLine={{ stroke: 'var(--border)' }} minTickGap={28} />
      <YAxis tickFormatter={fmtCompact} tick={axisTick} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
      <Tooltip content={<ChartTip series={series} fmt={fmt} />} cursor={{ stroke: 'var(--text-3)', strokeWidth: 1 }} isAnimationActive={false} />
    </>
  )
  return (
    <div>
      <Legend series={series} />
      <ResponsiveContainer width="100%" height={height}>
        {area ? (
          <AreaChart data={data} margin={margin}>
            {common}
            {series.map((s) => (
              <Area key={s.key} type="monotone" dataKey={s.key} stroke={s.color} fill={s.color} fillOpacity={0.12} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }} isAnimationActive={false} />
            ))}
          </AreaChart>
        ) : (
          <LineChart data={data} margin={margin}>
            {common}
            {series.map((s) => (
              <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }} isAnimationActive={false} />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

export function CategoryBarChart({
  data,
  series,
  height = 240,
  fmt = fmtInt,
}: {
  data: Record<string, string | number>[]
  series: Series
  height?: number
  fmt?: (v: number) => string
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ ...margin, bottom: 4 }} barCategoryGap="25%">
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="key" tick={axisTick} tickLine={false} axisLine={{ stroke: 'var(--border)' }} interval="preserveStartEnd" minTickGap={8} tickFormatter={(v: string) => (v.length > 14 ? v.slice(0, 13) + '…' : v)} />
        <YAxis tickFormatter={fmtCompact} tick={axisTick} tickLine={false} axisLine={false} width={44} />
        <Tooltip content={<ChartTip series={[series]} fmt={fmt} />} cursor={{ fill: 'var(--hover)' }} isAnimationActive={false} />
        <Bar dataKey={series.key} fill={series.color} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export interface BarItem {
  key: string
  label: ReactNode
  value: number
  extra?: ReactNode
}

/** Ranked horizontal bars in plain HTML: label, bar, value. */
export function BarList({ items, fmt = fmtInt, color = 'var(--series-1)', empty = t('No data for this period') }: { items: BarItem[]; fmt?: (v: number) => string; color?: string; empty?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value))
  if (!items.length) return <div className="muted pad">{empty}</div>
  return (
    <div className="barlist">
      {items.map((it) => (
        <div className="barlist-row" key={it.key} title={typeof it.label === 'string' ? `${it.label}: ${fmt(it.value)}` : undefined}>
          <div className="barlist-label ellipsis">{it.label}</div>
          <div className="barlist-track">
            <div className="barlist-bar" style={{ width: `${Math.max(1, (it.value / max) * 100)}%`, background: color }} />
          </div>
          <div className="barlist-value">
            {fmt(it.value)}
            {it.extra !== undefined && <span className="muted"> · {it.extra}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}
