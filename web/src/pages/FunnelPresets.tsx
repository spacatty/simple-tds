import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { del, errMsg, get, post, put } from '../api'
import { useLoad } from '../hooks'
import type { Campaign, FunnelPreset, Stage } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { Drawer, Empty, ErrorBox, Field, PageHeader, confirmDialog, toast, useBusy } from '../components/ui'
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

  const columns: Column<FunnelPreset>[] = [
    {
      key: 'name',
      title: t('Name'),
      sort: (p) => p.name.toLowerCase(),
      render: (p) => (
        <div>
          <button className="link" onClick={() => setDraft({ id: p.id, name: p.name, note: p.note, stages: p.stages })}>
            <b>{p.name}</b>
          </button>
          {p.note && <div className="muted small">{p.note}</div>}
        </div>
      ),
    },
    { key: 'stages', title: t('Stages'), render: (p) => <StageChips stages={p.stages} /> },
    {
      key: 'used',
      title: t('Campaigns'),
      sort: (p) => usage.get(p.id)?.all.length ?? 0,
      render: (p) => {
        const u = usage.get(p.id)
        if (!u || u.all.length === 0) return <span className="muted">—</span>
        return (
          <span className="fp-used">
            {u.all.slice(0, 4).map((c) => (
              <Link key={c.id} className={'tag' + (c.funnel_preset_rev !== p.rev ? ' warn' : '')} to={`/campaigns/${c.id}?tab=funnel`} title={c.funnel_preset_rev !== p.rev ? t('Copied from an earlier version of the preset: open its funnel to update it.') : undefined}>
                {c.name}
              </Link>
            ))}
            {u.all.length > 4 && <span className="muted small">{t('+{n} more', { n: u.all.length - 4 })}</span>}
          </span>
        )
      },
    },
    {
      key: 'actions',
      title: '',
      align: 'right',
      render: (p) => (
        <span className="row-actions">
          <button className="icon-btn" title={t('Edit')} onClick={() => setDraft({ id: p.id, name: p.name, note: p.note, stages: p.stages })}>
            <Pencil size={14} />
          </button>
          <button className="icon-btn" title={t('Duplicate')} onClick={() => setDraft({ name: t('{name} (copy)', { name: p.name }), note: p.note, stages: p.stages })}>
            <Copy size={14} />
          </button>
          <button className="icon-btn danger" title={t('Delete')} onClick={() => remove(p)}>
            <Trash2 size={14} />
          </button>
        </span>
      ),
    },
  ]

  return (
    <div className="page">
      <PageHeader title={t('Funnel presets')} sub={t('Sets of stages you reuse. Applying a preset copies its stages into a campaign; when the preset changes later, the campaign offers to update.')}>
        <button className="btn primary" onClick={() => setDraft({ name: '', note: '', stages: [] })}>
          <Plus size={14} /> {t('New preset')}
        </button>
      </PageHeader>
      <ErrorBox error={presets.error} retry={presets.reload} />
      <div className="card">
        <DataTable
          columns={columns}
          rows={presets.data ? (presets.data ?? []) : presets.error ? [] : undefined}
          rowKey={(p) => p.id}
          loading={presets.loading}
          defaultSort={{ key: 'name', dir: 'asc' }}
          empty={
            <Empty title={t('No funnel presets yet')}>
              {t('Create one here, or open a campaign’s Funnel tab and save its stages as a preset.')}
            </Empty>
          }
        />
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

/** A funnel at a glance: its stages in order, each with the outcomes it is split into. */
export function StageChips({ stages }: { stages: Stage[] }) {
  return (
    <span className="fp-stages">
      {stages.map((s, i) => (
        <span className="fp-stage" key={s.key}>
          {i > 0 && <span className="muted">→</span>}
          <span className={'tag' + (s.goal ? ' info' : '')} title={s.key}>
            {s.name || s.key}
            {s.goal && ' ★'}
          </span>
          {(s.outcomes ?? []).map((o) => (
            <span key={o.key} className={'tag ' + (o.kind === 'ok' ? 'ok' : o.kind === 'fail' ? 'err' : '')} title={o.key}>
              {o.name || o.key}
            </span>
          ))}
        </span>
      ))}
    </span>
  )
}

function PresetEditor({ draft, used, onClose, onSaved }: { draft: Draft; used: number; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(draft.name)
  const [note, setNote] = useState(draft.note)
  const [rows, setRows] = useState<Stage[]>(draft.stages)
  const [error, setError] = useState('')
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
