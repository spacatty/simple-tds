import { Component, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Copy, Inbox, Info, Search, X, XCircle } from 'lucide-react'
import { errMsg } from '../api'
import { useTitle } from '../hooks'
import { fmtInt } from '../format'
import { t } from '../i18n'

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
  // A repeated message (a polling request that keeps failing) replaces its twin instead of stacking up.
  const rest = toastItems.filter((t) => t.kind !== kind || t.text !== text)
  toastItems = [...rest, { id: ++toastSeq, kind, text }].slice(-5)
  toastSubs.forEach((f) => f())
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
        <Toast key={t.id} item={t} />
      ))}
    </div>,
    document.body,
  )
}

function Toast({ item }: { item: ToastItem }) {
  // The countdown stops while the pointer or the focus is on the toast, so it can be read and dismissed calmly.
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (held) return
    const timer = setTimeout(() => dismissToast(item.id), item.kind === 'err' ? 7000 : 3500)
    return () => clearTimeout(timer)
  }, [held, item.id, item.kind])
  return (
    <div
      className={'toast ' + item.kind}
      role={item.kind === 'err' ? 'alert' : undefined}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      {item.kind === 'err' ? <XCircle size={16} /> : item.kind === 'info' ? <Info size={16} /> : <CheckCircle2 size={16} />}
      <span>{item.text}</span>
      <button className="icon-btn" onClick={() => dismissToast(item.id)} aria-label={t('Dismiss')}>
        <X size={14} />
      </button>
    </div>
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
            {t('Cancel')}
          </button>
          <button className={'btn ' + (st.danger === false ? 'primary' : 'danger')} autoFocus onClick={() => done(true)}>
            {st.confirmLabel ?? t('Delete')}
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

function useOverlay(onClose: () => void, active = true) {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    if (!active) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      e.stopPropagation()
      ref.current()
    }
    const node = stack.push(onKey)
    return () => stack.remove(node)
  }, [active])
}

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0)
}

/**
 * Dialog behaviour shared by Modal and Drawer: Escape closes it, focus moves
 * inside when it opens, Tab cycles within it, and focus returns to whatever
 * opened it when it closes.
 */
function useDialog(onClose: () => void) {
  useOverlay(onClose)
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  // Read during the first render: by the time effects run an autoFocus child already holds the focus.
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => {
    const el = ref.current
    if (el && !el.contains(document.activeElement)) el.focus()
    return () => {
      // Only once the dialog is really gone: development StrictMode also runs this cleanup right after mounting.
      if (!el?.isConnected && opener && opener.isConnected) opener.focus()
    }
  }, [opener])
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = ref.current
    if (e.key !== 'Tab' || !el || !el.contains(document.activeElement)) return
    const items = focusables(el)
    if (!items.length) return e.preventDefault()
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
  return { titleId, props: { ref, onKeyDown, tabIndex: -1, role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId } as const }
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
  const dialog = useDialog(onClose)
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal modal-' + size} {...dialog.props}>
        <div className="modal-head">
          <h3 id={dialog.titleId}>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label={t('Close')}>
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
  const dialog = useDialog(onClose)
  return createPortal(
    <div className="overlay overlay-drawer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'drawer drawer-' + size} {...dialog.props}>
        <div className="modal-head">
          <h3 id={dialog.titleId}>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label={t('Close')}>
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
  // Left and Right walk the strip, as tab lists do everywhere else.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    const i = tabs.findIndex((t) => t.value === value)
    const next = tabs[(i + step + tabs.length) % tabs.length]
    e.preventDefault()
    onChange(next.value)
    const el = e.currentTarget.children[tabs.indexOf(next)] as HTMLElement | undefined
    el?.focus()
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  return (
    <div className="tabs" role="tablist" onKeyDown={onKey}>
      {tabs.map((t) => (
        <button key={t.value} role="tab" aria-selected={t.value === value} tabIndex={t.value === value ? 0 : -1} className={'tab' + (t.value === value ? ' active' : '')} onClick={() => onChange(t.value)}>
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
  const labelId = useId()
  const ref = useRef<HTMLDivElement>(null)
  // Not a <label>: a field may hold several controls. Clicking the caption still lands in the first one.
  const focusFirst = () => ref.current?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')?.focus()
  return (
    <div ref={ref} className={'field' + (className ? ' ' + className : '')} style={style} role={label !== undefined ? 'group' : undefined} aria-labelledby={label !== undefined ? labelId : undefined}>
      {label !== undefined && (
        <div className="field-label" id={labelId} onClick={focusFirst}>
          {label}
        </div>
      )}
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

/** Calls onOutside for a press outside ref (and outside `also`, e.g. a panel rendered in a portal). */
export function useOutside(ref: RefObject<HTMLElement | null>, onOutside: () => void, active: boolean, also?: RefObject<HTMLElement | null>) {
  const cb = useRef(onOutside)
  cb.current = onOutside
  useEffect(() => {
    if (!active) return
    const h = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current && !ref.current.contains(t) && !also?.current?.contains(t)) cb.current()
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [ref, also, active])
}

/**
 * Places a panel rendered in a portal against its anchor: below it, or above
 * when there is more room there, always inside the viewport. A panel that
 * lived inside the anchor's container would be cut off by any scrolling
 * ancestor — a table, a modal body, a drawer.
 */
function useFloating(anchor: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, open: boolean, align: 'left' | 'right', matchWidth = false) {
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const a = anchor.current
      const p = panel.current
      if (!a || !p) return
      const r = a.getBoundingClientRect()
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      const gap = 4
      const edge = 8
      if (matchWidth) p.style.width = Math.max(r.width, 260) + 'px'
      p.style.maxHeight = ''
      const h = p.offsetHeight
      const w = p.offsetWidth
      const below = vh - r.bottom - gap - edge
      const above = r.top - gap - edge
      const up = h > below && above > below
      const room = Math.max(120, up ? above : below)
      if (h > room) p.style.maxHeight = room + 'px'
      const top = up ? r.top - gap - Math.min(h, room) : r.bottom + gap
      const left = align === 'right' ? r.right - w : r.left
      p.style.top = Math.max(edge, top) + 'px'
      p.style.left = Math.max(edge, Math.min(left, vw - w - edge)) + 'px'
    }
    place()
    // Scrolling inside the panel itself must not re-measure it: that would reset its scroll position.
    const onScroll = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) place()
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', place)
    const ro = typeof ResizeObserver !== 'undefined' && panel.current ? new ResizeObserver(place) : null
    if (ro && panel.current) ro.observe(panel.current)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', place)
      ro?.disconnect()
    }
  }, [anchor, panel, open, align, matchWidth])
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
  const btn = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  useOutside(ref, () => setOpen(false), open, panel)
  useFloating(btn, panel, open, align)
  /** Closes the panel and hands the focus back to the button, for everything done from the keyboard. */
  const dismiss = () => {
    setOpen(false)
    btn.current?.focus()
  }
  useOverlay(dismiss, open)
  const items = () => (panel.current ? focusables(panel.current) : [])
  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items()
    const i = list.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Tab') {
      // The panel sits at the end of the document, so leaving it by Tab returns to the button instead.
      if (e.shiftKey ? i <= 0 : i === list.length - 1) {
        e.preventDefault()
        dismiss()
      }
      return
    }
    // Arrow keys belong to a text field while the caret is in one.
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !list.length) return
    const to = e.key === 'ArrowDown' ? (i + 1) % list.length : e.key === 'ArrowUp' ? (i <= 0 ? list.length - 1 : i - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : -1
    if (to < 0) return
    e.preventDefault()
    list[to].focus()
  }
  return (
    <div className="dropdown" ref={ref}>
      <button
        ref={btn}
        type="button"
        className={className + (open ? ' open' : '')}
        title={title}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && !(e.key === 'Tab' && !e.shiftKey && open)) return
          const first = items()[0]
          if (!open) setOpen(true)
          else if (first) first.focus()
          else return
          e.preventDefault()
        }}
      >
        {label}
        {chevron && <ChevronDown size={14} />}
      </button>
      {open &&
        createPortal(
          <div ref={panel} className="popover floating" onClick={(e) => e.stopPropagation()} onKeyDown={onPanelKey}>
            {children(() => setOpen(false))}
          </div>,
          document.body,
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
  /** Shown before the label in the list, e.g. a flag. */
  icon?: ReactNode
  hint?: string
}

/** Searchable multi-select rendered as removable chips. */
export function MultiSelect({
  values,
  onChange,
  options,
  placeholder = t('Select…'),
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
  // Row under the keyboard cursor; -1 until the user types or presses an arrow key.
  const [active, setActive] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  useOutside(ref, () => setOpen(false), open, panel)
  useFloating(ref, panel, open, 'left', true)
  const set = useMemo(() => new Set(values), [values])
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options])
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return options
    // Best match first, because Enter takes the top row: "ger" must offer Germany before Algeria.
    const rank = (o: MultiOption) => {
      const label = o.label.toLowerCase()
      if (o.value.toLowerCase() === s || label === s) return 0
      if (label.startsWith(s)) return 1
      if (label.includes(' ' + s)) return 2
      if (label.includes(s) || (o.hint ?? '').toLowerCase().includes(s)) return 3
      return -1
    }
    return options
      .map((o, i) => ({ o, i, r: rank(o) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.o)
  }, [q, options])
  const toggle = (v: string) => onChange(set.has(v) ? values.filter((x) => x !== v) : [...values, v])
  const visible = shown.slice(0, 300)
  const move = (to: number) => {
    setActive(to)
    panel.current?.querySelectorAll('.menu-item')[to]?.scrollIntoView({ block: 'nearest' })
  }
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
                aria-label={t('Remove {name}', { name: v })}
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
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            onChange={(e) => {
              setQ(e.target.value)
              setActive(e.target.value.trim() ? 0 : -1)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                if (!open) return setOpen(true)
                if (visible.length) move(e.key === 'ArrowDown' ? (active + 1) % visible.length : active <= 0 ? visible.length - 1 : active - 1)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const o = open ? visible[active] : undefined
                if (!o) return
                // Typing a name and pressing Enter only ever adds; walking the list with arrows toggles.
                if (q.trim()) {
                  if (!set.has(o.value)) onChange([...values, o.value])
                  setQ('')
                  setActive(-1)
                } else toggle(o.value)
              } else if (e.key === 'Tab') {
                setOpen(false)
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
      {open &&
        createPortal(
          <div ref={panel} className="popover floating multi-list" role="listbox" aria-multiselectable="true">
            {shown.length === 0 && <div className="muted pad-s">{t('Nothing found')}</div>}
            {visible.map((o, i) => (
              // tabIndex -1: the list is driven from the input, which keeps the focus.
              <button type="button" tabIndex={-1} role="option" aria-selected={set.has(o.value)} key={o.value} className={'menu-item' + (set.has(o.value) ? ' selected' : '') + (i === active ? ' active' : '')} onMouseDown={(e) => e.preventDefault()} onClick={() => toggle(o.value)}>
                <span className="check">{set.has(o.value) && <Check size={14} />}</span>
                {o.icon ? <span className="opt-prefix">{o.icon}</span> : o.prefix && <span className="opt-prefix">{o.prefix}</span>}
                <span className="grow">{o.label}</span>
                {o.hint && <span className="muted mono">{o.hint}</span>}
              </button>
            ))}
            {shown.length > visible.length && <div className="muted pad-s">{t('Showing the first {n} — type to narrow the list', { n: visible.length })}</div>}
          </div>,
          document.body,
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
            <button type="button" aria-label={t('Remove {name}', { name: v })} onClick={() => onChange(values.filter((x) => x !== v))}>
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          className="chips-input"
          value={text}
          placeholder={values.length ? '' : placeholder ?? t('Type and press Enter')}
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
      title={title ?? t('Copy to clipboard')}
      onClick={async (e) => {
        e.stopPropagation()
        if (await copyText(text)) {
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } else {
          toast.err(t('Copy failed: select the text and copy it manually'))
        }
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
      {label !== undefined && <span>{done ? t('Copied') : label}</span>}
    </button>
  )
}

export function CodeBlock({ text, actions, maxHeight = 260 }: { text: string; actions?: ReactNode; maxHeight?: number }) {
  return (
    <div className="codeblock">
      <div className="codeblock-actions">
        {actions}
        <CopyButton text={text} label={t('Copy')} />
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
          {t('Retry')}
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
        {t('{from}–{to} of {total}', { from: fmtInt(from), to: fmtInt(to), total: fmtInt(total) })}
      </span>
      <button className="btn small" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        <ChevronLeft size={14} /> {t('Prev')}
      </button>
      <button className="btn small" disabled={to >= total} onClick={() => onChange(offset + limit)}>
        {t('Next')} <ChevronRight size={14} />
      </button>
    </div>
  )
}

export function SearchInput({ value, onChange, placeholder = t('Search…'), width = 220 }: { value: string; onChange: (v: string) => void; placeholder?: string; width?: number }) {
  return (
    <div className="search" style={{ width }}>
      <Search size={14} />
      <input
        className="input"
        aria-label={placeholder.replace(/…$/, '')}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Escape clears a filled box first; an empty one lets the key through (to close a dialog, say).
          if (e.key === 'Escape' && value) {
            e.stopPropagation()
            onChange('')
          }
        }}
      />
      {value && (
        <button className="icon-btn" onClick={() => onChange('')} aria-label={t('Clear')}>
          <X size={13} />
        </button>
      )}
    </div>
  )
}

export function PageHeader({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  useTitle(typeof title === 'string' ? title : undefined)
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

/**
 * Keeps a crash while rendering one page from blanking the whole panel: the
 * sidebar stays usable and the page offers a reload. Give it a key that
 * changes with the route so that navigating away clears the error.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="page page-narrow">
        <div className="notice err" role="alert">
          <AlertTriangle size={16} />
          <div className="grow">
            <div className="notice-title">{t('This page failed to display')}</div>
            {error.message || String(error)}
          </div>
          <button className="btn small" onClick={() => window.location.reload()}>
            {t('Reload')}
          </button>
        </div>
      </div>
    )
  }
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
