import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Copy, Inbox, Search, X, XCircle } from 'lucide-react'
import { errMsg } from '../api'
import { fmtInt } from '../format'

// ---- toast ------------------------------------------------------------------

interface ToastItem {
  id: number
  kind: 'ok' | 'err' | 'info'
  text: string
}
let toastSeq = 0
let toastItems: ToastItem[] = []
const toastSubs = new Set<() => void>()
function pushToast(kind: ToastItem['kind'], text: string) {
  const item = { id: ++toastSeq, kind, text }
  toastItems = [...toastItems, item].slice(-5)
  toastSubs.forEach((f) => f())
  setTimeout(() => dismissToast(item.id), kind === 'err' ? 7000 : 3500)
}
function dismissToast(id: number) {
  toastItems = toastItems.filter((t) => t.id !== id)
  toastSubs.forEach((f) => f())
}
export const toast = {
  ok: (text: string) => pushToast('ok', text),
  info: (text: string) => pushToast('info', text),
  err: (e: unknown) => pushToast('err', typeof e === 'string' ? e : errMsg(e)),
}

export function ToastHost() {
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((n) => n + 1)
    toastSubs.add(f)
    return () => {
      toastSubs.delete(f)
    }
  }, [])
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {toastItems.map((t) => (
        <div key={t.id} className={'toast ' + t.kind}>
          {t.kind === 'err' ? <XCircle size={16} /> : <CheckCircle2 size={16} />}
          <span>{t.text}</span>
          <button className="icon-btn" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}

// ---- confirm ----------------------------------------------------------------

interface ConfirmOpts {
  title: string
  message?: ReactNode
  confirmLabel?: string
  danger?: boolean
}
let confirmState: (ConfirmOpts & { resolve: (v: boolean) => void }) | null = null
const confirmSubs = new Set<() => void>()

export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState = { ...opts, resolve }
    confirmSubs.forEach((f) => f())
  })
}

export function ConfirmHost() {
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((n) => n + 1)
    confirmSubs.add(f)
    return () => {
      confirmSubs.delete(f)
    }
  }, [])
  const st = confirmState
  if (!st) return null
  const done = (v: boolean) => {
    confirmState = null
    confirmSubs.forEach((f) => f())
    st.resolve(v)
  }
  return (
    <Modal
      title={st.title}
      size="sm"
      onClose={() => done(false)}
      footer={
        <>
          <button className="btn" onClick={() => done(false)}>
            Cancel
          </button>
          <button className={'btn ' + (st.danger === false ? 'primary' : 'danger')} autoFocus onClick={() => done(true)}>
            {st.confirmLabel ?? 'Delete'}
          </button>
        </>
      }
    >
      <div className="confirm-body">{st.message}</div>
    </Modal>
  )
}

// ---- modal / drawer ---------------------------------------------------------

interface OverlayProps {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

function useOverlay(onClose: () => void) {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      e.stopPropagation()
      ref.current()
    }
    const node = stack.push(onKey)
    return () => stack.remove(node)
  }, [])
}

// Escape closes only the most recently opened overlay.
const stack = (() => {
  const handlers: ((e: globalThis.KeyboardEvent) => void)[] = []
  const listener = (e: globalThis.KeyboardEvent) => {
    if (e.key === 'Escape' && handlers.length) handlers[handlers.length - 1](e)
  }
  return {
    push(h: (e: globalThis.KeyboardEvent) => void) {
      if (!handlers.length) document.addEventListener('keydown', listener)
      handlers.push(h)
      return h
    },
    remove(h: (e: globalThis.KeyboardEvent) => void) {
      const i = handlers.indexOf(h)
      if (i >= 0) handlers.splice(i, 1)
      if (!handlers.length) document.removeEventListener('keydown', listener)
    },
  }
})()

export function Modal({ title, onClose, children, footer, size = 'md' }: OverlayProps) {
  useOverlay(onClose)
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal modal-' + size} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export function Drawer({ title, onClose, children, footer, size = 'lg' }: OverlayProps) {
  useOverlay(onClose)
  return createPortal(
    <div className="overlay overlay-drawer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'drawer drawer-' + size} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

// ---- small controls ---------------------------------------------------------

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  title,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label?: ReactNode
  title?: string
}) {
  return (
    <label className={'toggle' + (disabled ? ' disabled' : '')} title={title} onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" />
      {label !== undefined && <span className="toggle-label">{label}</span>}
    </label>
  )
}

export interface Option<T extends string = string> {
  value: T
  label: ReactNode
  title?: string
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  small,
}: {
  value: T
  onChange: (v: T) => void
  options: Option<T>[]
  small?: boolean
}) {
  return (
    <div className={'segmented' + (small ? ' small' : '')} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={o.value === value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Option<T>[] }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={t.value === value} className={'tab' + (t.value === value ? ' active' : '')} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Field({
  label,
  help,
  error,
  children,
  className,
  style,
}: {
  label?: ReactNode
  help?: ReactNode
  error?: string
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <div className={'field' + (className ? ' ' + className : '')} style={style}>
      {label !== undefined && <div className="field-label">{label}</div>}
      {children}
      {error ? <div className="field-error">{error}</div> : help ? <div className="field-help">{help}</div> : null}
    </div>
  )
}

export interface SelectOption {
  value: string
  label: string
  group?: string
  disabled?: boolean
}

/** Native select with optional optgroups; values are strings. */
export function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
  title,
}: {
  value: string
  onChange: (v: string) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  className?: string
  title?: string
}) {
  const groups = useMemo(() => {
    const out: { group: string; items: SelectOption[] }[] = []
    for (const o of options) {
      const g = o.group ?? ''
      let bucket = out.find((x) => x.group === g)
      if (!bucket) {
        bucket = { group: g, items: [] }
        out.push(bucket)
      }
      bucket.items.push(o)
    }
    return out
  }, [options])
  const known = options.some((o) => o.value === value)
  return (
    <select className={'input select' + (className ? ' ' + className : '')} title={title} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {!known && value !== '' && <option value={value}>{value}</option>}
      {groups.map((g) =>
        g.group ? (
          <optgroup key={g.group} label={g.group}>
            {g.items.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ) : (
          g.items.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))
        ),
      )}
    </select>
  )
}

/** Number input that keeps an empty string while typing. */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  disabled,
  className,
}: {
  value: number | ''
  onChange: (v: number | '') => void
  min?: number
  max?: number
  step?: number | 'any'
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  return (
    <input
      type="number"
      className={'input' + (className ? ' ' + className : '')}
      value={value}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => {
        const s = e.target.value
        if (s === '') return onChange('')
        const n = Number(s)
        if (Number.isFinite(n)) onChange(n)
      }}
    />
  )
}

// ---- popover ----------------------------------------------------------------

export function useOutside(ref: RefObject<HTMLElement | null>, onOutside: () => void, active: boolean) {
  const cb = useRef(onOutside)
  cb.current = onOutside
  useEffect(() => {
    if (!active) return
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current()
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [ref, active])
}

/** Button that opens a floating panel below it. */
export function Dropdown({
  label,
  children,
  align = 'left',
  className = 'btn',
  title,
  disabled,
  chevron = true,
}: {
  label: ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  className?: string
  title?: string
  disabled?: boolean
  chevron?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutside(ref, () => setOpen(false), open)
  return (
    <div className="dropdown" ref={ref}>
      <button
        type="button"
        className={className + (open ? ' open' : '')}
        title={title}
        disabled={disabled}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        {label}
        {chevron && <ChevronDown size={14} />}
      </button>
      {open && (
        <div className={'popover ' + align} onClick={(e) => e.stopPropagation()}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

export function MenuItem({ onClick, children, danger, disabled, title }: { onClick: () => void; children: ReactNode; danger?: boolean; disabled?: boolean; title?: string }) {
  return (
    <button type="button" className={'menu-item' + (danger ? ' danger' : '')} disabled={disabled} title={title} onClick={onClick}>
      {children}
    </button>
  )
}

// ---- multi select -----------------------------------------------------------

export interface MultiOption {
  value: string
  label: string
  prefix?: string
  hint?: string
}

/** Searchable multi-select rendered as removable chips. */
export function MultiSelect({
  values,
  onChange,
  options,
  placeholder = 'Select…',
  searchable = true,
  chipLabel,
}: {
  values: string[]
  onChange: (v: string[]) => void
  options: MultiOption[]
  placeholder?: string
  searchable?: boolean
  chipLabel?: (value: string) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useOutside(ref, () => setOpen(false), open)
  const set = useMemo(() => new Set(values), [values])
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options])
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return options
    return options.filter((o) => o.label.toLowerCase().includes(s) || o.value.toLowerCase() === s || (o.hint ?? '').toLowerCase().includes(s))
  }, [q, options])
  const toggle = (v: string) => onChange(set.has(v) ? values.filter((x) => x !== v) : [...values, v])
  return (
    <div className="multi" ref={ref}>
      <div className={'chips-box' + (open ? ' focus' : '')} onClick={() => setOpen(true)}>
        {values.map((v) => {
          const o = byValue.get(v)
          return (
            <span className="chip" key={v} title={o?.label ?? v}>
              {chipLabel ? chipLabel(v) : o ? (o.prefix ? o.prefix + ' ' : '') + o.label : v}
              <button
                type="button"
                aria-label={'Remove ' + v}
                onClick={(e) => {
                  e.stopPropagation()
                  onChange(values.filter((x) => x !== v))
                }}
              >
                <X size={12} />
              </button>
            </span>
          )
        })}
        {searchable ? (
          <input
            className="chips-input"
            value={q}
            placeholder={values.length ? '' : placeholder}
            onChange={(e) => {
              setQ(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (shown.length > 0 && q.trim()) {
                  if (!set.has(shown[0].value)) onChange([...values, shown[0].value])
                  setQ('')
                }
              } else if (e.key === 'Backspace' && !q && values.length) {
                onChange(values.slice(0, -1))
              } else if (e.key === 'Escape' && open) {
                e.stopPropagation()
                setOpen(false)
              }
            }}
          />
        ) : (
          !values.length && <span className="chips-placeholder">{placeholder}</span>
        )}
      </div>
      {open && (
        <div className="popover left multi-list">
          {shown.length === 0 && <div className="muted pad-s">Nothing found</div>}
          {shown.slice(0, 300).map((o) => (
            <button type="button" key={o.value} className={'menu-item' + (set.has(o.value) ? ' selected' : '')} onClick={() => toggle(o.value)}>
              <span className="check">{set.has(o.value) && <Check size={14} />}</span>
              {o.prefix && <span className="opt-prefix">{o.prefix}</span>}
              <span className="grow">{o.label}</span>
              {o.hint && <span className="muted mono">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- free chips input -------------------------------------------------------

/** Free-form tag editor: Enter, comma or paste adds values. */
export function Chips({
  values,
  onChange,
  placeholder,
  validate,
  mono,
}: {
  values: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  /** Return an error message to refuse a value. */
  validate?: (v: string) => string | null
  mono?: boolean
}) {
  const [text, setText] = useState('')
  const [err, setErr] = useState('')
  const add = useCallback(
    (raw: string): boolean => {
      const parts = raw
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (!parts.length) return true
      const next = [...values]
      for (const p of parts) {
        const e = validate ? validate(p) : null
        if (e) {
          setErr(e)
          return false
        }
        if (!next.includes(p)) next.push(p)
      }
      setErr('')
      onChange(next)
      return true
    },
    [values, onChange, validate],
  )
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      if (add(text)) setText('')
    } else if (e.key === 'Backspace' && !text && values.length) {
      onChange(values.slice(0, -1))
    }
  }
  return (
    <div>
      <div className={'chips-box' + (mono ? ' mono' : '')}>
        {values.map((v) => (
          <span className="chip" key={v}>
            {v}
            <button type="button" aria-label={'Remove ' + v} onClick={() => onChange(values.filter((x) => x !== v))}>
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          className="chips-input"
          value={text}
          placeholder={values.length ? '' : placeholder ?? 'Type and press Enter'}
          onChange={(e) => {
            setText(e.target.value)
            setErr('')
          }}
          onKeyDown={onKey}
          onBlur={() => {
            if (text.trim() && add(text)) setText('')
          }}
          onPaste={(e) => {
            const t = e.clipboardData.getData('text')
            if (/[\n,;]/.test(t)) {
              e.preventDefault()
              if (add(t)) setText('')
            }
          }}
        />
      </div>
      {err && <div className="field-error">{err}</div>}
    </div>
  )
}

// ---- copy -------------------------------------------------------------------

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through to the legacy path */
  }
  // The panel is often opened over plain http on ip:port, where the async clipboard API is unavailable.
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}

export function CopyButton({ text, label, className = 'btn small', title }: { text: string; label?: string; className?: string; title?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={className}
      title={title ?? 'Copy to clipboard'}
      onClick={async (e) => {
        e.stopPropagation()
        if (await copyText(text)) {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } else {
          toast.err('Copy failed: select the text and copy it manually')
        }
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
      {label !== undefined && <span>{done ? 'Copied' : label}</span>}
    </button>
  )
}

export function CodeBlock({ text, actions, maxHeight = 260 }: { text: string; actions?: ReactNode; maxHeight?: number }) {
  return (
    <div className="codeblock">
      <div className="codeblock-actions">
        {actions}
        <CopyButton text={text} label="Copy" />
      </div>
      <pre style={{ maxHeight }}>{text}</pre>
    </div>
  )
}

// ---- status bits ------------------------------------------------------------

export type Tone = 'neutral' | 'ok' | 'warn' | 'err' | 'info' | 'accent'

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={'badge ' + tone} title={title}>
      {children}
    </span>
  )
}

export function Skeleton({ rows = 3, height = 14 }: { rows?: number; height?: number }) {
  return (
    <div className="skeleton-wrap">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height, width: `${90 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  )
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <Inbox size={28} />
      <div className="empty-title">{title}</div>
      {children && <div className="muted">{children}</div>}
      {action}
    </div>
  )
}

export function Notice({ tone = 'info', children, title }: { tone?: 'info' | 'warn' | 'err' | 'ok'; children: ReactNode; title?: ReactNode }) {
  return (
    <div className={'notice ' + tone}>
      {tone === 'warn' || tone === 'err' ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
      <div>
        {title && <div className="notice-title">{title}</div>}
        {children}
      </div>
    </div>
  )
}

export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  if (!error) return null
  return (
    <div className="notice err">
      <AlertTriangle size={16} />
      <div className="grow">{error}</div>
      {retry && (
        <button className="btn small" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  )
}

export function Pagination({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(total, offset + limit)
  return (
    <div className="pagination">
      <span className="muted">
        {fmtInt(from)}–{fmtInt(to)} of {fmtInt(total)}
      </span>
      <button className="btn small" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        <ChevronLeft size={14} /> Prev
      </button>
      <button className="btn small" disabled={to >= total} onClick={() => onChange(offset + limit)}>
        Next <ChevronRight size={14} />
      </button>
    </div>
  )
}

export function SearchInput({ value, onChange, placeholder = 'Search…', width = 220 }: { value: string; onChange: (v: string) => void; placeholder?: string; width?: number }) {
  return (
    <div className="search" style={{ width }}>
      <Search size={14} />
      <input className="input" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {value && (
        <button className="icon-btn" onClick={() => onChange('')} aria-label="Clear">
          <X size={13} />
        </button>
      )}
    </div>
  )
}

export function PageHeader({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <div className="muted">{sub}</div>}
      </div>
      <div className="page-actions">{children}</div>
    </div>
  )
}

export function Card({ title, actions, children, className, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={'card' + (className ? ' ' + className : '')}>
      {(title || actions) && (
        <div className="card-head">
          <h2>{title}</h2>
          <div className="row gap-s">{actions}</div>
        </div>
      )}
      <div className={pad ? 'card-body' : ''}>{children}</div>
    </section>
  )
}

/** Runs an async action with a busy flag and error toast. */
export function useBusy(): [boolean, (fn: () => Promise<void>) => Promise<void>] {
  const [busy, setBusy] = useState(false)
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast.err(e)
    } finally {
      setBusy(false)
    }
  }, [])
  return [busy, run]
}
