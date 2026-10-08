import { useState } from 'react'
import { Bot, Check, Play, X } from 'lucide-react'
import { errMsg, post } from '../api'
import { useMeta } from '../hooks'
import type { Campaign, Domain, SimResult } from '../types'
import { Badge, Card, Empty, Field, Notice, Segmented, Select } from '../components/ui'
import { COUNTRY_SELECT_OPTIONS } from '../components/CountrySelect'
import { countryLabel } from '../countries'

const UA_PRESETS: { label: string; ua: string }[] = [
  { label: 'Chrome · Windows desktop', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
  { label: 'Chrome · Android mobile', ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36' },
  { label: 'Safari · iPhone', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
  { label: 'Safari · macOS', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15' },
  { label: 'Googlebot', ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
  { label: 'Facebook crawler', ua: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
  { label: 'curl', ua: 'curl/8.5.0' },
]

interface SimForm {
  ip: string
  user_agent: string
  country: string
  language: string
  referer: string
  query: string
  domain: string
  force_bot: string
}

/** prefill: values taken from a recorded click ("Simulate this visitor"); stacked: single-column layout for a narrow pane. */
export default function Simulator({ campaign, domains, prefill, stacked }: { campaign: Campaign; domains: Domain[]; prefill?: Partial<Record<keyof SimForm, string | undefined>>; stacked?: boolean }) {
  const meta = useMeta()
  const [f, setF] = useState<SimForm>(() => {
    const base: SimForm = { ip: '8.8.8.8', user_agent: UA_PRESETS[0].ua, country: '', language: 'en', referer: '', query: '', domain: '', force_bot: 'auto' }
    for (const [k, v] of Object.entries(prefill ?? {})) if (v !== undefined) base[k as keyof SimForm] = v
    return base
  })
  const fromClick = !!prefill && Object.values(prefill).some((v) => v !== undefined)
  const [res, setRes] = useState<SimResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<SimForm>) => setF((x) => ({ ...x, ...patch }))

  const run = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await post<SimResult>('simulate', {
        campaign_id: campaign.id,
        ip: f.ip.trim(),
        user_agent: f.user_agent,
        country: f.country,
        language: f.language.trim(),
        referer: f.referer.trim(),
        query: f.query.trim(),
        domain: f.domain,
        force_bot: f.force_bot === 'auto' ? null : f.force_bot === 'yes',
      })
      setRes(r)
    } catch (e) {
      setError(errMsg(e))
      setRes(null)
    } finally {
      setBusy(false)
    }
  }

  const filterLabel = (t: string) => meta.filters.find((x) => x.type === t)?.label ?? t
  const actionLabel = (t: string) => meta.actions.find((x) => x.type === t)?.label ?? t
  const preset = UA_PRESETS.find((p) => p.ua === f.user_agent)

  return (
    <div className={stacked ? 'stack' : 'grid-sim'}>
      <Card title="Hypothetical visitor">
        <p className="muted">Shows which stream a visitor would get. Nothing is recorded and the action is not executed.</p>
        {fromClick && <Notice>Prefilled from a recorded click. Cookies, TLS fingerprint and other headers of the original request are not replayed, so the verdict can differ.</Notice>}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            run()
          }}
        >
          <Field label="IP address" help="Used for the geo lookup and IP-list checks.">
            <input className="input mono" value={f.ip} onChange={(e) => set({ ip: e.target.value })} placeholder="8.8.8.8" />
          </Field>
          <Field label="User-Agent">
            <Select value={preset ? preset.ua : ''} placeholder="Custom…" onChange={(ua) => ua && set({ user_agent: ua })} options={UA_PRESETS.map((p) => ({ value: p.ua, label: p.label }))} />
            <textarea className="input mono" rows={3} style={{ marginTop: 6 }} value={f.user_agent} onChange={(e) => set({ user_agent: e.target.value })} spellCheck={false} />
          </Field>
          <div className="row gap">
            <Field label="Country override" help="Empty = from the geo database." className="grow">
              <Select value={f.country} onChange={(country) => set({ country })} placeholder="Auto (by IP)" options={COUNTRY_SELECT_OPTIONS} />
            </Field>
            <Field label="Language" style={{ width: 110 }}>
              <input className="input mono" value={f.language} onChange={(e) => set({ language: e.target.value })} placeholder="en" />
            </Field>
          </div>
          <Field label="Referrer">
            <input className="input mono" value={f.referer} onChange={(e) => set({ referer: e.target.value })} placeholder="https://www.facebook.com/" />
          </Field>
          <Field label="Query string">
            <input className="input mono" value={f.query} onChange={(e) => set({ query: e.target.value })} placeholder="sub1=abc&keyword=shoes" />
          </Field>
          <Field label="Domain" help="Only matters for streams with a Domain filter.">
            <Select value={f.domain} onChange={(domain) => set({ domain })} placeholder="Not set" options={domains.map((d) => ({ value: d.name, label: d.name }))} />
          </Field>
          <Field label="Bot verdict" help="Auto runs the real detection; Yes/No overrides its result.">
            <Segmented
              value={f.force_bot}
              onChange={(force_bot) => set({ force_bot })}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'yes', label: 'Force bot' },
                { value: 'no', label: 'Force human' },
              ]}
            />
          </Field>
          {error && <div className="field-error">{error}</div>}
          <div className="form-actions">
            <button className="btn primary" disabled={busy}>
              <Play size={14} /> {busy ? 'Running…' : 'Simulate'}
            </button>
          </div>
        </form>
      </Card>

      <div className="stack">
        {!res ? (
          <Card>
            <Empty title="Run a simulation">Fill in the visitor on the left to see the verdict and the per-stream trace.</Empty>
          </Card>
        ) : (
          <>
            <Card title="Verdict">
              <div className="verdict">
                <div className={'verdict-main ' + (res.bot ? 'bot' : 'human')}>
                  <Bot size={22} />
                  <div>
                    <b>{res.bot ? 'Bot' : 'Human'}</b>
                    <span>score {res.score}</span>
                  </div>
                </div>
                <dl className="kv">
                  <dt>Datacenter / VPN</dt>
                  <dd>{res.datacenter ? <Badge tone="warn">yes</Badge> : 'no'}</dd>
                  <dt>Reasons</dt>
                  <dd>{res.reasons.length ? res.reasons.map((r) => <Badge key={r} tone="warn">{r}</Badge>) : <span className="muted">none</span>}</dd>
                  <dt>Geo</dt>
                  <dd>
                    {res.geo.country ? countryLabel(res.geo.country) : <span className="muted">unknown country</span>}
                    {res.geo.region && ` · ${res.geo.region}`}
                    {res.geo.city && ` · ${res.geo.city}`}
                  </dd>
                  <dt>Network</dt>
                  <dd>{res.geo.asn ? `AS${res.geo.asn} ${res.geo.isp}` : res.geo.isp || <span className="muted">unknown</span>}</dd>
                  <dt>Device</dt>
                  <dd>{[res.device_type, res.os, res.browser].filter(Boolean).join(' · ') || <span className="muted">unknown</span>}</dd>
                  <dt>Result</dt>
                  <dd>
                    <Badge tone={res.stream_id ? 'ok' : 'err'}>{res.stream_id ? actionLabel(res.action) : 'No stream → 404'}</Badge>
                  </dd>
                </dl>
              </div>
              {res.note && <Notice tone={res.stream_id ? 'info' : 'warn'}>{res.note}</Notice>}
            </Card>

            <Card title="Stream trace">
              {res.streams.length === 0 && <div className="muted">This campaign has no enabled streams.</div>}
              <div className="trace">
                {res.streams.map((s) => (
                  <div key={s.id} className={'trace-row' + (s.chosen ? ' chosen' : s.matched ? ' matched' : '')}>
                    <div className="trace-head">
                      <span className={'trace-mark ' + (s.matched ? 'pass' : 'fail')}>{s.matched ? <Check size={13} /> : <X size={13} />}</span>
                      <b>{s.name}</b>
                      <Badge>{s.kind}</Badge>
                      {s.chosen && <Badge tone="ok">chosen</Badge>}
                      {s.matched && !s.chosen && <Badge tone="info" title="Its filters match, but another stream was selected (earlier stream, or the weighted draw)">matched, not selected</Badge>}
                      {s.note && <span className="muted">{s.note}</span>}
                    </div>
                    <div className="trace-filters">
                      {s.filters.length === 0 ? (
                        !s.note && <span className="muted">no filters — matches everyone</span>
                      ) : (
                        s.filters.map((ft, i) => (
                          <span key={i} className={'tf ' + (ft.passed ? 'pass' : 'fail')}>
                            {ft.passed ? <Check size={12} /> : <X size={12} />}
                            {filterLabel(ft.type)} {ft.negated ? 'is not' : 'is'}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="field-help">Streams after the chosen one are not evaluated. In weight rotation the pick among matching regular streams is random, so repeated runs may choose differently.</div>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
