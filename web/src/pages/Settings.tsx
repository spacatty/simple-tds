import { useEffect, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { Cloud, Trash2 } from 'lucide-react'
import { ApiError, errMsg, get, post, put } from '../api'
import { useApp, useIsAdmin, useLoad, useMeta } from '../hooks'
import type { RepProviderConfig, Settings, SystemInfo } from '../types'
import { Badge, Card, Chips, CodeBlock, ErrorBox, Field, Notice, NumberInput, PageHeader, Skeleton, Tabs, Toggle, confirmDialog, toast, useBusy } from '../components/ui'
import { t, tn, ts, tx } from '../i18n'

// Published at https://www.cloudflare.com/ips/
const CLOUDFLARE_V4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22']
const CLOUDFLARE_V6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32']

const RESCUE = 'docker compose exec tds tds panel-ip on\ndocker compose restart tds'

const cidrCheck = (v: string) => (/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(v) && (v.includes('.') || v.includes(':')) ? null : t('“{v}” is not an IP address or CIDR', { v }))

export default function SettingsPage() {
  // Global settings are for administrators; everyone else has only their account, on its own page.
  if (!useIsAdmin()) return <Navigate to="/account" replace />
  return <AdminSettings />
}

type Tab = 'access' | 'network' | 'tls' | 'reputation' | 'params' | 'data'
const TABS: { value: Tab; label: string }[] = [
  { value: 'access', label: t('Panel access') },
  { value: 'network', label: t('Network') },
  { value: 'tls', label: t('TLS certificates') },
  { value: 'reputation', label: t('Domain reputation') },
  { value: 'params', label: t('Parameter names') },
  { value: 'data', label: t('Data') },
]

function AdminSettings() {
  const settings = useLoad(() => get<Settings>('settings'), [])
  const sys = useLoad(() => get<SystemInfo>('system'), [])
  // The tab lives in the query (?tab=network), so reload, Back and links from other pages keep it.
  const [sp, setSp] = useSearchParams()
  const tab = TABS.find((x) => x.value === sp.get('tab'))?.value ?? 'access'
  const s = settings.data
  // Every section stays mounted, hidden when it is not the open one: switching tabs must not throw away what was typed.
  const pane = (name: Tab) => ({ role: 'tabpanel', hidden: tab !== name })

  return (
    <div className="page page-narrow">
      <PageHeader title={t('Settings')} />
      <Tabs value={tab} onChange={(v) => setSp(v === 'access' ? {} : { tab: v }, { replace: true })} tabs={TABS} />
      <ErrorBox error={settings.error} retry={settings.reload} />
      {!s && !settings.error && <Skeleton rows={10} height={18} />}
      {s && (
        <>
          <div {...pane('access')}>
            <PanelAccess s={s} sys={sys.data} onSaved={(next) => (settings.setData(next), sys.reload())} />
          </div>
          <div {...pane('network')}>
            <Network s={s} onSaved={settings.setData} />
          </div>
          <div {...pane('tls')}>
            <TLS s={s} onSaved={settings.setData} />
          </div>
          <div {...pane('reputation')}>
            <Reputation s={s} onSaved={settings.setData} />
          </div>
          <div {...pane('params')}>
            <ParamNames s={s} onSaved={settings.setData} />
          </div>
          <div {...pane('data')}>
            <Data s={s} onSaved={settings.setData} />
          </div>
        </>
      )}
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

function Reputation({ s, onSaved }: SectionProps) {
  const defs = useMeta().reputation_providers ?? []
  const [hours, setHours] = useState<number | ''>(s.reputation?.interval_hours ?? 12)
  const [prov, setProv] = useState<Record<string, RepProviderConfig>>(s.reputation?.providers ?? {})
  useEffect(() => {
    setHours(s.reputation?.interval_hours ?? 12)
    setProv(s.reputation?.providers ?? {})
  }, [s.reputation])
  const { error, busy, save } = useSave(onSaved)
  const of = (id: string): RepProviderConfig => prov[id] ?? { enabled: false }
  const set = (id: string, p: Partial<RepProviderConfig>) => setProv((cur) => ({ ...cur, [id]: { ...(cur[id] ?? { enabled: false }), ...p } }))
  // Every provider is sent, switched off or not: the server keeps the ones that are left out.
  const body = { interval_hours: hours === '' ? 12 : hours, providers: Object.fromEntries(defs.map((d) => [d.id, of(d.id)])) }
  const missing = defs.find((d) => d.key === 'required' && of(d.id).enabled && !(of(d.id).key ?? '').trim())
  const on = defs.filter((d) => of(d.id).enabled).length

  return (
    <Card title={t('Domain reputation')} actions={on > 0 ? <Badge tone="ok">{tn(on, '{n} check on', '{n} checks on')}</Badge> : <Badge>{t('off')}</Badge>}>
      <Notice tone="info" title={t('Find out that a domain got flagged before your traffic does')}>
        {t('Each provider you switch on is asked about every enabled domain: when it is added, on “Re-check”, and then on the schedule below. The answers show on the Domains page and in the “Domains” dashboard widget; they never change how traffic is handled. A check tells the provider the domain name, so everything is off until you switch it on.')}
      </Notice>
      <div className="rep-providers">
        {defs.map((d) => {
          const p = of(d.id)
          return (
            <div key={d.id} className={'rep-provider' + (p.enabled ? ' on' : '')}>
              <Toggle checked={p.enabled} onChange={(v) => set(d.id, { enabled: v })} label={<b>{d.name}</b>} />
              <div className="field-help">{ts(d.description)}</div>
              {d.key !== '' && (p.enabled || !!p.key) && (
                <div className="rep-provider-fields">
                  <Field
                    label={d.key === 'required' ? t('API key') : t('API key (optional)')}
                    help={
                      <>
                        {ts(d.key_help)}{' '}
                        {d.key_url && (
                          <a href={d.key_url} target="_blank" rel="noreferrer noopener">
                            {t('Get a key')}
                          </a>
                        )}
                      </>
                    }
                  >
                    <input className="input mono" autoComplete="off" spellCheck={false} value={p.key ?? ''} onChange={(e) => set(d.id, { key: e.target.value.trim() })} />
                  </Field>
                  {d.threshold && (
                    <Field label={t('Flag from, engines')} help={t('How many engines must flag the domain. One or two are often false alarms.')}>
                      <NumberInput value={p.threshold ?? 2} min={1} max={50} onChange={(v) => set(d.id, { threshold: v === '' ? 2 : v })} />
                    </Field>
                  )}
                  {d.rate && (
                    <Field label={t('Requests per minute')} help={t('The quota of your key; checks are spread out to stay within it.')}>
                      <NumberInput value={p.per_minute ?? 4} min={1} max={600} onChange={(v) => set(d.id, { per_minute: v === '' ? 4 : v })} />
                    </Field>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <Field label={t('Check every, hours')} help={t('How often each domain is asked about again. With a daily quota, multiply your domains by the checks per day first.')} className="rep-interval">
        <NumberInput value={hours} min={1} max={720} onChange={setHours} />
      </Field>
      {missing && <div className="field-error">{t('{name} needs an API key to be switched on.', { name: missing.name })}</div>}
      {error && <div className="field-error">{error}</div>}
      <div className="form-actions">
        <button className="btn primary" disabled={busy || !!missing || JSON.stringify(body) === JSON.stringify({ interval_hours: s.reputation?.interval_hours ?? 12, providers: Object.fromEntries(defs.map((d) => [d.id, s.reputation?.providers?.[d.id] ?? { enabled: false }])) })} onClick={() => save({ reputation: body }, t('Reputation checks saved'))}>
          {t('Save reputation checks')}
        </button>
      </div>
    </Card>
  )
}

function ParamNames({ s, onSaved }: SectionProps) {
  const defs = useMeta().system_params ?? []
  const { reloadMeta } = useApp()
  const [names, setNames] = useState<Record<string, string[]>>(s.param_aliases ?? {})
  useEffect(() => setNames(s.param_aliases ?? {}), [s.param_aliases])
  const { error, busy, save } = useSave(onSaved)

  const check = (param: string) => (v: string) => {
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(v)) return t('“{v}” is not a parameter name: 1–40 letters, digits, _ - or .', { v })
    const owner = defs.find((d) => d.name !== param && (d.name === v || d.builtin.includes(v) || (names[d.name] ?? []).includes(v)))
    return owner ? t('“{v}” is already a name of {param}', { v, param: owner.name }) : null
  }
  const submit = async () => {
    // Every parameter is sent, an empty list included: the server keeps the ones that are left out.
    const next = await save({ param_aliases: Object.fromEntries(defs.map((d) => [d.name, names[d.name] ?? []])) }, t('Parameter names saved'))
    if (next) reloadMeta()
  }
  const dirty = defs.some((d) => (names[d.name] ?? []).join(',') !== (s.param_aliases?.[d.name] ?? []).join(','))

  return (
    <Card title={t('Parameter names')}>
      <p className="muted">
        {tx('The tracker reads these parameters from postbacks and campaign URLs. Give one more names to accept it under whatever the other side sends — for example <code>sub_id</code> for <code>click_id</code>, or <code>status</code> for <code>type</code>. The standard names keep working.', { code: (c) => <code>{c}</code> })}
      </p>
      {[...new Set(defs.map((d) => d.group))].map((group) => (
        <div key={group}>
          <div className="section-head">
            <h4>{ts(group)}</h4>
          </div>
          {defs
            .filter((d) => d.group === group)
            .map((d) => (
              <Field
                key={d.name}
                label={
                  <>
                    <code>{d.name}</code> <span className="muted">— {ts(d.label)}</span>
                  </>
                }
                help={
                  <>
                    {d.builtin.length > 0 && <>{t('Always accepted: {names}.', { names: d.builtin.join(', ') })} </>}
                    {d.macro && (names[d.name] ?? []).length > 0 && t('Also works as a macro: {macros}.', { macros: (names[d.name] ?? []).map((n) => `{${n}}`).join(' ') })}
                  </>
                }
              >
                <Chips mono values={names[d.name] ?? []} onChange={(v) => setNames((cur) => ({ ...cur, [d.name]: v }))} validate={check(d.name)} placeholder={t('Add a name and press Enter')} />
              </Field>
            ))}
        </div>
      ))}
      {error && <div className="field-error">{error}</div>}
      <div className="form-actions">
        <button className="btn primary" disabled={busy || !dirty} onClick={submit}>
          {t('Save parameter names')}
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
