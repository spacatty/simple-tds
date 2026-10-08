import { useState } from 'react'
import type { FormEvent } from 'react'
import { Moon, Split, Sun } from 'lucide-react'
import { ApiError, api, errMsg } from '../api'
import type { User } from '../types'
import type { Theme } from '../hooks'
import { Field } from '../components/ui'
import { LangSwitch } from '../components/LangSwitch'
import { t } from '../i18n'

// Shown instead of the login form while the installation has no users.
export default function Setup({ onDone, onTaken, theme, toggleTheme }: { onDone: (u: User) => void; onTaken: () => void; theme: Theme; toggleTheme: () => void }) {
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const mismatch = repeat !== '' && repeat !== password

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onDone(await api<User>('setup', { method: 'POST', body: { username, password }, quiet401: true }))
    } catch (err) {
      // Someone finished the setup first: the only way forward is the login form.
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) onTaken()
      else setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <LangSwitch className="login-lang" />
      <button className="icon-btn login-theme" onClick={toggleTheme} title={t('Switch theme')} aria-label={t('Switch theme')}>
        {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <form className="login card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark">
            <Split size={16} />
          </span>
          <span>TDS</span>
        </div>
        <h1>{t('Create the administrator')}</h1>
        <p className="login-lead">{t('This panel has no users yet. The account you create here has full access.')}</p>
        <Field label={t('Username')} help={t('3–32 letters, digits, dot, dash or underscore.')}>
          <input className="input" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label={t('Password')} help={t('At least 10 characters.')}>
          <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label={t('Repeat password')} error={mismatch ? t('Passwords do not match.') : undefined}>
          <input className="input" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </Field>
        {error && <div className="field-error">{error}</div>}
        <button className="btn primary block" disabled={busy || username.trim().length < 3 || password.length < 10 || repeat !== password}>
          {busy ? t('Creating…') : t('Create and sign in')}
        </button>
      </form>
    </div>
  )
}
