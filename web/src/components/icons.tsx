/// <reference types="vite/client" />
import type { ReactNode } from 'react'
import { Bot, CircleHelp, Globe, Monitor, Smartphone, Tablet, Terminal, Tv } from 'lucide-react'
import { siAndroid, siApple, siBrave, siDuckduckgo, siFacebook, siFirefoxbrowser, siGooglechrome, siInstagram, siLinux, siOpera, siSafari, siSamsung, siTiktok, siTorbrowser, siUbuntu, siVivaldi } from 'simple-icons'
import type { LucideIcon } from 'lucide-react'
import { countryName } from '../countries'
import { humanize } from '../format'

// Flags are bundled SVG files: flag emoji do not exist on Windows.
const FLAGS = import.meta.glob<string>('/node_modules/country-flag-icons/3x2/*.svg', { eager: true, query: '?url', import: 'default' })
const flagUrl = (code: string): string | undefined => FLAGS[`/node_modules/country-flag-icons/3x2/${code}.svg`]

export function Flag({ code }: { code: string }) {
  const c = (code || '').toUpperCase()
  const url = flagUrl(c)
  if (!url) return null
  return <img className="flag" src={url} alt="" loading="lazy" width={18} height={12} />
}

/** Flag plus the country: its name, its code, or both ("Germany (DE)"). */
export function Country({ code, show = 'name', empty = '—' }: { code: string; show?: 'name' | 'code' | 'both'; empty?: ReactNode }) {
  if (!code) return <span className="muted">{empty}</span>
  const c = code.toUpperCase()
  const name = countryName(c)
  return (
    <span className="with-icon" title={name === c ? undefined : `${name} (${c})`}>
      <Flag code={c} />
      {show === 'code' ? c : show === 'both' && name !== c ? `${name} (${c})` : name}
    </span>
  )
}

/** A funnel drawn as a chart of narrowing steps: the stock funnel glyph reads as "filter". */
export function FunnelIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3.5h19l-2.5 4.5H5z" />
      <path d="M6.5 10.5h11L15 15H9z" />
      <path d="M10 17.5h4v3.5h-4z" />
    </svg>
  )
}

const DEVICES: Record<string, LucideIcon> = { desktop: Monitor, mobile: Smartphone, tablet: Tablet, tv: Tv, bot: Bot }

/** An icon standing in for its name: the name moves to a tooltip and to screen readers. */
function tip(icon: ReactNode, title?: string): ReactNode {
  if (!title || !icon) return icon
  return (
    <span className="ico-tip" title={title} role="img" aria-label={title}>
      {icon}
    </span>
  )
}

export function DeviceIcon({ type, size = 14, title }: { type: string; size?: number; title?: string }) {
  const Icon = DEVICES[(type || '').toLowerCase()] ?? CircleHelp
  return tip(<Icon className="ico" size={size} aria-hidden="true" />, title)
}

// Brand marks as single-path 24×24 glyphs. Microsoft's are not in the icon set any more.
const WINDOWS = 'M0 0h11.4v11.4H0zM12.6 0H24v11.4H12.6zM0 12.6h11.4V24H0zM12.6 12.6H24V24H12.6z'
const EDGE =
  'M21.86 17.86q.14 0 .25.12.1.13.1.25t-.11.33l-.32.46-.43.53-.44.5q-.21.25-.38.42l-.22.23q-.58.53-1.34 1.04-.76.51-1.6.91-.86.4-1.74.64t-1.67.24q-.9 0-1.69-.28-.8-.28-1.48-.78-.68-.5-1.22-1.17-.53-.66-.92-1.44-.38-.77-.58-1.6-.2-.83-.2-1.67 0-1 .32-1.96.33-.97.87-1.8.14.95.55 1.77.41.82 1.02 1.5.6.68 1.38 1.21.78.54 1.64.9.86.36 1.77.56.92.2 1.8.2 1.12 0 2.18-.24 1.06-.23 2.06-.72l.2-.1.2-.05zm-15.5-1.27q0 1.1.27 2.15.27 1.06.78 2.03.51.96 1.24 1.77.74.82 1.66 1.4-1.47-.2-2.8-.74-1.33-.55-2.48-1.37-1.15-.83-2.08-1.9-.92-1.07-1.58-2.33T.36 14.94Q0 13.54 0 12.06q0-.81.32-1.49.31-.68.83-1.23.53-.55 1.2-.96.66-.4 1.35-.66.74-.27 1.5-.39.78-.12 1.55-.12.7 0 1.42.1.72.12 1.4.35.68.23 1.32.57.63.35 1.16.83-.35 0-.7.07-.33.07-.65.23v-.02q-.63.28-1.2.74-.57.46-1.05 1.04-.48.58-.87 1.26-.38.67-.65 1.39-.27.71-.42 1.44-.15.72-.15 1.38zM11.96.06q1.7 0 3.33.39 1.63.38 3.07 1.15 1.43.77 2.62 1.93 1.18 1.16 1.98 2.7.49.94.76 1.96.28 1 .28 2.08 0 .89-.23 1.7-.24.8-.69 1.48-.45.68-1.1 1.22-.64.53-1.45.88-.54.24-1.11.36-.58.13-1.16.13-.42 0-.97-.03-.54-.03-1.1-.12-.55-.1-1.05-.28-.5-.19-.84-.5-.12-.09-.23-.24-.1-.16-.1-.33 0-.15.16-.35.16-.2.35-.5.2-.28.36-.68.16-.4.16-.95 0-1.06-.4-1.96-.4-.91-1.06-1.64-.66-.74-1.52-1.28-.86-.55-1.79-.89-.84-.3-1.72-.44-.87-.14-1.76-.14-1.55 0-3.06.45T.94 7.55q.71-1.74 1.81-3.13 1.1-1.38 2.52-2.35Q6.68 1.1 8.37.58q1.7-.52 3.58-.52Z'

function Glyph({ path, Icon, size }: { path?: string; Icon?: LucideIcon; size: number }) {
  if (path) {
    return (
      <svg className="ico" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d={path} />
      </svg>
    )
  }
  return Icon ? <Icon className="ico" size={size} aria-hidden="true" /> : null
}

/** The first rule whose word occurs in the name wins, so put the specific ones first. */
function match(name: string, rules: [string, string][]): string | undefined {
  const s = (name || '').toLowerCase()
  return rules.find(([word]) => s.includes(word))?.[1]
}

const OS_RULES: [string, string][] = [
  ['windows', WINDOWS],
  ['android', siAndroid.path],
  ['ios', siApple.path],
  ['ipad', siApple.path],
  ['mac', siApple.path],
  ['os x', siApple.path],
  ['ubuntu', siUbuntu.path],
  ['linux', siLinux.path],
  ['chrome', siGooglechrome.path],
]

export function OsIcon({ os, size = 14, title }: { os: string; size?: number; title?: string }) {
  if (!os) return null
  const path = match(os, OS_RULES)
  return tip(<Glyph path={path} Icon={path ? undefined : (os || '').toLowerCase().includes('bsd') ? Terminal : CircleHelp} size={size} />, title)
}

const BROWSER_RULES: [string, string][] = [
  ['edg', EDGE],
  ['opera', siOpera.path],
  ['opr', siOpera.path],
  ['brave', siBrave.path],
  ['vivaldi', siVivaldi.path],
  ['samsung', siSamsung.path],
  ['duckduckgo', siDuckduckgo.path],
  ['tor', siTorbrowser.path],
  ['facebook', siFacebook.path],
  ['instagram', siInstagram.path],
  ['tiktok', siTiktok.path],
  ['firefox', siFirefoxbrowser.path],
  ['chrom', siGooglechrome.path],
  ['safari', siSafari.path],
]

export function BrowserIcon({ browser, size = 14, title }: { browser: string; size?: number; title?: string }) {
  if (!browser) return null
  const s = browser.toLowerCase()
  const path = match(browser, BROWSER_RULES)
  return tip(<Glyph path={path} Icon={path ? undefined : s.includes('bot') || s.includes('crawl') || s.includes('spider') ? Bot : Globe} size={size} />, title)
}

export function Browser({ browser, version }: { browser: string; version?: string }) {
  if (!browser) return <span className="muted">—</span>
  return (
    <span className="with-icon">
      <BrowserIcon browser={browser} />
      {version ? `${browser} ${version}` : browser}
    </span>
  )
}

export function Device({ type }: { type: string }) {
  if (!type) return <span className="muted">—</span>
  return (
    <span className="with-icon">
      <DeviceIcon type={type} />
      {humanize(type)}
    </span>
  )
}

export function Os({ os, version }: { os: string; version?: string }) {
  if (!os) return <span className="muted">—</span>
  return (
    <span className="with-icon">
      <OsIcon os={os} />
      {version ? `${os} ${version}` : os}
    </span>
  )
}

/** A report key shown with its flag or icon when the dimension has one; null otherwise. */
export function dimIcon(dim: string, key: string): ReactNode {
  if (!key) return null
  if (dim === 'country') return <Flag code={key} />
  if (dim === 'device_type') return <DeviceIcon type={key} />
  if (dim === 'os') return <OsIcon os={key} />
  if (dim === 'browser') return <BrowserIcon browser={key} />
  return null
}
