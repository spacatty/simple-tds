import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDown, ArrowUp, CornerDownLeft, Plus, Trash2 } from 'lucide-react'
import { errMsg, get, put } from '../api'
import { useLoad, useMeta } from '../hooks'
import type { Campaign, ConvKey, FunnelRow, Stage } from '../types'
import { DateRangePicker } from '../components/DateRangePicker'
import type { DateRange } from '../components/DateRangePicker'
import { BarList } from '../components/charts'
import type { BarItem } from '../components/charts'
import { Card, CopyButton, ErrorBox, Notice, Segmented, Select, useBusy, toast } from '../components/ui'
import { rangeParams } from '../reports'
import { fmtInt, fmtMoney, fmtSpan, humanize, ratioPct } from '../format'
import { buildSearch } from '../filters'
import { countryName } from '../countries'
import { dimIcon } from '../components/icons'
import { t, tx } from '../i18n'

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)

const GROUPS = ['total', 'day', 'country', 'device_type', 'os', 'browser', 'domain', 'ref_domain', 'keyword', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5']

/** Campaign tab: the conversion funnel — its stages, how far clicks get, and how to report each stage. */
export default function Stages({
  campaign,
  domain,
  range,
  setRange,
  readOnly,
  onSaved,
}: {
  campaign: Campaign
  domain: string
  range: DateRange
  setRange: (r: DateRange) => void
  readOnly: boolean
  onSaved: (c: Campaign) => void
}) {
  const saved = useMemo(() => campaign.stages ?? [], [campaign.stages])
  return (
    <>
      <StageEditor key={campaign.id} campaign={campaign} saved={saved} readOnly={readOnly} onSaved={onSaved} />
      {saved.length > 0 && <FunnelReport campaign={campaign} stages={saved} range={range} setRange={setRange} />}
      <HowToSend stages={saved} domain={domain} />
    </>
  )
}

function StageEditor({ campaign, saved, readOnly, onSaved }: { campaign: Campaign; saved: Stage[]; readOnly: boolean; onSaved: (c: Campaign) => void }) {
  const meta = useMeta()
  const max = meta.max_stages ?? 12
  const [rows, setRows] = useState<Stage[]>(saved)
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const dirty = JSON.stringify(rows) !== JSON.stringify(saved)

  const patch = (i: number, p: Partial<Stage>) => setRows((r) => r.map((s, j) => (j === i ? { ...s, ...p } : s)))
  // The key follows the name until it is edited by hand.
  const rename = (i: number, name: string) => patch(i, rows[i].key === slug(rows[i].name) ? { name, key: slug(name) } : { name })
  const move = (i: number, by: number) =>
    setRows((r) => {
      const out = [...r]
      ;[out[i], out[i + by]] = [out[i + by], out[i]]
      return out
    })
  const setGoal = (i: number) => setRows((r) => r.map((s, j) => ({ ...s, goal: j === i, public: j === i ? false : s.public })))

  const dupes = new Set(rows.map((s) => s.key).filter((k, i, all) => k && all.indexOf(k) !== i))
  const keyError = (s: Stage) => (!/^[a-z0-9_]{1,32}$/.test(s.key) ? t('a-z, 0-9 and _ only') : s.key === 'rejected' ? t('reserved') : dupes.has(s.key) ? t('used twice') : '')
  const invalid = rows.some((s) => keyError(s))

  const save = () =>
    run(async () => {
      setError('')
      try {
        const c = await put<Campaign>(`campaigns/${campaign.id}`, { stages: rows })
        onSaved(c)
        setRows(c.stages ?? [])
        toast.ok(t('Funnel saved'))
      } catch (e) {
        setError(errMsg(e))
      }
    })

  return (
    <Card title={t('Conversion stages')}>
      <p className="muted small">
        {tx('The steps a visitor takes after the click, in order. Each one arrives as a conversion whose <code>type</code> is the stage key. Without stages the campaign counts single conversions of the built-in types.', { code: (c) => <code>{c}</code> })}
      </p>
      <fieldset className="plain" disabled={readOnly}>
        {rows.map((s, i) => (
          <div className="stg-row" key={i}>
            <span className="stg-n">{i + 1}</span>
            <div className="stg-fields">
              <input className="input" placeholder={t('Name, e.g. Registration')} value={s.name} maxLength={64} onChange={(e) => rename(i, e.target.value)} />
              <input className="input mono" placeholder={t('key')} title={t('What postbacks send as type')} value={s.key} maxLength={32} onChange={(e) => patch(i, { key: e.target.value.toLowerCase().trim() })} />
              <div className="stg-opts">
                <label className="stg-check" title={t('The stage that counts as the conversion: it drives CR and carries the CPA cost')}>
                  <input type="radio" name="stage-goal" checked={s.goal} onChange={() => setGoal(i)} /> {t('Goal')}
                </label>
                <label className="stg-check" title={t("Can be reported from the visitor's browser with just the click id (landing and offer clicks). Never carries revenue.")}>
                  <input type="checkbox" checked={s.public} disabled={s.goal} onChange={(e) => patch(i, { public: e.target.checked })} /> {t('Browser event')}
                </label>
              </div>
              {s.key !== '' && keyError(s) && <div className="field-error">{t('Key: {error}', { error: keyError(s) })}</div>}
            </div>
            <div className="stg-actions">
              <button className="icon-btn" title={t('Move up')} disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={14} />
              </button>
              <button className="icon-btn" title={t('Move down')} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={14} />
              </button>
              <button className="icon-btn danger" title={t('Remove stage')} onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </fieldset>
      {rows.length === 0 && <div className="muted pad-s">{t('No stages yet.')}</div>}
      {rows.length > 0 && !rows.some((s) => s.goal) && <div className="field-help">{t('No goal picked: the last stage will be the goal.')}</div>}
      {dirty && saved.length > 0 && <div className="field-help">{t('Events already collected keep the key they arrived with: renaming a key starts that stage from zero.')}</div>}
      {error && <div className="field-error">{error}</div>}
      {!readOnly && (
        <div className="form-actions">
          <button className="btn" disabled={rows.length >= max} onClick={() => setRows((r) => [...r, { key: '', name: '', goal: false, public: false }])}>
            <Plus size={14} /> {t('Add stage')}
          </button>
          <button className="btn primary" disabled={busy || !dirty || invalid} onClick={save}>
            {busy ? t('Saving…') : t('Save funnel')}
          </button>
          {dirty && (
            <button className="btn ghost" onClick={() => setRows(saved)}>
              {t('Discard')}
            </button>
          )}
        </div>
      )}
    </Card>
  )
}

function FunnelReport({ campaign, stages, range, setRange }: { campaign: Campaign; stages: Stage[]; range: DateRange; setRange: (r: DateRange) => void }) {
  const meta = useMeta()
  const [group, setGroup] = useState('total')
  const [strict, setStrict] = useState('')
  const [bots, setBots] = useState('exclude')
  const keys = stages.map((s) => s.key).join(',')
  const rep = useLoad(
    () => get<{ rows: FunnelRow[] | null }>('reports/funnel', { campaign_id: campaign.id, group, strict, bots, ...rangeParams(range) }),
    [campaign.id, keys, group, strict, bots, range.from, range.to],
  )
  const rows = rep.data?.rows ?? []
  const groups = GROUPS.filter((g) => g === 'total' || meta.report_groups.includes(g))

  const total = rows[0]
  const bars: BarItem[] =
    group === 'total' && total
      ? [
          { key: '#clicks', label: t('Clicks'), value: total.clicks },
          ...stages.map((s, i): BarItem => {
            // Right after the stages change the report on screen still has the old ones.
            const st = total.steps?.[i] ?? { reached: 0, events: 0, revenue: 0 }
            const prev = i === 0 ? total.clicks : (total.steps?.[i - 1]?.reached ?? 0)
            return {
              key: s.key,
              label: s.name + (s.goal ? ' ★' : ''),
              value: st.reached,
              extra: `${t('{prev} of previous · {total} of clicks', { prev: ratioPct(st.reached, prev), total: ratioPct(st.reached, total.clicks, 2) })}${st.revenue > 0 ? ' · ' + fmtMoney(st.revenue, campaign.currency) : ''}`,
            }
          }),
        ]
      : []

  // Links into the logs: the clicks behind a number, and the events of a stage.
  const clicksLink = (extra: Record<string, string>) => '/clicks' + buildSearch({ range, filters: { campaign_id: campaign.id }, bots, extra })
  const eventsLink = (key: string) => '/conversions?' + new URLSearchParams({ campaign_id: String(campaign.id), type: key }).toString()

  return (
    <Card title={t('Funnel')} actions={<DateRangePicker value={range} onChange={setRange} />}>
      <p className="muted small">{t('Clicks of the selected period and how far each of them got since — a purchase made days later still counts for the day of its click.')}</p>
      <div className="toolbar wrap" style={{ margin: '4px 0 16px' }}>
        <Select value={group} onChange={setGroup} options={groups.map((g) => ({ value: g, label: g === 'total' ? t('Whole campaign') : t('By {dim}', { dim: humanize(g).toLowerCase() }) }))} />
        <Segmented
          small
          value={strict}
          onChange={setStrict}
          options={[
            { value: '', label: t('Any order') },
            { value: '1', label: t('In order') },
          ]}
        />
        <Segmented
          small
          value={bots}
          onChange={setBots}
          options={[
            { value: 'exclude', label: t('No bots') },
            { value: '', label: t('All traffic') },
          ]}
        />
      </div>
      {strict === '1' && <div className="field-help">{t('In order: a click reaches a stage only after passing every earlier stage first.')}</div>}
      <ErrorBox error={rep.error} retry={rep.reload} />
      {group === 'total' ? (
        <>
          <BarList items={bars} empty={rep.loading ? t('Loading…') : t('No clicks in this period')} />
          {total && (
            <div className="table-wrap funnel-steps" style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('Stage')}</th>
                    <th style={{ textAlign: 'right' }} title={t('Clicks of the period that got this far. Opens them in the click log.')}>
                      {t('Reached')}
                    </th>
                    <th style={{ textAlign: 'right' }} title={t('Clicks that got to the previous step and no further. Opens them in the click log.')}>
                      {t('Stopped before')}
                    </th>
                    <th style={{ textAlign: 'right' }} title={t('Events received for this stage, repeats included. Opens them in the conversion log.')}>
                      {t('Events')}
                    </th>
                    <th style={{ textAlign: 'right' }}>{t('Revenue')}</th>
                    <th style={{ textAlign: 'right' }} title={t('Median time from the click to its first event of this stage')}>
                      {t('Time from click')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {stages.map((s, i) => {
                    const st = total.steps?.[i] ?? { reached: 0, events: 0, revenue: 0 }
                    const prev = i === 0 ? total.clicks : (total.steps?.[i - 1]?.reached ?? 0)
                    const lost = Math.max(0, prev - st.reached)
                    const drop: Record<string, string> = { not_reached: s.key }
                    if (i > 0) drop.reached = stages[i - 1].key
                    return (
                      <tr key={s.key}>
                        <td>
                          {s.name}
                          {s.goal && ' ★'} <span className="muted mono small">{s.key}</span>
                        </td>
                        <td style={{ textAlign: 'right' }} className="nowrap">
                          <Link className="link" to={clicksLink({ reached: s.key })}>
                            {fmtInt(st.reached)}
                          </Link>{' '}
                          <span className="muted small">{ratioPct(st.reached, prev)}</span>
                        </td>
                        <td style={{ textAlign: 'right' }} className="nowrap">
                          <Link className="link" to={clicksLink(drop)}>
                            {fmtInt(lost)}
                          </Link>{' '}
                          <span className="muted small">{ratioPct(lost, prev)}</span>
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <Link className="link" to={eventsLink(s.key)}>
                            {fmtInt(st.events)}
                          </Link>
                        </td>
                        <td style={{ textAlign: 'right' }}>{st.revenue ? fmtMoney(st.revenue, campaign.currency) : <span className="muted">—</span>}</td>
                        <td style={{ textAlign: 'right' }} className="nowrap">
                          {st.reached > 0 && st.median_sec ? fmtSpan(st.median_sec) : <span className="muted">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <div className="field-help">
                {strict === '1'
                  ? t('The numbers open the matching clicks and events in the logs. The logs do not check the order of stages, so with “In order” they can show a few more clicks.')
                  : t('The numbers open the matching clicks and events in the logs.')}
              </div>
            </div>
          )}
        </>
      ) : rows.length === 0 ? (
        <div className="muted pad">{rep.loading ? t('Loading…') : t('No clicks in this period')}</div>
      ) : (
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>{humanize(group)}</th>
                <th style={{ textAlign: 'right' }}>{t('Clicks')}</th>
                {stages.map((s) => (
                  <th key={s.key} style={{ textAlign: 'right' }} title={t('{key}: clicks that reached it, and the share of the previous step', { key: s.key })}>
                    {s.name}
                  </th>
                ))}
                <th style={{ textAlign: 'right' }}>{t('Revenue')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 100).map((r) => (
                <tr key={r.key}>
                  <td className={group === 'day' ? 'mono nowrap' : ''}>
                    <span className="with-icon">
                      {dimIcon(group, r.key)}
                      {r.key === '' ? t('(empty)') : group === 'country' ? countryName(r.key) : r.key}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{fmtInt(r.clicks)}</td>
                  {r.steps.map((st, i) => (
                    <td key={i} style={{ textAlign: 'right' }} className="nowrap">
                      {fmtInt(st.reached)} <span className="muted small">{ratioPct(st.reached, i === 0 ? r.clicks : r.steps[i - 1].reached, 0)}</span>
                    </td>
                  ))}
                  <td style={{ textAlign: 'right' }}>{fmtMoney(r.steps.reduce((n, st) => n + st.revenue, 0), campaign.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 100 && <div className="field-help">{t('Showing the 100 rows with the most clicks of {total}.', { total: fmtInt(rows.length) })}</div>}
        </div>
      )}
    </Card>
  )
}

const KEY_PREF = 'tds_conv_key'

/**
 * The URLs that report conversions for a campaign, with a real conversion key filled in:
 * one per funnel stage, or a single plain postback when the campaign has no funnel.
 * onInsert, when given, offers to put a browser stage's {event:…} macro into the stream action.
 */
export function StageLinks({ stages, domain, onInsert }: { stages: Stage[]; domain: string; onInsert?: (macro: string) => void }) {
  const meta = useMeta()
  const keys = useLoad(() => get<ConvKey[] | null>('conversion-keys'), [])
  const list = useMemo(() => (keys.data ?? []).filter((k) => k.enabled), [keys.data])
  const [keyId, setKeyId] = useState(() => {
    try {
      return localStorage.getItem(KEY_PREF) ?? ''
    } catch {
      return ''
    }
  })
  // The key chosen last time, else the first one that attributes by click id.
  const key = list.find((k) => String(k.id) === keyId) ?? list.find((k) => k.attribution === 'click_id') ?? list[0]
  const choose = (v: string) => {
    setKeyId(v)
    try {
      localStorage.setItem(KEY_PREF, v)
    } catch {
      /* private mode */
    }
  }

  const base = 'https://' + (domain || 'YOUR-DOMAIN')
  const who = !key || key.attribution === 'click_id' ? '&click_id={click_id}' : key.attribution === 'ip' ? '&ip=VISITOR_IP' : ''
  const postback = (type: string) => `${base}${meta.postback_path}?key=${key ? key.key : 'YOUR_KEY'}${who}&type=${type}${key?.require_sig ? '&ts=UNIX_TIME&sig=SIGNATURE' : ''}`
  const eventUrl = (stage: string) => `${base}${meta.event_prefix ?? '/_e/'}${stage}?cid=CLICK_ID`
  const rows = stages.length > 0 ? stages.map((st) => ({ ...st, url: st.public ? eventUrl(st.key) : postback(st.key) })) : [{ key: key?.default_type ?? 'lead', name: t('Conversion'), goal: false, public: false, url: postback(key?.default_type ?? 'lead') }]
  const anyServer = rows.some((r) => !r.public)

  return (
    <div className="slinks">
      {anyServer && (
        <div className="slinks-head">
          <label className="inline-field">
            <span className="field-label">{t('Conversion key')}</span>
            <Select
              className="input-sm"
              value={key ? String(key.id) : ''}
              onChange={choose}
              placeholder={list.length ? undefined : t('No keys yet')}
              disabled={list.length === 0}
              options={list.map((k) => ({ value: String(k.id), label: k.attribution === 'click_id' ? t('{name} · by click ID', { name: k.name }) : k.attribution === 'ip' ? t('{name} · by IP', { name: k.name }) : t('{name} · by nothing', { name: k.name }) }))}
            />
          </label>
          <Link className="small" to="/conversions/keys">
            {list.length ? t('Manage keys') : t('Create a key')}
          </Link>
          {key && (
            <span className="muted small">
              {t('attribution window {hours}h', { hours: key.window_hours })}
              {key.dedupe ? ' · ' + t('one event per click and type') : ''}
            </span>
          )}
        </div>
      )}
      {anyServer && !keys.loading && list.length === 0 && <div className="field-help">{t('No enabled conversion key yet: the URLs below show YOUR_KEY until you create one.')}</div>}
      {anyServer && key?.attribution === 'none' && <div className="field-error">{t('This key does not attribute events to clicks, so they will not count for a campaign or its funnel. Pick a key that attributes by click ID or IP.')}</div>}
      {rows.map((r) => (
        <div className="slink" key={r.key}>
          <div className="slink-name">
            <b className="ellipsis">{r.name}</b>
            {r.goal && <span className="tag info">{t('goal')}</span>}
            <span className="tag">{r.public ? t('browser') : t('postback')}</span>
          </div>
          <div className="url-line">
            <code>{r.url}</code>
            {onInsert && r.public && (
              <button type="button" className="btn small" title={t("Insert {macro} into the action — the tracker replaces it with this URL for the visitor's own click", { macro: `{event:${r.key}}` })} onClick={() => onInsert('event:' + r.key)}>
                <CornerDownLeft size={13} /> {t('Insert macro')}
              </button>
            )}
            <CopyButton text={r.url} label={t('Copy')} />
          </div>
        </div>
      ))}
      <div className="field-help">
        {anyServer && key?.attribution !== 'ip' && key?.attribution !== 'none' && (
          <>
            {tx("Postbacks are sent by the network or your backend: put the <code>{click_id}</code> macro into the stream's offer URL and replace <code>{click_id}</code> above with the sender's own macro for that value.", { code: (c) => <code>{c}</code> })}{' '}
          </>
        )}
        {rows.some((r) => r.public) &&
          (onInsert
            ? tx("Browser stages need no key: the page requests the URL with the visitor's click id, or simply uses the <code>{event:…}</code> macro in the stream's content.", { code: (c) => <code>{c}</code> })
            : t("Browser stages need no key: the page requests the URL with the visitor's click id."))}
      </div>
    </div>
  )
}

function HowToSend({ stages, domain }: { stages: Stage[]; domain: string }) {
  const meta = useMeta()
  const base = 'https://' + (domain || 'YOUR-DOMAIN')
  const first = stages.find((st) => st.public)
  return (
    <Card title={stages.length > 0 ? t('Reporting stages') : t('Reporting conversions')}>
      <p className="muted small">
        {stages.length > 0
          ? tx('Every stage arrives as a conversion whose <code>type</code> is the stage key. Choose a conversion key to get ready-to-use URLs: the key decides how the event finds its click and for how long.', { code: (c) => <code>{c}</code> })
          : t('Without a funnel the campaign counts plain conversions. Choose a conversion key to get a ready-to-use postback URL.')}
      </p>
      <StageLinks stages={stages} domain={domain} />
      {first && (
        <Notice>
          {t('For a link or button on your landing page:')} <code className="small">{`onclick="navigator.sendBeacon('${base}${meta.event_prefix ?? '/_e/'}${first.key}?cid='+new URLSearchParams(location.search).get('click_id'))"`}</code>
          <br />
          {tx('Pass the click id to the landing in the stream URL (<code>?click_id={click_id}</code>). Each stage is counted once per click and accepted for 7 days after it.', { code: (c) => <code>{c}</code> })}
        </Notice>
      )}
    </Card>
  )
}
