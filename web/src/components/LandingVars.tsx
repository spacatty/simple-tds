import { useRef, useState } from 'react'
import type { Stage } from '../types'
import { Badge } from './ui'
import { t } from '../i18n'

/** Where a landing variable goes decides how its value is escaped. */
export const VAR_KIND_LABEL: Record<string, string> = {
  text: t('Text'),
  html: t('HTML'),
  url: t('Link'),
  js: t('JS string'),
  server: t('Server only'),
}

export const VAR_KIND_HELP: Record<string, string> = {
  text: t('Plain text or an attribute value. The whole value is HTML-escaped, so visitor data that arrives through a macro cannot inject markup.'),
  html: t('Markup, written into the page as it is. Values of macros inside it are still HTML-escaped.'),
  url: t('A link for href, src or a script. Values of macros are URL-encoded; the offer and event macros are whole addresses and go in unchanged.'),
  js: t('Goes between the quotes of a JavaScript string. Quotes, slashes and line breaks are escaped.'),
  server: t('A secret for PHP only, read as $_SERVER with the token as the key. It is never written into a page and is masked in the panel.'),
}

export const varKindLabel = (kind: string) => VAR_KIND_LABEL[kind] ?? kind

export interface VarInfo {
  name: string
  label: string
  kind: string
}

type TextEl = HTMLInputElement | HTMLTextAreaElement

/**
 * One input per landing variable. An empty input means "not set here": the
 * placeholder shows what the variable falls back to.
 */
export function VarValues({
  prefix,
  vars,
  values,
  onChange,
  placeholder,
  macros,
  stages,
  offer,
  readOnly,
}: {
  prefix: string
  vars: VarInfo[]
  values: Record<string, string>
  onChange: (v: Record<string, string>) => void
  placeholder: (name: string) => string
  /** Macro names without braces. */
  macros: string[]
  /** The funnel whose browser stages become {event:…} macros. */
  stages: Stage[]
  /** Offer the {offer} macro: the stream has an offer URL. */
  offer?: boolean
  readOnly?: boolean
}) {
  const els = useRef<Record<string, TextEl | null>>({})
  const [focused, setFocused] = useState('')
  // The macros appear once a variable is being typed in: they insert into that one.
  const [touched, setTouched] = useState(false)
  const caret = useRef<{ name: string; start: number; end: number } | null>(null)

  const set = (name: string, val: string) => {
    const next = { ...values }
    if (val === '') delete next[name]
    else next[name] = val
    onChange(next)
  }
  const track = (name: string) => (e: { currentTarget: TextEl }) => {
    caret.current = { name, start: e.currentTarget.selectionStart ?? e.currentTarget.value.length, end: e.currentTarget.selectionEnd ?? e.currentTarget.value.length }
  }
  const insert = (macro: string) => {
    const at = caret.current
    if (!at) return
    const token = `{${macro}}`
    const cur = values[at.name] ?? ''
    const start = Math.min(at.start, cur.length)
    const end = Math.min(at.end, cur.length)
    set(at.name, cur.slice(0, start) + token + cur.slice(end))
    const pos = start + token.length
    caret.current = { name: at.name, start: pos, end: pos }
    requestAnimationFrame(() => {
      const el = els.current[at.name]
      if (el) {
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  if (vars.length === 0) return <div className="muted">{t('This landing has no variables yet. Write a token such as {token} into its files and it appears here.', { token: prefix + 'TITLE' })}</div>

  const browserStages = stages.filter((st) => st.public)
  const plain = macros.filter((m) => m !== 'event:STAGE')
  return (
    <div className="lvars">
      {vars.map((v) => {
        const val = values[v.name] ?? ''
        const props = {
          ref: (el: TextEl | null) => {
            els.current[v.name] = el
          },
          value: val,
          placeholder: placeholder(v.name),
          disabled: readOnly,
          spellCheck: false,
          autoComplete: 'off',
          onChange: (e: { currentTarget: TextEl }) => set(v.name, e.currentTarget.value),
          onFocus: (e: { currentTarget: TextEl }) => {
            setFocused(v.name)
            setTouched(true)
            track(v.name)(e)
          },
          onBlur: () => setFocused((f) => (f === v.name ? '' : f)),
          onSelect: track(v.name),
          onKeyUp: track(v.name),
          onClick: track(v.name),
        }
        // A secret is readable only while it is being typed.
        const cls = 'input mono' + (val !== '' ? ' set' : '') + (v.kind === 'server' && focused !== v.name ? ' masked' : '')
        return (
          <div className="lvar" key={v.name}>
            <div className="lvar-name">
              <code title={prefix + v.name}>{v.name}</code>
              <Badge tone={v.kind === 'server' ? 'warn' : 'neutral'} title={VAR_KIND_HELP[v.kind]}>
                {varKindLabel(v.kind)}
              </Badge>
              {v.label && <span className="muted small ellipsis">{v.label}</span>}
            </div>
            {v.kind === 'html' || v.kind === 'js' ? <textarea className={cls} rows={2} {...props} /> : <input className={cls} {...props} />}
          </div>
        )
      })}
      {!readOnly && touched && (
        <div className="macros">
          <div className="field-label">{t('Macros — click to insert into the variable you are typing in')}</div>
          <div className="macro-chips">
            {plain.map((m) => (
              <button type="button" key={m} className="macro" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(m)}>
                {'{' + m + '}'}
              </button>
            ))}
            {offer && (
              <button type="button" className="macro dyn" title={t('The offer link of this stream: it reports the stage and redirects to the offer URL')} onMouseDown={(e) => e.preventDefault()} onClick={() => insert('offer')}>
                {'{offer}'}
              </button>
            )}
            {browserStages.map((st) => (
              <button type="button" key={st.key} className="macro dyn" title={t('Funnel stage “{name}”: the URL the page requests to report it for this click', { name: st.name })} onMouseDown={(e) => e.preventDefault()} onClick={() => insert('event:' + st.key)}>
                {'{event:' + st.key + '}'}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
