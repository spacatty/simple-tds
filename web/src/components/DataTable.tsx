import { Fragment, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from 'lucide-react'
import { Empty } from './ui'

export interface Column<T> {
  key: string
  title: ReactNode
  render?: (row: T, index: number) => ReactNode
  align?: 'left' | 'right' | 'center'
  /** Enables client-side sorting on this column. */
  sort?: (row: T) => string | number
  width?: number | string
  className?: string
  headTitle?: string
}

interface Props<T> {
  columns: Column<T>[]
  rows: T[] | undefined
  rowKey: (row: T, index: number) => string | number
  loading?: boolean
  empty?: ReactNode
  /** Extra <tr> rendered in a sticky footer (totals). */
  footer?: ReactNode
  /** Renders a detail panel under the row when it is clicked. */
  expand?: (row: T) => ReactNode
  defaultSort?: { key: string; dir: 'asc' | 'desc' }
  maxHeight?: number | string
  rowClass?: (row: T) => string
  onRowClick?: (row: T) => void
}

export function DataTable<T>({ columns, rows, rowKey, loading, empty, footer, expand, defaultSort, maxHeight, rowClass, onRowClick }: Props<T>) {
  const [sort, setSort] = useState(defaultSort)
  const [open, setOpen] = useState<Set<string | number>>(new Set())

  const sorted = useMemo(() => {
    if (!rows) return []
    const col = sort && columns.find((c) => c.key === sort.key)
    if (!col || !col.sort || !sort) return rows
    const get = col.sort
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const x = get(a)
      const y = get(b)
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir
    })
  }, [rows, sort, columns])

  const clickHead = (c: Column<T>) => {
    if (!c.sort) return
    setSort((s) => (s && s.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.align === 'right' ? 'desc' : 'asc' }))
  }

  const span = columns.length + (expand ? 1 : 0)
  const initial = loading && !rows

  return (
    <div className={'table-wrap' + (loading && rows ? ' reloading' : '')} style={maxHeight ? { maxHeight } : undefined}>
      <table className="table">
        <thead>
          <tr>
            {expand && <th style={{ width: 28 }} />}
            {columns.map((c) => (
              <th
                key={c.key}
                title={c.headTitle}
                style={{ width: c.width, textAlign: c.align }}
                className={(c.sort ? 'sortable ' : '') + (c.className ?? '')}
                onClick={() => clickHead(c)}
                aria-sort={sort && sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
              >
                <span className="th-inner">
                  {c.title}
                  {sort && sort.key === c.key && (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {initial &&
            Array.from({ length: 6 }).map((_, i) => (
              <tr key={'sk' + i} className="skeleton-row">
                {Array.from({ length: span }).map((__, j) => (
                  <td key={j}>
                    <div className="skeleton" style={{ width: `${40 + ((i * 7 + j * 13) % 50)}%` }} />
                  </td>
                ))}
              </tr>
            ))}
          {!initial && sorted.length === 0 && (
            <tr className="empty-row">
              <td colSpan={span}>{empty ?? <Empty title="Nothing here yet" />}</td>
            </tr>
          )}
          {!initial &&
            sorted.map((row, i) => {
              const k = rowKey(row, i)
              const isOpen = open.has(k)
              const clickable = !!expand || !!onRowClick
              return (
                <Fragment key={k}>
                  <tr
                    className={(clickable ? 'clickable ' : '') + (isOpen ? 'open ' : '') + (rowClass ? rowClass(row) : '')}
                    onClick={() => {
                      if (expand) {
                        setOpen((s) => {
                          const n = new Set(s)
                          if (n.has(k)) n.delete(k)
                          else n.add(k)
                          return n
                        })
                      }
                      onRowClick?.(row)
                    }}
                  >
                    {expand && <td className="expander">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>}
                    {columns.map((c) => (
                      <td key={c.key} style={{ textAlign: c.align }} className={c.className}>
                        {c.render ? c.render(row, i) : String((row as Record<string, unknown>)[c.key] ?? '')}
                      </td>
                    ))}
                  </tr>
                  {expand && isOpen && (
                    <tr className="detail-row">
                      <td colSpan={span}>{expand(row)}</td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
        </tbody>
        {footer && !initial && sorted.length > 0 && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  )
}
