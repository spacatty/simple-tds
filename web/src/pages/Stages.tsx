import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowDown, ArrowUp, CornerDownLeft, GripVertical, Plus, Split, Trash2, X } from 'lucide-react'
import { errMsg, get, put } from '../api'
import { useLoad, useMeta } from '../hooks'
import type { Campaign, ConvKey, Outcome, Stage } from '../types'
import type { DateRange } from '../components/DateRangePicker'
import { Card, CopyButton, Notice, Select, useBusy, toast } from '../components/ui'
import { FunnelView } from './FunnelDrawer'
import { t, tx } from '../i18n'

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)

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
      {saved.length > 0 && (
        <Card title={t('Funnel')}>
          <FunnelView campaign={campaign} range={range} setRange={setRange} />
        </Card>
      )}
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
  // Dragging a stage by its grip: the row being moved, and where it would land.
  const [armed, setArmed] = useState(-1)
  const [drag, setDrag] = useState(-1)
  const [over, setOver] = useState<{ i: number; after: boolean } | null>(null)
  const endDrag = () => {
    setArmed(-1)
    setDrag(-1)
    setOver(null)
  }
  const drop = () => {
    if (drag >= 0 && over && over.i !== drag) {
      setRows((r) => {
        const out = r.filter((_, j) => j !== drag)
        const at = over.i + (over.after ? 1 : 0) - (drag < over.i ? 1 : 0)
        out.splice(at, 0, r[drag])
        return out
      })
    }
    endDrag()
  }

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

  const maxOut = meta.max_outcomes ?? 6
  const outs = (s: Stage) => s.outcomes ?? []
  const setOuts = (i: number, list: Outcome[]) => patch(i, { outcomes: list.length ? list : undefined })
  const patchOut = (i: number, j: number, p: Partial<Outcome>) => setOuts(i, outs(rows[i]).map((o, k) => (k === j ? { ...o, ...p } : o)))
  const renameOut = (i: number, j: number, name: string) => {
    const o = outs(rows[i])[j]
    patchOut(i, j, o.key === slug(o.name) ? { name, key: slug(name) } : { name })
  }
  // The first split is the usual pair; after that, one blank outcome at a time.
  const addOut = (i: number) =>
    setOuts(
      i,
      outs(rows[i]).length === 0
        ? [
            { key: 'ok', name: t('Success'), kind: 'ok' },
            { key: 'error', name: t('Error'), kind: 'fail' },
          ]
        : [...outs(rows[i]), { key: '', name: '', kind: '' }],
    )

  const dupes = new Set(rows.map((s) => s.key).filter((k, i, all) => k && all.indexOf(k) !== i))
  const keyError = (s: Stage) => (!/^[a-z0-9_]{1,32}$/.test(s.key) ? t('a-z, 0-9 and _ only') : s.key === 'rejected' ? t('reserved') : dupes.has(s.key) ? t('used twice') : '')
  const outError = (s: Stage, o: Outcome) => (!/^[a-z0-9_]{1,32}$/.test(o.key) ? t('a-z, 0-9 and _ only') : outs(s).filter((x) => x.key === o.key).length > 1 ? t('used twice') : '')
  const invalid = rows.some((s) => keyError(s) || outs(s).some((o) => outError(s, o)))

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
          <div
            className={'stg-row' + (drag === i ? ' dragging' : '') + (over && over.i === i && drag >= 0 && drag !== i ? (over.after ? ' drop-after' : ' drop-before') : '')}
            key={i}
            draggable={armed === i && !readOnly}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', s.key)
              setDrag(i)
            }}
            onDragEnd={endDrag}
            onDragOver={(e) => {
              if (drag < 0) return
              e.preventDefault()
              const box = e.currentTarget.getBoundingClientRect()
              const after = e.clientY > box.top + box.height / 2
              if (!over || over.i !== i || over.after !== after) setOver({ i, after })
            }}
            onDrop={(e) => {
              e.preventDefault()
              drop()
            }}
          >
            <span className={'stg-n' + (readOnly ? '' : ' grip')} title={readOnly ? undefined : t('Drag to reorder')} onMouseDown={() => !readOnly && setArmed(i)} onMouseUp={() => setArmed(-1)}>
              {!readOnly && <GripVertical size={14} />}
              {i + 1}
            </span>
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
              {outs(s).length > 0 && (
                <div className="stg-outs">
                  {outs(s).map((o, j) => (
                    <div className={'stg-out ' + (o.kind || 'none')} key={j}>
                      <Select
                        className="input-sm"
                        value={o.kind || 'none'}
                        onChange={(v) => patchOut(i, j, { kind: v === 'none' ? '' : (v as Outcome['kind']) })}
                        options={[
                          { value: 'ok', label: t('Success') },
                          { value: 'fail', label: t('Failure') },
                          { value: 'none', label: t('Neither') },
                        ]}
                      />
                      <input className="input input-sm" placeholder={t('Name, e.g. Sent')} value={o.name} maxLength={64} onChange={(e) => renameOut(i, j, e.target.value)} />
                      <input className="input input-sm mono" placeholder={t('key')} title={t('What postbacks send as outcome')} value={o.key} maxLength={32} onChange={(e) => patchOut(i, j, { key: e.target.value.toLowerCase().trim() })} />
                      <button className="icon-btn" title={t('Remove outcome')} onClick={() => setOuts(i, outs(s).filter((_, k) => k !== j))}>
                        <X size={13} />
                      </button>
                      {o.key !== '' && outError(s, o) && <div className="field-error">{t('Key: {error}', { error: outError(s, o) })}</div>}
                    </div>
                  ))}
                  {s.goal && outs(s).some((o) => o.kind === 'ok') && <div className="field-help">{t('Only a successful outcome of the goal counts as the conversion.')}</div>}
                </div>
              )}
            </div>
            <div className="stg-actions">
              <button className="icon-btn" title={outs(s).length ? t('Add outcome') : t('Split into outcomes: tell a success from a failure inside this stage')} disabled={outs(s).length >= maxOut} onClick={() => addOut(i)}>
                <Split size={14} />
              </button>
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
  const rows: (Stage & { url: string })[] = stages.length > 0 ? stages.map((st) => ({ ...st, url: st.public ? eventUrl(st.key) : postback(st.key) })) : [{ key: key?.default_type ?? 'lead', name: t('Conversion'), goal: false, public: false, url: postback(key?.default_type ?? 'lead') }]
  const split = rows.some((r) => (r.outcomes ?? []).length > 0)
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
          {(r.outcomes ?? []).map((o) => (
            <div className="slink-out" key={o.key}>
              <span className={'tag ' + (o.kind === 'ok' ? 'ok' : o.kind === 'fail' ? 'err' : '')}>{o.name}</span>
              <div className="url-line">
                <code>{`${r.url}&outcome=${o.key}`}</code>
                <CopyButton text={`${r.url}&outcome=${o.key}`} label={t('Copy')} />
              </div>
            </div>
          ))}
        </div>
      ))}
      <div className="field-help">
        {split && (
          <>
            {tx('An outcome is the same event with <code>&outcome=…</code>; without it the event only says the stage was started. Add any parameter of your own to keep details with it, for example <code>&reason=timeout</code> on an error.', { code: (c) => <code>{c}</code> })}{' '}
          </>
        )}
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
