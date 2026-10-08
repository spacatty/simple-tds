import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigationType } from 'react-router-dom'
import { ApiError, api, errMsg, get, onUnauthorized, post } from './api'
import { AppContext, useTheme } from './hooks'
import { t } from './i18n'
import type { Meta, User } from './types'
import { ConfirmHost, ErrorBoundary, ErrorBox, ToastHost } from './components/ui'
import { Sidebar } from './components/Sidebar'
import Login from './pages/Login'
import Setup from './pages/Setup'
import Dashboard from './pages/Dashboard'
import Campaigns from './pages/Campaigns'
import CampaignEditor from './pages/CampaignEditor'
import Domains from './pages/Domains'
import Whitepages from './pages/Whitepages'
import Conversions from './pages/Conversions'
import Reports from './pages/Reports'
import Clicks from './pages/Clicks'
import Antibot from './pages/Antibot'
import SettingsPage from './pages/Settings'
import UsersPage from './pages/Users'

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [bootError, setBootError] = useState('')
  // True while the installation has no users: the first visitor creates the administrator.
  const [setup, setSetup] = useState(false)
  // Set when the server ends a session that was in use, so the login form can say why it appeared.
  const [expired, setExpired] = useState(false)
  const [theme, toggleTheme] = useTheme()

  // A newly opened page starts at its top; Back and Forward keep whatever the browser restores.
  const main = useRef<HTMLElement>(null)
  const loc = useLocation()
  const navType = useNavigationType()
  useEffect(() => {
    if (navType !== 'POP') main.current?.scrollTo(0, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname])

  const login = useCallback((u: User) => {
    setExpired(false)
    setUser(u)
  }, [])

  useEffect(() => {
    onUnauthorized(() => {
      setExpired(true)
      setUser(null)
      setMeta(null)
    })
    api<User>('me', { quiet401: true })
      .then(setUser)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          setSetup(e.data.setup_required === true)
          setUser(null)
        } else {
          setBootError(errMsg(e))
          setUser(null)
        }
      })
  }, [])

  const loadMeta = useCallback(() => {
    setBootError('')
    get<Meta>('meta')
      .then(setMeta)
      .catch((e) => setBootError(errMsg(e)))
  }, [])

  useEffect(() => {
    if (user && !meta) loadMeta()
  }, [user, meta, loadMeta])

  const logout = useCallback(() => {
    post('logout')
      .catch(() => undefined)
      .finally(() => {
        setExpired(false)
        setUser(null)
        setMeta(null)
      })
  }, [])

  const ctx = useMemo(() => (user && meta ? { user, setUser, meta, logout } : null), [user, meta, logout])

  if (user === undefined) return <div className="boot">{t('Loading…')}</div>

  if (!user) {
    return (
      <>
        {setup ? (
          <Setup onDone={login} onTaken={() => setSetup(false)} theme={theme} toggleTheme={toggleTheme} />
        ) : (
          <Login onLogin={login} notice={bootError || (expired ? t('Your session has ended. Sign in again to pick up where you left off.') : '')} theme={theme} toggleTheme={toggleTheme} />
        )}
        <ToastHost />
      </>
    )
  }

  if (!ctx) {
    return (
      <div className="boot">
        {bootError ? <ErrorBox error={bootError} retry={loadMeta} /> : t('Loading…')}
        <ToastHost />
      </div>
    )
  }

  return (
    <AppContext.Provider value={ctx}>
      <div className="app">
        <Sidebar user={user} theme={theme} toggleTheme={toggleTheme} logout={logout} />
        <main className="main" ref={main}>
          <ErrorBoundary key={loc.pathname}>
            <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/campaigns" element={<Campaigns />} />
            <Route path="/campaigns/:id" element={<CampaignEditor />} />
            <Route path="/campaigns/:id/:tab" element={<CampaignEditor />} />
            <Route path="/domains" element={<Domains />} />
            <Route path="/whitepages" element={<Whitepages />} />
            <Route path="/conversions" element={<Conversions />} />
            <Route path="/conversions/:tab" element={<Conversions />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/clicks" element={<Clicks />} />
            {user.role === 'admin' && <Route path="/antibot" element={<Antibot />} />}
            {user.role === 'admin' && <Route path="/users" element={<UsersPage />} />}
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </ErrorBoundary>
        </main>
      </div>
      <ToastHost />
      <ConfirmHost />
    </AppContext.Provider>
  )
}
