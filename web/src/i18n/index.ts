// Panel translations. English is the source language and lives in the code:
// the English text is the dictionary key, so a missing translation shows
// English instead of a key name.
//
//   t('Save')                                  static text
//   t('Delete {name}?', { name })              placeholders
//   t('Open@@verb')                            "@@context" tells apart identical English texts
//   tn(n, '{n} stream', '{n} streams')         plurals (the dictionary key is the plural form)
//   tx('Read <a>the docs</a>', { a: (c) => <a href="…">{c}</a> })   markup inside a sentence
//   ts(text)                                   text that arrives from the server (labels, errors)
//
// The first argument of t, tn and tx is always a string literal:
// `npm run i18n` reads them from the sources and compares with ru.json.
//
// The language is fixed for the lifetime of the page (switching reloads it),
// so t() may be called anywhere, including module-level constants.
import { Fragment, createElement } from 'react'
import type { ReactNode } from 'react'
import ru from './ru.json'
import ruServer from './ru.server.json'

export type Lang = 'en' | 'ru'

/** `flag` is the country whose flag stands for the language in the switch. */
export const LANGS: { code: Lang; name: string; flag: string }[] = [
  { code: 'en', name: 'English', flag: 'GB' },
  { code: 'ru', name: 'Русский', flag: 'RU' },
]

const STORAGE_KEY = 'tds_lang'

function stored(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (LANGS.some((l) => l.code === v)) return v as Lang
  } catch {
    /* private mode */
  }
  return 'en'
}

export const lang: Lang = stored()
document.documentElement.lang = lang

/** BCP 47 tag for Intl date and name formatting. */
export const locale = lang === 'ru' ? 'ru-RU' : 'en-US'

export function setLang(l: Lang) {
  if (l === lang) return
  try {
    localStorage.setItem(STORAGE_KEY, l)
  } catch {
    /* private mode */
  }
  window.location.reload()
}

type Entry = string | string[]
type Vars = Record<string, string | number>

const DICTS: Record<Lang, Record<string, Entry> | null> = { en: null, ru: ru as Record<string, Entry> }
const SERVER: Record<Lang, Record<string, string> | null> = { en: null, ru: ruServer as Record<string, string> }
const dict = DICTS[lang]
const server = SERVER[lang]

const source = (key: string) => {
  const i = key.indexOf('@@')
  return i < 0 ? key : key.slice(0, i)
}

const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s)

export function t(key: string, vars?: Vars): string {
  const e = dict?.[key]
  return fill(typeof e === 'string' ? e : source(key), vars)
}

/** Index of the plural form for n: en has 2 forms, ru has 3 (1 файл, 2 файла, 5 файлов). */
function pluralForm(n: number): number {
  n = Math.abs(n)
  if (lang !== 'ru') return n === 1 ? 0 : 1
  if (!Number.isInteger(n)) return 1
  const d = n % 10
  const dd = n % 100
  if (d === 1 && dd !== 11) return 0
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 1
  return 2
}

/** Plural text; {n} is filled in automatically. The dictionary entry for `other` lists the forms of the language. */
export function tn(n: number, one: string, other: string, vars?: Vars): string {
  const e = dict?.[other]
  const forms = Array.isArray(e) ? e : [source(one), source(other)]
  return fill(forms[Math.min(pluralForm(n), forms.length - 1)], { n, ...vars })
}

type Part = ReactNode | ((children: ReactNode) => ReactNode)

/** Like t(), for sentences with markup: `<name>…</name>` calls parts.name, `{name}` inserts parts.name. */
export function tx(key: string, parts: Record<string, Part> = {}): ReactNode {
  const e = dict?.[key]
  const text = typeof e === 'string' ? e : source(key)
  const out: ReactNode[] = []
  const plain = (s: string): ReactNode[] =>
    s.split(/(\{\w+\})/).map((p) => {
      const m = /^\{(\w+)\}$/.exec(p)
      if (!m || !(m[1] in parts)) return p
      const v = parts[m[1]]
      return typeof v === 'function' ? v(null) : v
    })
  const re = /<(\w+)>(.*?)<\/\1>/gs
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push(...plain(text.slice(last, m.index)))
    const wrap = parts[m[1]]
    const inner = createElement(Fragment, null, ...plain(m[2]))
    out.push(typeof wrap === 'function' ? wrap(inner) : inner)
    last = m.index + m[0].length
  }
  out.push(...plain(text.slice(last)))
  return createElement(Fragment, null, ...out)
}

// ---- text produced by the server -------------------------------------------------
//
// Labels of actions and filters, preset names and error messages come from the
// Go side in English. ru.server.json translates them: an entry is either the
// exact text or a pattern with {1}, {2}… standing for the variable parts, which
// are translated in turn ("filter {1}: {2}" covers every nested filter error).

let patterns: { re: RegExp; to: string }[] | null = null

function serverPatterns() {
  if (patterns) return patterns
  patterns = []
  for (const [from, to] of Object.entries(server ?? {})) {
    if (!/\{\d\}/.test(from)) continue
    const body = from
      .split(/(\{\d\})/)
      .map((p) => (/^\{\d\}$/.test(p) ? '([\\s\\S]+?)' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('')
    const order = [...from.matchAll(/\{(\d)\}/g)].map((m) => m[1])
    // Captures are renumbered to the order they appear in the source text.
    patterns.push({ re: new RegExp('^' + body + '$'), to: to.replace(/\{(\d)\}/g, (_, d) => '{' + (order.indexOf(d) + 1) + '}') })
  }
  // Longer patterns first, so the most specific one wins.
  patterns.sort((a, b) => b.re.source.length - a.re.source.length)
  return patterns
}

/** Translates server-provided text; anything unknown is returned as it came. */
export function ts(text: string | undefined | null): string {
  if (!text) return ''
  if (!server) return text
  const exact = server[text] ?? dict?.[text]
  if (typeof exact === 'string') return exact
  for (const p of serverPatterns()) {
    const m = p.re.exec(text)
    // A bare lowercase token inside a message is an identifier (a stage key, a field name), not text.
    if (m) return p.to.replace(/\{(\d)\}/g, (_, d) => (/^[a-z0-9_]+$/.test(m[Number(d)]) ? m[Number(d)] : ts(m[Number(d)])))
  }
  return text
}
