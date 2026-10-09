import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { DependencyList, Dispatch, SetStateAction } from 'react'
import type { Meta, User } from './types'
import { errMsg, put } from './api'
import { APP_NAME } from './components/Logo'

export interface Loaded<T> {
  data: T | undefined
  loading: boolean
  error: string
  reload: () => Promise<void>
  setData: Dispatch<SetStateAction<T | undefined>>
}

/** Runs an async loader on mount and whenever deps change; stale responses are ignored. */
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList): Loaded<T> {
  const [data, setData] = useState<T>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const seq = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const run = useCallback(async (silent: boolean) => {
    const id = ++seq.current
    if (!silent) setLoading(true)
    try {
      const v = await fnRef.current()
      if (id === seq.current) {
        setData(v)
        setError('')
      }
    } catch (e) {
      if (id === seq.current) setError(errMsg(e))
    } finally {
      if (id === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    run(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  const reload = useCallback(() => run(true), [run])
  return { data, loading, error, reload, setData }
}

/**
 * Calls fn every ms while active. A tick is skipped while the tab is hidden or
 * the previous call is still running, so a slow request is not restarted (and
 * its answer thrown away) by the next tick.
 */
export function useInterval(fn: () => void | Promise<void>, ms: number, active: boolean) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!active) return
    let busy = false
    const t = setInterval(async () => {
      if (busy || document.hidden) return
      busy = true
      try {
        await ref.current()
      } finally {
        busy = false
      }
    }, ms)
    return () => clearInterval(t)
  }, [ms, active])
}

/** Names the browser tab after the open page, so tabs and history entries can be told apart. */
export function useTitle(title: string | undefined) {
  useEffect(() => {
    if (!title) return
    document.title = title + ' · ' + APP_NAME
    return () => {
      document.title = APP_NAME
    }
  }, [title])
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export interface AppCtx {
  user: User
  setUser: (u: User) => void
  meta: Meta
  /** Fetches the metadata again after a setting that it reflects has changed. */
  reloadMeta: () => void
  logout: () => void
}

export const AppContext = createContext<AppCtx | null>(null)

export function useApp(): AppCtx {
  const c = useContext(AppContext)
  if (!c) throw new Error('AppContext missing')
  return c
}

export function useIsAdmin(): boolean {
  return useApp().user.role === 'admin'
}

/** Campaign access helpers: owner > edit > read > stats. */
export const ACCESS_RANK: Record<string, number> = { stats: 1, read: 2, edit: 3, owner: 4 }
export function accessRank(c: { access?: string } | undefined | null): number {
  return c ? ACCESS_RANK[c.access ?? 'owner'] ?? 0 : 0
}
export const canEdit = (c: { access?: string } | undefined | null) => accessRank(c) >= 3
export const canRead = (c: { access?: string } | undefined | null) => accessRank(c) >= 2
export const isOwner = (c: { access?: string } | undefined | null) => accessRank(c) >= 4

export function useMeta(): Meta {
  return useApp().meta
}

/**
 * A preference kept on the user's account rather than in the browser, so it is
 * the same on every device they sign in from.
 */
export function usePref<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const { user, setUser } = useApp()
  const value = (user.prefs?.[key] as T | undefined) ?? fallback
  const set = useCallback(
    (v: T) => {
      setUser({ ...user, prefs: { ...user.prefs, [key]: v } })
      // If saving fails the choice still holds until the page is reloaded.
      put<User>('me/prefs', { [key]: v }).catch(() => undefined)
    },
    [user, setUser, key],
  )
  return [value, set]
}

export type Theme = 'light' | 'dark'

export function currentTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'light' || attr === 'dark') return attr
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setTheme(currentTheme())
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  const toggle = useCallback(() => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    try {
      localStorage.setItem('tds_theme', next)
    } catch {
      /* private mode */
    }
    setTheme(next)
  }, [])
  return [theme, toggle]
}
