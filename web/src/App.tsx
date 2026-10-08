import { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { BarChart3, FileCode2, Globe, LayoutDashboard, LogOut, Moon, MousePointerClick, Settings as SettingsIcon, ShieldCheck, Split, Sun, Target, UserRound, Users as UsersIcon } from 'lucide-react'
import { ApiError, api, errMsg, get, onUnauthorized, post } from './api'
import { AppContext, useTheme } from './hooks'
import type { Meta, User } from './types'
import { ConfirmHost, ErrorBox, ToastHost } from './components/ui'
import Login from './pages/Login'
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

const NAV: { to: string; label: string; icon: typeof Split; end?: boolean; admin?: boolean }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/campaigns', label: 'Campaigns', icon: Split },
  { to: '/domains', label: 'Domains', icon: Globe },
  { to: '/whitepages', label: 'Whitepages', icon: FileCode2 },
  { to: '/conversions', label: 'Conversions', icon: Target },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/clicks', label: 'Clicks', icon: MousePointerClick },
  { to: '/antibot', label: 'Anti-bot', icon: ShieldCheck, admin: true },
  { to: '/users', label: 'Users', icon: UsersIcon, admin: true },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
]

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [bootError, setBootError] = useState('')
  const [theme, toggleTheme] = useTheme()

  useEffect(() => {
    onUnauthorized(() => {
      setUser(null)
      setMeta(null)
    })
    api<User>('me', { quiet401: true })
      .then(setUser)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) setUser(null)
        else {
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
        setUser(null)
        setMeta(null)
      })
  }, [])

  const ctx = useMemo(() => (user && meta ? { user, setUser, meta, logout } : null), [user, meta, logout])

  if (user === undefined) return <div className="boot">Loading…</div>

  if (!user) {
    return (
      <>
        <Login onLogin={setUser} notice={bootError} theme={theme} toggleTheme={toggleTheme} />
        <ToastHost />
      </>
    )
  }

  if (!ctx) {
    return (
      <div className="boot">
        {bootError ? <ErrorBox error={bootError} retry={loadMeta} /> : 'Loading…'}
        <ToastHost />
      </div>
    )
  }

  return (
    <AppContext.Provider value={ctx}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark">
              <Split size={16} />
            </span>
            <span>TDS</span>
          </div>
          <nav>
            {NAV.filter((n) => !n.admin || user.role === 'admin').map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
                <n.icon size={16} />
                <span>{n.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-foot">
            <button className="nav-item" onClick={toggleTheme} title="Switch theme">
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
              <span>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
            </button>
            <div className="whoami" title={`Signed in as ${user.username} (${user.role === 'admin' ? 'administrator' : 'user'})`}>
              <UserRound size={16} />
              <span className="ellipsis grow strong">{user.username}</span>
              <span className={'badge ' + (user.role === 'admin' ? 'accent' : 'neutral')}>{user.role === 'admin' ? 'admin' : 'user'}</span>
            </div>
            <button className="nav-item" onClick={logout} title="Sign out">
              <LogOut size={16} />
              <span>Sign out</span>
            </button>
          </div>
        </aside>
        <main className="main">
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
        </main>
      </div>
      <ToastHost />
      <ConfirmHost />
    </AppContext.Provider>
  )
}
