import { useEffect, useState } from 'react'
import { Cloud, KeyRound, ShieldCheck, Trash2 } from 'lucide-react'
import { ApiError, errMsg, get, post, put } from '../api'
import { useApp, useIsAdmin, useLoad } from '../hooks'
import type { Settings, SystemInfo } from '../types'
import { Badge, Card, Chips, CodeBlock, CopyButton, ErrorBox, Field, Notice, NumberInput, PageHeader, Skeleton, Toggle, confirmDialog, toast, useBusy } from '../components/ui'
import { t, tn, tx } from '../i18n'

// Published at https://www.cloudflare.com/ips/
const CLOUDFLARE_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22']
const CLOUDFLARE_V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32']

const RESCUE = 'docker compose exec tds tds panel-ip on\ndocker compose restart tds'

const cidrCheck = (v: string) => (/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(v) && (v.includes('.') || v.includes(':')) ? null : t('“{v}” is not an IP address or CIDR', { v }))

export default function SettingsPage() {
  // Global settings are for administrators; everyone else only manages their own account.
  if (!useIsAdmin()) {
    return (
      <div className="page page-narrow">
        <PageHeader title={t('Settings')} sub={t('Your account. Global settings are managed by administrators.')} />
        <Account />
      </div>
    )
  }
  return <AdminSettings />
}

function AdminSettings() {
  const settings = useLoad(() => get<Settings>('settings'), [])
  const sys = useLoad(() => get<SystemInfo>('system'), [])

  return (
    <div className="page page-narrow">
      <PageHeader title={t('Settings')} />
      <ErrorBox error={settings.error} retry={settings.reload} />
      {!settings.data ? (
        !settings.error && <Skeleton rows={10} height={18} />
      ) : (
        <div className="stack">
          <PanelAccess s={settings.data} sys={sys.data} onSaved={(s) => (settings.setData(s), sys.reload())} />
          <Network s={settings.data} onSaved={settings.setData} />
          <TLS s={settings.data} onSaved={settings.setData} />
          <Data s={settings.data} onSaved={settings.setData} />
        </div>
      )}
      <div className="stack" style={{ marginTop: 16 }}>
        <Account />
      </div>
    </div>
  )
}

interface SectionProps {
  s: Settings
  onSaved: (s: Settings) => void
}

/** Saves a subset of the settings document; the server keeps every field that is not sent. */
function useSave(onSaved: (s: Settings) => void) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (patch: Partial<Settings>, okText: string): Promise<Settings | null> => {
    setBusy(true)
    setError('')
    try {
      const s = await put<Settings>('settings', patch)
      onSaved(s)
      toast.ok(okText)
      return s
    } catch (e) {
      setError(errMsg(e))
      return null
    } finally {
      setBusy(false)
    }
  }
  return { error, busy, save }
}

function PanelAccess({ s, sys, onSaved }: SectionProps & { sys?: SystemInfo }) {
  const [adminPath, setAdminPath] = useState(s.admin_path)
  const [hours, setHours] = useState<number | ''>(s.session_hours)
  const [ipAccess, setIpAccess] = useState(s.panel_ip_access)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState('')
  useEffect(() => {
    setAdminPath(s.admin_path)
    setHours(s.session_hours)
    setIpAccess(s.panel_ip_access)
    // By field: saving another card replaces s and must not undo edits here.
  }, [s.admin_path, s.session_hours, s.panel_ip_access])

  const domainOK = sys?.panel?.admin_domain_ok ?? false
  const forced = sys?.panel?.ip_access_force ?? false
  const pathErr = /^[A-Za-z0-9_-]{3,64}$/.test(adminPath) ? '' : t('3–64 letters, digits, - or _')
  const viaIP = /^(\d{1,3}\.){3}\d{1,3}$/.test(window.location.hostname) || window.location.hostname.includes(':') || window.location.hostname === 'localhost'
  // Turning it off is only allowed with a verified panel domain; turning it back on is always allowed.
  const canTurnOff = domainOK
  const dirty = adminPath !== s.admin_path || hours !== s.session_hours || ipAccess !== s.panel_ip_access

  const submit = async () => {
    setRefused('')
    if (!ipAccess && s.panel_ip_access) {
      const ok = await confirmDialog({
        title: t('Turn off ip:port access?'),
        confirmLabel: t('Turn off'),
        message: (
          <>
            {tx('The panel will only be reachable at <code>{url}</code> on domains with panel access enabled.', { code: (c) => <code>{c}</code>, url: `https://your-domain/${adminPath}/` })}
            {viaIP && (
              <>
                {' '}
                <b>{t('You are using ip:port right now — this page stops working as soon as you save.')}</b>
              </>
            )}{' '}
            {t('If you get locked out, run the rescue command on the server.')}
          </>
        ),
      })
      if (!ok) return
    }
    const oldPath = s.admin_path
    setBusy(true)
    try {
      setError('')
      const next = await put<Settings>('settings', { admin_path: adminPath, session_hours: hours === '' ? 72 : hours, panel_ip_access: ipAccess })
      onSaved(next)
      toast.ok(t('Panel access saved'))
      // On a domain the panel lives under the admin path: follow it when it changes.
      if (next.admin_path !== oldPath && window.location.pathname.startsWith(`/${oldPath}/`)) {
        window.location.href = `/${next.admin_path}/`
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setRefused(e.message)
        setIpAccess(true)
      } else setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title={t('Panel access')}>
      <div className="form-grid">
        <Field label={t('Admin path')} error={pathErr} help={t('On domains with panel access the panel is served at https://domain/{path}/. Pick something unguessable. It cannot collide with a campaign alias.', { path: adminPath || '…' })}>
          <input className="input mono" value={adminPath} onChange={(e) => setAdminPath(e.target.value.trim())} />
        </Field>
        <Field label={t('Session lifetime, hours')} help={t('How long a sign-in stays valid. Applies to new sign-ins.')}>
          <NumberInput value={hours} min={1} onChange={setHours} />
        </Field>
      </div>

      <div className="section-head">
        <h4>{t('Access by ip:port')}</h4>
        {sys && (domainOK ? <Badge tone="ok">{t('verified panel domain available')}</Badge> : <Badge tone="warn">{t('no verified panel domain')}</Badge>)}
      </div>
      <Field
        help={
          <>
            {t("When on, the panel is also served directly on the server's IP address and port (plain HTTP). Turn it off once you use the panel through a domain, so the panel cannot be found by scanning IP addresses.")}
          </>
        }
      >
        <Toggle checked={ipAccess} onChange={setIpAccess} disabled={(!canTurnOff && ipAccess && s.panel_ip_access) || forced} label={t('Serve the panel on ip:port')} />
      </Field>
      {forced && <Notice tone="warn">{t('ip:port access is currently forced on by the server environment (TDS_FORCE_PANEL_IP=1), whatever this switch says.')}</Notice>}
      {!domainOK && s.panel_ip_access && (
        <Notice tone="info" title={t('This switch is locked for now')}>
          {tx('It can only be turned off when at least one domain with <b>Panel</b> access enabled has passed its check (status OK) — otherwise there would be no way into the panel. Add a domain on the Domains page, enable its Panel toggle and wait for the status to turn OK.', { b: (c) => <b>{c}</b> })}
        </Notice>
      )}
      {refused && (
        <Notice tone="err" title={t('The server refused to turn off ip:port access')}>
          {refused}
        </Notice>
      )}
      <div className="field-label" style={{ marginTop: 12 }}>
        {t('Locked out? Run this on the server to switch ip:port access back on, then restart:')}
      </div>
      <CodeBlock text={RESCUE} />

      {error && <div className="field-error">{error}</div>}
      <div className="form-actions">
        <button className="btn primary" disabled={busy || !dirty || !!pathErr} onClick={submit}>
          {t('Save panel access')}
        </button>
      </div>
    </Card>
  )
}

function Network({ s, onSaved }: SectionProps) {
  const [proxyProtocol, setProxyProtocol] = useState(s.proxy_protocol)
  const [proxies, setProxies] = useState<string[]>(s.trusted_proxies ?? [])
  const { error, busy, save } = useSave(onSaved)
  const addCF = () => {
    const next = [...proxies]
    for (const r of [...CLOUDFLARE_V4, ...CLOUDFLARE_V6]) if (!next.includes(r)) next.push(r)
    setProxies(next)
  }
  const hasCF = CLOUDFLARE_V4.every((r) => proxies.includes(r)) && CLOUDFLARE_V6.every((r) => proxies.includes(r))
  return (
    <Card title={t('Network')}>
      <Notice tone="info" title={t("Who may tell the server the visitor's real IP")}>
        {tx('Forwarding headers (CF-Connecting-IP, X-Forwarded-For, X-Real-IP) and PROXY protocol headers are honoured <b>only</b> when the connection comes from one of the trusted proxy addresses below. From any other address they are ignored and the socket address is used — otherwise anyone could fake their IP and country.', { b: (c) => <b>{c}</b> })}
      </Notice>
      <Field label={t('Trusted proxies ({n})', { n: proxies.length })} help={t('IP addresses or CIDR ranges of your CDN, load balancer or reverse proxy.')}>
        <Chips mono values={proxies} onChange={setProxies} validate={cidrCheck} placeholder={t('10.0.0.1 or 172.16.0.0/12')} />
      </Field>
      <div className="row gap-s wrap">
        <button className="btn small" onClick={addCF} disabled={hasCF}>
          <Cloud size={14} /> {hasCF ? t('Cloudflare ranges added') : t('Add Cloudflare ranges')}
        </button>
        {proxies.length > 0 && (
          <button className="btn small ghost" onClick={() => setProxies([])}>
            <Trash2 size={14} /> {t('Clear all')}
          </button>
        )}
        <span className="muted small">
          {t('{v4} IPv4 + {v6} IPv6 ranges from cloudflare.com/ips', { v4: CLOUDFLARE_V4.length, v6: CLOUDFLARE_V6.length })}
        </span>
      </div>
      <Field
        style={{ marginTop: 14 }}
        help={t('Enable only if a TCP load balancer (HAProxy, AWS NLB, …) in front of this server sends the PROXY protocol header. Requires at least one trusted proxy; connections from other addresses are treated as direct.')}
      >
        <Toggle checked={proxyProtocol} onChange={setProxyProtocol} label={t('Accept PROXY protocol')} />
      </Field>
      {proxyProtocol && proxies.length === 0 && <div className="field-error">{t('PROXY protocol needs at least one trusted proxy address.')}</div>}
      {error && <div className="field-error">{error}</div>}
      <div className="form-actions">
        <button className="btn primary" disabled={busy || (proxyProtocol && proxies.length === 0)} onClick={() => save({ proxy_protocol: proxyProtocol, trusted_proxies: proxies }, t('Network settings saved'))}>
          {t('Save network settings')}
        </button>
      </div>
    </Card>
  )
}

function TLS({ s, onSaved }: SectionProps) {
  const [email, setEmail] = useState(s.acme_email)
  const [staging, setStaging] = useState(s.acme_staging)
  const { error, busy, save } = useSave(onSaved)
  return (
    <Card title={t('TLS certificates')}>
      <div className="form-grid">
        <Field label={t('ACME account email (optional)')} help={t('Leave empty to register a separate account per domain as acme@<domain>. Set it to use one address for all certificates.')}>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value.trim())} placeholder="admin@example.com" />
        </Field>
        <Field help={t('Issue test certificates from the Let’s Encrypt staging environment (not trusted by browsers, but with much higher rate limits). For trying things out only.')}>
          <Toggle checked={staging} onChange={setStaging} label={t('Use Let’s Encrypt staging')} />
        </Field>
      </div>
      <Notice>{t('Let’s Encrypt allows about 10 new accounts per server IP per 3 hours. With the email left empty every new domain registers its own account, so a large bulk import of new domains gets its certificates gradually rather than all at once.')}</Notice>
      {error && <div className="field-error">{error}</div>}
      <div className="form-actions">
        <button className="btn primary" disabled={busy || (email === s.acme_email && staging === s.acme_staging)} onClick={() => save({ acme_email: email, acme_staging: staging }, t('TLS settings saved'))}>
          {t('Save TLS settings')}
        </button>
      </div>
    </Card>
  )
}

function Data({ s, onSaved }: SectionProps) {
  const [days, setDays] = useState<number | ''>(s.retention_days)
  const { error, busy, save } = useSave(onSaved)
  const [purging, run] = useBusy()
  const submit = async () => {
    const n = days === '' ? 180 : days
    if (n < s.retention_days && !(await confirmDialog({ title: t('Shorten retention?'), confirmLabel: t('Shorten'), message: tx('Clicks and conversions older than <b>{days}</b> will be deleted permanently.', { b: (c) => <b>{c}</b>, days: tn(n, '{n} day@@older than', '{n} days@@older than') }) }))) return
    save({ retention_days: n }, t('Retention saved'))
  }
  return (
    <Card title={t('Data')}>
      <div className="form-grid">
        <Field label={t('Keep clicks and conversions for, days')} help={t('Older rows are removed automatically from the statistics database.')}>
          <NumberInput value={days} min={1} onChange={setDays} />
        </Field>
        <Field label={t('Remote JavaScript cache')} help={t('Forces every “JavaScript from URL” action to fetch its source again on the next click.')}>
          <button
            className="btn"
            disabled={purging}
            onClick={() =>
              run(async () => {
                await post('cache/purge')
                toast.ok(t('Remote JavaScript cache purged'))
              })
            }
          >
            {t('Purge cache')}
          </button>
        </Field>
      </div>
      {error && <div className="field-error">{error}</div>}
      <div className="form-actions">
        <button className="btn primary" disabled={busy || days === s.retention_days} onClick={submit}>
          {t('Save retention')}
        </button>
      </div>
    </Card>
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
