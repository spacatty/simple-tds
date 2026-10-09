import { useState } from 'react'
import { KeyRound, ShieldCheck } from 'lucide-react'
import { errMsg, post } from '../api'
import { useApp } from '../hooks'
import { Badge, Card, CopyButton, Field, PageHeader, useBusy, toast } from '../components/ui'
import { t, tx } from '../i18n'

/** The signed-in user's own account: password and two-factor. Opened from the profile menu. */
export default function AccountPage() {
  return (
    <div className="page page-narrow">
      <PageHeader title={t('Account')} sub={t('Your password and two-factor authentication.')} />
      <Account />
    </div>
  )
}

function Account() {
  const { user, setUser } = useApp()
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [pwError, setPwError] = useState('')
  const [busy, run] = useBusy()

  const [setup, setSetup] = useState<{ secret: string; url: string; qr?: string } | null>(null)
  const [code, setCode] = useState('')
  const [disablePw, setDisablePw] = useState('')
  const [totpError, setTotpError] = useState('')

  const pwProblem = next && next.length < 10 ? t('At least 10 characters') : again && next !== again ? t('Passwords do not match') : ''

  const changePassword = () =>
    run(async () => {
      setPwError('')
      try {
        await post('me/password', { current: cur, new: next })
        setCur('')
        setNext('')
        setAgain('')
        toast.ok(t('Password changed. Your other devices were signed out.'))
      } catch (e) {
        setPwError(errMsg(e))
      }
    })

  const startSetup = () =>
    run(async () => {
      setTotpError('')
      try {
        setSetup(await post<{ secret: string; url: string; qr?: string }>('me/totp/setup'))
        setCode('')
      } catch (e) {
        setTotpError(errMsg(e))
      }
    })
  const enable = () =>
    run(async () => {
      setTotpError('')
      try {
        await post('me/totp/enable', { code: code.trim() })
        setUser({ ...user, totp_enabled: true })
        setSetup(null)
        toast.ok(t('Two-factor authentication is on'))
      } catch (e) {
        setTotpError(errMsg(e))
      }
    })
  const disable = () =>
    run(async () => {
      setTotpError('')
      try {
        await post('me/totp/disable', { password: disablePw })
        setUser({ ...user, totp_enabled: false })
        setDisablePw('')
        toast.ok(t('Two-factor authentication is off'))
      } catch (e) {
        setTotpError(errMsg(e))
      }
    })

  return (
    <Card title={t('Account: {name}', { name: user.username })}>
      <div className="section-head first">
        <KeyRound size={15} />
        <h4>{t('Change password')}</h4>
      </div>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault()
          if (cur && next.length >= 10 && next === again) changePassword()
        }}
      >
        <Field label={t('Current password')} className="span-2" style={{ maxWidth: 360 }}>
          <input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} />
        </Field>
        <Field label={t('New password')} help={t('At least 10 characters.')}>
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label={t('Repeat new password')} error={pwProblem}>
          <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </Field>
        {pwError && <div className="field-error span-2">{pwError}</div>}
        <div className="form-actions span-2">
          <button className="btn primary" disabled={busy || !cur || next.length < 10 || next !== again}>
            {t('Change password')}
          </button>
          <span className="muted small">{t('Signs out your other devices; this session stays signed in.')}</span>
        </div>
      </form>

      <div className="section-head">
        <ShieldCheck size={15} />
        <h4>{t('Two-factor authentication (TOTP)')}</h4>
        {user.totp_enabled ? <Badge tone="ok">{t('enabled')}</Badge> : <Badge>{t('disabled')}</Badge>}
      </div>

      {user.totp_enabled ? (
        <form
          className="row gap wrap end"
          onSubmit={(e) => {
            e.preventDefault()
            if (disablePw) disable()
          }}
        >
          <Field label={t('Confirm with your password to turn it off')} style={{ width: 320, marginBottom: 0 }}>
            <input className="input" type="password" autoComplete="current-password" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} />
          </Field>
          <button className="btn danger-outline" disabled={busy || !disablePw}>
            {t('Disable two-factor')}
          </button>
        </form>
      ) : !setup ? (
        <div>
          <p className="muted">{t('Require a 6-digit code from an authenticator app (Google Authenticator, 1Password, Aegis…) in addition to the password.')}</p>
          <button className="btn" disabled={busy} onClick={startSetup}>
            {t('Set up two-factor authentication')}
          </button>
        </div>
      ) : (
        <div className="totp-setup">
          <p>
            {setup.qr
              ? tx('1. Scan this QR code with your authenticator app, or add the account by <b>manual entry</b> with the secret below.', { b: (c) => <b>{c}</b> })
              : tx('1. Add a new account in your authenticator app using <b>manual entry</b> with the secret below, or open the otpauth link on a device that has the app.', { b: (c) => <b>{c}</b> })}
          </p>
          {setup.qr && setup.qr.startsWith('data:image/') && <img className="totp-qr" src={setup.qr} width={200} height={200} alt={t('QR code for the authenticator app')} />}
          <div className="field-label">{t('Secret')}</div>
          <div className="url-line">
            <code className="totp-secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
            <CopyButton text={setup.secret} label={t('Copy')} />
          </div>
          <div className="field-label" style={{ marginTop: 10 }}>
            otpauth URL
          </div>
          <div className="url-line">
            <code>{setup.url}</code>
            <CopyButton text={setup.url} label={t('Copy')} />
          </div>
          <p style={{ marginTop: 14 }}>{t('2. Enter the code the app shows to confirm:')}</p>
          <form
            className="row gap"
            onSubmit={(e) => {
              e.preventDefault()
              if (code.trim()) enable()
            }}
          >
            <input className="input mono" style={{ width: 140 }} inputMode="numeric" autoComplete="one-time-code" maxLength={8} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
            <button className="btn primary" disabled={busy || !code.trim()}>
              {t('Enable')}
            </button>
            <button type="button" className="btn ghost" onClick={() => setSetup(null)}>
              {t('Cancel')}
            </button>
          </form>
          <div className="field-help">{t('Two-factor stays off until the code is confirmed. Keep the secret somewhere safe: without the app you cannot sign in (an operator can reset the password from the server CLI).')}</div>
        </div>
      )}
      {totpError && <div className="field-error">{totpError}</div>}
    </Card>
  )
}
