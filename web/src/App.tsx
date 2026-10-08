import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { ApiError, api, errMsg, get, onUnauthorized, post } from './api'
import { AppContext, useTheme } from './hooks'
import type { Meta, User } from './types'
import { ConfirmHost, ErrorBox, ToastHost } from './components/ui'
import { Sidebar } from './components/Sidebar'
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
        <Sidebar user={user} theme={theme} toggleTheme={toggleTheme} logout={logout} />
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
