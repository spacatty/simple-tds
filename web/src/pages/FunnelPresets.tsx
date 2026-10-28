import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Copy, Pencil, Plus, Star, Trash2 } from 'lucide-react'
import { del, errMsg, get, post, put } from '../api'
import { useLoad } from '../hooks'
import type { Campaign, FunnelPreset, Stage } from '../types'
import { Drawer, Empty, ErrorBox, Field, PageHeader, Skeleton, confirmDialog, toast, useBusy, useDirty } from '../components/ui'
import { StageRows, stagesInvalid } from './Stages'
import { t, tn } from '../i18n'

type Draft = { id?: number; name: string; note: string; stages: Stage[] }

/** Funnels → Presets: the user's own sets of stages, ready to be copied into campaigns. */
export default function FunnelPresets() {
  const presets = useLoad(() => get<FunnelPreset[] | null>('funnel-presets'), [])
  const camps = useLoad(() => get<Campaign[] | null>('campaigns'), [])
  const [draft, setDraft] = useState<Draft | null>(null)

  // Campaigns whose funnel was copied from each preset, and those of them a newer revision can update.
  const usage = useMemo(() => {
    const out = new Map<number, { all: Campaign[]; behind: number }>()
    for (const p of presets.data ?? []) {
      const all = (camps.data ?? []).filter((c) => c.funnel_preset_id === p.id)
      out.set(p.id, { all, behind: all.filter((c) => c.funnel_preset_rev !== p.rev).length })
    }
    return out
  }, [presets.data, camps.data])

  const remove = async (p: FunnelPreset) => {
    const used = usage.get(p.id)?.all.length ?? 0
    if (
      !(await confirmDialog({
        title: t('Delete preset “{name}”?', { name: p.name }),
        message: used > 0 ? tn(used, '{n} campaign copied from it keeps its stages.', '{n} campaigns copied from it keep their stages.') : undefined,
        confirmLabel: t('Delete'),
        danger: true,
      }))
    )
      return
    try {
      await del(`funnel-presets/${p.id}`)
      toast.ok(t('Preset deleted'))
      presets.reload()
      camps.reload()
    } catch (e) {
      toast.err(errMsg(e))
    }
  }

  const edit = (p: FunnelPreset) => setDraft({ id: p.id, name: p.name, note: p.note, stages: p.stages })
  const list = useMemo(() => [...(presets.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [presets.data])

  return (
    <div className="page">
      <PageHeader title={t('Funnel presets')} sub={t('Sets of stages you reuse. Applying a preset copies its stages into a campaign; when the preset changes later, the campaign offers to update.')}>
        <button className="btn primary" onClick={() => setDraft({ name: '', note: '', stages: [] })}>
          <Plus size={14} /> {t('New preset')}
        </button>
      </PageHeader>
      <ErrorBox error={presets.error} retry={presets.reload} />
      {!presets.data && presets.loading && (
        <div className="fpc fpc-loading">
          <Skeleton rows={4} />
        </div>
      )}
      {presets.data && list.length === 0 && (
        <div className="card">
          <Empty title={t('No funnel presets yet')}>{t('Create one here, or open a campaign’s Funnel tab and save its stages as a preset.')}</Empty>
        </div>
      )}
      <div className="fpc-list">
        {list.map((p) => {
          const used = usage.get(p.id)?.all ?? []
          const outcomes = p.stages.reduce((n, st) => n + (st.outcomes?.length ?? 0), 0)
          return (
            <article className="fpc" key={p.id}>
              <header className="fpc-head">
                <div className="fpc-title">
                  <button className="fpc-name" onClick={() => edit(p)}>
                    {p.name}
                  </button>
                  <span className="fpc-meta">
                    {tn(p.stages.length, '{n} stage', '{n} stages')}
                    {outcomes > 0 && <> · {tn(outcomes, '{n} outcome', '{n} outcomes')}</>}
                  </span>
                  {p.note && <div className="fpc-note">{p.note}</div>}
                </div>
                <span className="row-actions">
                  <button className="icon-btn" title={t('Edit')} aria-label={t('Edit')} onClick={() => edit(p)}>
                    <Pencil size={14} />
                  </button>
                  <button className="icon-btn" title={t('Duplicate')} aria-label={t('Duplicate')} onClick={() => setDraft({ name: t('{name} (copy)', { name: p.name }), note: p.note, stages: p.stages })}>
                    <Copy size={14} />
                  </button>
                  <button className="icon-btn danger" title={t('Delete')} aria-label={t('Delete')} onClick={() => remove(p)}>
                    <Trash2 size={14} />
                  </button>
                </span>
              </header>
              <StageFlow stages={p.stages} />
              <footer className="fpc-foot">
                {used.length === 0 ? (
                  <span className="muted">{t('Not used by any campaign yet')}</span>
                ) : (
                  <>
                    <span className="muted">{t('Campaigns')}</span>
                    {used.slice(0, 6).map((c) => (
                      <Link key={c.id} className={'fpc-camp' + (c.funnel_preset_rev !== p.rev ? ' behind' : '')} to={`/campaigns/${c.id}?tab=funnel`} title={c.funnel_preset_rev !== p.rev ? t('Copied from an earlier version of the preset: open its funnel to update it.') : undefined}>
                        {c.name}
                      </Link>
                    ))}
                    {used.length > 6 && <span className="muted">{t('+{n} more', { n: used.length - 6 })}</span>}
                  </>
                )}
              </footer>
            </article>
          )
        })}
      </div>
      {draft && (
        <PresetEditor
          draft={draft}
          used={draft.id ? (usage.get(draft.id)?.all.length ?? 0) : 0}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null)
            presets.reload()
          }}
        />
      )}
    </div>
  )
}

/** A funnel at a glance: its stages as numbered steps on one line, each with the outcomes it is split into. */
function StageFlow({ stages }: { stages: Stage[] }) {
  return (
    <ol className="fpc-flow">
      {stages.map((s, i) => (
        <li className={'fpc-step' + (s.goal ? ' goal' : '')} key={s.key}>
          <div className="fpc-rail">
            <span className="fpc-num" title={s.goal ? t('Goal') : undefined}>
              {s.goal ? <Star size={12} /> : i + 1}
            </span>
          </div>
          <div className="fpc-stage ellipsis" title={s.key}>
            {s.name || s.key}
          </div>
          {(s.outcomes ?? []).map((o) => (
            <div key={o.key} className={'fpc-out ' + (o.kind === 'ok' ? 'ok' : o.kind === 'fail' ? 'fail' : '')} title={o.key}>
              <span className="ellipsis">{o.name || o.key}</span>
            </div>
          ))}
        </li>
      ))}
    </ol>
  )
}

function PresetEditor({ draft, used, onClose, onSaved }: { draft: Draft; used: number; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(draft.name)
  const [note, setNote] = useState(draft.note)
  const [rows, setRows] = useState<Stage[]>(draft.stages)
  const [error, setError] = useState('')
  const dirty = useDirty({ name, note, rows })
  const [busy, run] = useBusy()
  const changed = JSON.stringify(rows) !== JSON.stringify(draft.stages)
  const save = () =>
    run(async () => {
      setError('')
      try {
        const body = { name, note, stages: rows }
        if (draft.id) await put<FunnelPreset>(`funnel-presets/${draft.id}`, body)
        else await post<FunnelPreset>('funnel-presets', body)
        toast.ok(t('Preset saved'))
        onSaved()
      } catch (e) {
        setError(errMsg(e))
      }
    })
  return (
    <Drawer
      size="lg"
      onClose={onClose}
      dirty={dirty}
      title={draft.id ? t('Edit preset') : t('New preset')}
      footer={
        <>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !name.trim() || rows.length === 0 || stagesInvalid(rows)} onClick={save}>
            {busy ? t('Saving…') : t('Save')}
          </button>
        </>
      }
    >
      <Field label={t('Name')}>
        <input className="input" autoFocus={!draft.id} value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder={t('App install')} />
      </Field>
      <Field label={t('Note')}>
        <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="field-label">{t('Stages')}</div>
      <StageRows rows={rows} setRows={setRows}>
        {changed && used > 0 && <div className="field-help">{tn(used, '{n} campaign copied from this preset keeps its stages until you update it on its Funnel tab.', '{n} campaigns copied from this preset keep their stages until you update them on their Funnel tabs.')}</div>}
        {error && <div className="field-error">{error}</div>}
      </StageRows>
    </Drawer>
  )
}
