import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { errMsg, get, put } from '../api'
import { useLoad, useMeta } from '../hooks'
import type { Campaign, FunnelRow, Stage } from '../types'
import type { DateRange } from '../components/DateRangePicker'
import { BarList } from '../components/charts'
import type { BarItem } from '../components/charts'
import { CopyButton, ErrorBox, Notice, Segmented, Select, useBusy, toast } from '../components/ui'
import { rangeParams } from '../reports'
import { fmtInt, fmtMoney, humanize, ratioPct } from '../format'

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32)

const GROUPS = ['total', 'day', 'country', 'device_type', 'os', 'browser', 'domain', 'ref_domain', 'keyword', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5']

/** Campaign tab: the conversion funnel — its stages, how far clicks get, and how to report each stage. */
export default function Stages({ campaign, domain, range, readOnly, onSaved }: { campaign: Campaign; domain: string; range: DateRange; readOnly: boolean; onSaved: (c: Campaign) => void }) {
  const saved = useMemo(() => campaign.stages ?? [], [campaign.stages])
  return (
    <div className="stack">
      <StageEditor key={campaign.id} campaign={campaign} saved={saved} readOnly={readOnly} onSaved={onSaved} />
      {saved.length > 0 && <FunnelReport campaign={campaign} stages={saved} range={range} />}
      {saved.length > 0 && <HowToSend stages={saved} domain={domain} />}
    </div>
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
  const keyError = (s: Stage) => (!/^[a-z0-9_]{1,32}$/.test(s.key) ? 'a-z, 0-9 and _ only' : s.key === 'rejected' ? 'reserved' : dupes.has(s.key) ? 'used twice' : '')
  const invalid = rows.some((s) => keyError(s))

  const save = () =>
    run(async () => {
      setError('')
      try {
        const c = await put<Campaign>(`campaigns/${campaign.id}`, { stages: rows })
        onSaved(c)
        setRows(c.stages ?? [])
        toast.ok('Funnel saved')
      } catch (e) {
        setError(errMsg(e))
      }
    })

  return (
    <div>
      <h3>Conversion stages</h3>
      <p className="muted small">
        The steps a visitor takes after the click, in order. Each one arrives as a conversion whose <code>type</code> is the stage key. Without stages the campaign counts single conversions of the built-in types.
      </p>
      <fieldset className="plain" disabled={readOnly}>
        {rows.map((s, i) => (
          <div className="stg-row" key={i}>
            <span className="stg-n">{i + 1}</span>
            <div className="stg-fields">
              <input className="input" placeholder="Name, e.g. Registration" value={s.name} maxLength={64} onChange={(e) => rename(i, e.target.value)} />
              <input className="input mono" placeholder="key" title="What postbacks send as type" value={s.key} maxLength={32} onChange={(e) => patch(i, { key: e.target.value.toLowerCase().trim() })} />
              {s.key !== '' && keyError(s) && <div className="field-error">Key: {keyError(s)}</div>}
              <div className="stg-opts">
                <label className="check" title="The stage that counts as the conversion: it drives CR and carries the CPA cost">
                  <input type="radio" name="stage-goal" checked={s.goal} onChange={() => setGoal(i)} /> Goal
                </label>
                <label className="check" title="Can be reported from the visitor's browser with just the click id (landing and offer clicks). Never carries revenue.">
                  <input type="checkbox" checked={s.public} disabled={s.goal} onChange={(e) => patch(i, { public: e.target.checked })} /> Browser event
                </label>
              </div>
            </div>
            <div className="stg-actions">
              <button className="icon-btn" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={14} />
              </button>
              <button className="icon-btn" title="Move down" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={14} />
              </button>
              <button className="icon-btn danger" title="Remove stage" onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </fieldset>
      {rows.length === 0 && <div className="muted pad-s">No stages yet.</div>}
      {rows.length > 0 && !rows.some((s) => s.goal) && <div className="field-help">No goal picked: the last stage will be the goal.</div>}
      {dirty && saved.length > 0 && <div className="field-help">Events already collected keep the key they arrived with: renaming a key starts that stage from zero.</div>}
      {error && <div className="field-error">{error}</div>}
      {!readOnly && (
        <div className="form-actions">
          <button className="btn" disabled={rows.length >= max} onClick={() => setRows((r) => [...r, { key: '', name: '', goal: false, public: false }])}>
            <Plus size={14} /> Add stage
          </button>
          <button className="btn primary" disabled={busy || !dirty || invalid} onClick={save}>
            {busy ? 'Saving…' : 'Save funnel'}
          </button>
          {dirty && (
            <button className="btn ghost" onClick={() => setRows(saved)}>
              Discard
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function FunnelReport({ campaign, stages, range }: { campaign: Campaign; stages: Stage[]; range: DateRange }) {
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
          { key: '#clicks', label: 'Clicks', value: total.clicks },
          ...stages.map((s, i): BarItem => {
            const st = total.steps[i]
            const prev = i === 0 ? total.clicks : total.steps[i - 1].reached
            return {
              key: s.key,
              label: s.name + (s.goal ? ' ★' : ''),
              value: st.reached,
              extra: `${ratioPct(st.reached, prev)} of previous · ${ratioPct(st.reached, total.clicks, 2)} of clicks${st.revenue > 0 ? ' · ' + fmtMoney(st.revenue, campaign.currency) : ''}`,
            }
          }),
        ]
      : []

  return (
    <div>
      <h3>Funnel</h3>
      <p className="muted small">Clicks of the selected period and how far each of them got since — a purchase made days later still counts for the day of its click.</p>
      <div className="toolbar wrap">
        <Select value={group} onChange={setGroup} options={groups.map((g) => ({ value: g, label: g === 'total' ? 'Whole campaign' : 'By ' + humanize(g).toLowerCase() }))} />
        <Segmented
          small
          value={strict}
          onChange={setStrict}
          options={[
            { value: '', label: 'Any order' },
            { value: '1', label: 'In order' },
          ]}
        />
        <Segmented
          small
          value={bots}
          onChange={setBots}
          options={[
            { value: 'exclude', label: 'No bots' },
            { value: '', label: 'All traffic' },
          ]}
        />
      </div>
      {strict === '1' && <div className="field-help">In order: a click reaches a stage only after passing every earlier stage first.</div>}
      <ErrorBox error={rep.error} retry={rep.reload} />
      {group === 'total' ? (
        <BarList items={bars} empty={rep.loading ? 'Loading…' : 'No clicks in this period'} />
      ) : rows.length === 0 ? (
        <div className="muted pad">{rep.loading ? 'Loading…' : 'No clicks in this period'}</div>
      ) : (
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>{humanize(group)}</th>
                <th style={{ textAlign: 'right' }}>Clicks</th>
                {stages.map((s) => (
                  <th key={s.key} style={{ textAlign: 'right' }} title={`${s.key}: clicks that reached it, and the share of the previous step`}>
                    {s.name}
                  </th>
                ))}
                <th style={{ textAlign: 'right' }}>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 100).map((r) => (
                <tr key={r.key}>
                  <td className={group === 'day' ? 'mono nowrap' : ''}>{r.key === '' ? '(empty)' : r.key}</td>
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
          {rows.length > 100 && <div className="field-help">Showing the 100 rows with the most clicks of {fmtInt(rows.length)}.</div>}
        </div>
      )}
    </div>
  )
}

function HowToSend({ stages, domain }: { stages: Stage[]; domain: string }) {
  const meta = useMeta()
  const base = 'https://' + (domain || 'YOUR-DOMAIN')
  const browser = stages.filter((s) => s.public)
  const first = browser[0]
  return (
    <div>
      <h3>Reporting stages</h3>
      <p className="muted small">
        Server side, through a <b>conversion key</b>: the same postback as any conversion, with the stage key as <code>type</code>. The key decides how the event finds its click (click id or IP) and for how long.
      </p>
      {stages
        .filter((s) => !s.public)
        .map((s) => {
          const url = `${base}${meta.postback_path}?key=YOUR_KEY&click_id={click_id}&type=${s.key}`
          return (
            <div className="url-line" key={s.key} title={s.name}>
              <code>{url}</code>
              <CopyButton text={url} label="Copy" />
            </div>
          )
        })}
      {browser.length > 0 && (
        <>
          <p className="muted small">
            From the page, for stages marked <b>Browser event</b>: no key, only the click id. Pass it to your landing in the stream URL (<code>?click_id={'{click_id}'}</code>) and request:
          </p>
          {browser.map((s) => {
            const url = `${base}${meta.event_prefix ?? '/_e/'}${s.key}?cid=CLICK_ID`
            return (
              <div className="url-line" key={s.key} title={s.name}>
                <code>{url}</code>
                <CopyButton text={url} label="Copy" />
              </div>
            )
          })}
          {first && (
            <Notice>
              For a link or button:{' '}
              <code className="small">{`onclick="navigator.sendBeacon('${base}${meta.event_prefix ?? '/_e/'}${first.key}?cid='+new URLSearchParams(location.search).get('click_id'))"`}</code>
              <br />
              Each stage is counted once per click and accepted for 7 days after it.
            </Notice>
          )}
        </>
      )}
    </div>
  )
}
