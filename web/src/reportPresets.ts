// The user's saved views of the report constructor. The sidebar lists the
// pinned ones and the page edits them, so both read one copy kept here.
import { useSyncExternalStore } from 'react'
import { get } from './api'
import { t } from './i18n'
import type { ReportPreset } from './types'

export const TOP_PATH = '/reports/top'

/** A view of the report constructor every user has without saving it. */
export interface BuiltinPreset {
  key: string
  name: string
  /** The dimension it ranks. */
  dim: string
}

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  { key: 'referrers', name: t('Referrers'), dim: 'ref_domain' },
  { key: 'geo', name: t('Geo'), dim: 'country' },
  { key: 'devices', name: t('Devices'), dim: 'device_type' },
  { key: 'os', name: t('Operating systems'), dim: 'os' },
]

/** The account preference that says which built-in views the sidebar lists, as their keys joined by commas. */
export const BUILTIN_PINS_PREF = 'top_builtin_pins'
export const BUILTIN_PINS_DEFAULT = 'referrers,geo'

/** Where a built-in view opens, marked with its key so the page and the sidebar know which one it is. */
export function builtinHref(b: BuiltinPreset, search = ''): string {
  const sp = new URLSearchParams(search)
  sp.set('dim', b.dim)
  sp.set('view', b.key)
  return TOP_PATH + '?' + sp.toString()
}

/** The built-in view an address shows: its mark holds only while the dimension is still the view's own. */
export function builtinOf(search: string | URLSearchParams): BuiltinPreset | undefined {
  const sp = typeof search === 'string' ? new URLSearchParams(search) : search
  if (sp.get('preset')) return undefined
  return BUILTIN_PRESETS.find((b) => b.key === sp.get('view') && b.dim === sp.get('dim'))
}

let list: ReportPreset[] | undefined
const watchers = new Set<() => void>()

function subscribe(fn: () => void) {
  watchers.add(fn)
  return () => {
    watchers.delete(fn)
  }
}

/** Fetches the presets again: after signing in and after each change. */
export async function reloadReportPresets(): Promise<void> {
  try {
    list = (await get<ReportPreset[] | null>('report-presets')) ?? []
  } catch {
    // The sidebar must not break over this; the page reports its own errors.
    list = list ?? []
  }
  watchers.forEach((fn) => fn())
}

/** Undefined until the first answer. */
export function useReportPresets(): ReportPreset[] | undefined {
  return useSyncExternalStore(subscribe, () => list)
}

/** Where a preset opens: its saved view, marked with its id so the page knows which one it shows. */
export function presetHref(p: ReportPreset): string {
  const sp = new URLSearchParams(p.query)
  sp.set('preset', String(p.id))
  return TOP_PATH + '?' + sp.toString()
}

/** The part of the page's address a preset keeps. */
export function presetQuery(sp: URLSearchParams, dim: string): string {
  const n = new URLSearchParams(sp)
  n.delete('preset')
  n.delete('view')
  // The dimension may be the page's default and absent from the address.
  n.set('dim', dim)
  return n.toString()
}
