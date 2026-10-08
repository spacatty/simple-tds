import { useState } from 'react'
import type { FormEvent } from 'react'
import { Moon, Split, Sun } from 'lucide-react'
import { ApiError, api, errMsg } from '../api'
import type { User } from '../types'
import type { Theme } from '../hooks'
import { Field } from '../components/ui'

export default function Login({ onLogin, notice, theme, toggleTheme }: { onLogin: (u: User) => void; notice?: string; theme: Theme; toggleTheme: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [needCode, setNeedCode] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const u = await api<User>('login', { method: 'POST', body: { username, password, code: needCode ? code : '' }, quiet401: true })
      onLogin(u)
    } catch (err) {
      if (err instanceof ApiError && err.data.totp_required) {
        // The first refusal only asks for the code; later ones mean it was wrong.
        if (needCode) setError(err.message)
        setNeedCode(true)
      } else {
        setError(errMsg(err))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <button className="icon-btn login-theme" onClick={toggleTheme} title="Switch theme" aria-label="Switch theme">
        {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <form className="login card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark">
            <Split size={16} />
          </span>
          <span>TDS</span>
        </div>
        <h1>Sign in</h1>
        {notice && <div className="field-error">{notice}</div>}
        <Field label="Username">
          <input className="input" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={needCode} />
        </Field>
        <Field label="Password">
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={needCode} />
        </Field>
        {needCode && (
          <Field label="Authenticator code" help="Enter the 6-digit code from your authenticator app.">
            <input className="input mono" autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))} />
          </Field>
        )}
        {error && <div className="field-error">{error}</div>}
        <button className="btn primary block" disabled={busy || !username || !password || (needCode && !code)}>
          {busy ? 'Signing in…' : needCode ? 'Verify' : 'Sign in'}
        </button>
        {needCode && (
          <button
            type="button"
            className="btn ghost block"
            onClick={() => {
              setNeedCode(false)
              setCode('')
              setError('')
            }}
          >
            Use a different account
          </button>
        )}
      </form>
    </div>
  )
}
