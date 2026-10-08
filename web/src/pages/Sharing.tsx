import { useState } from 'react'
import { UserPlus } from 'lucide-react'
import { get, put } from '../api'
import { useLoad } from '../hooks'
import type { Campaign, DirectoryEntry, Share } from '../types'
import { Card, Empty, ErrorBox, Select, Skeleton, toast, useBusy } from '../components/ui'
import { t, tx } from '../i18n'

const LEVELS: { value: string; label: string; help: string }[] = [
  { value: 'stats', label: t('Stats only'), help: t('Reports, clicks and conversions for this campaign; no configuration.') },
  { value: 'read', label: t('Read-only'), help: t('Also sees streams and settings, but cannot change them.') },
  { value: 'edit', label: t('Can edit'), help: t('Can change streams and settings, and may use the campaign on their own domains and postback keys.') },
]

export default function Sharing({ campaign }: { campaign: Campaign }) {
  const shares = useLoad(() => get<Share[] | null>(`campaigns/${campaign.id}/shares`), [campaign.id])
  const dir = useLoad(() => get<DirectoryEntry[]>('users/directory'), [])
  const [userId, setUserId] = useState('')
  const [level, setLevel] = useState('read')
  const [busy, run] = useBusy()

  const list = shares.data ?? []
  const taken = new Set(list.map((s) => s.user_id))
  const candidates = (dir.data ?? []).filter((u) => u.id !== campaign.owner_id && !taken.has(u.id))

  const setShare = (uid: number, access: string, name: string) =>
    run(async () => {
      shares.setData(await put<Share[] | null>(`campaigns/${campaign.id}/shares`, { user_id: uid, access }))
      toast.ok(access === 'none' ? t('{name} no longer has access', { name }) : `${name}: ${LEVELS.find((l) => l.value === access)?.label ?? access}`)
    })

  return (
    <Card title={t('Sharing')}>
      <p className="muted">
        {campaign.owner_name
          ? tx('This campaign belongs to <b>{owner}</b>. Give other users of this panel access to it:', { b: (c) => <b>{c}</b>, owner: campaign.owner_name })
          : tx('This campaign belongs to <b>you</b>. Give other users of this panel access to it:', { b: (c) => <b>{c}</b> })}
      </p>
      <ul className="levels">
        {LEVELS.map((l) => (
          <li key={l.value}>
            <b>{l.label}</b> — {l.help}
          </li>
        ))}
        <li>{t('Only the owner can share or delete the campaign.')}</li>
      </ul>

      <ErrorBox error={shares.error || dir.error} retry={() => (shares.reload(), dir.reload())} />

      <div className="section-head">
        <h4>{t('People with access')}</h4>
      </div>
      {shares.loading && !shares.data ? (
        <Skeleton rows={3} />
      ) : list.length === 0 ? (
        <Empty title={t('Not shared with anyone')}>{t('Only you and administrators can see this campaign.')}</Empty>
      ) : (
        <div className="list" style={{ marginTop: 0 }}>
          {list.map((s) => (
            <div className="list-row" key={s.user_id}>
              <span className="grow strong">{s.username}</span>
              <Select
                value={s.access}
                disabled={busy}
                onChange={(v) => v !== s.access && setShare(s.user_id, v, s.username)}
                options={[...LEVELS.map((l) => ({ value: l.value, label: l.label })), { value: 'none', label: t('Remove access') }]}
              />
            </div>
          ))}
        </div>
      )}

      <div className="section-head">
        <h4>{t('Add a person')}</h4>
      </div>
      {dir.data && candidates.length === 0 ? (
        <div className="muted">{(dir.data ?? []).length <= 1 ? t('There are no other users yet. An administrator can create them on the Users page.') : t('Every user already has access.')}</div>
      ) : (
        <form
          className="row gap wrap"
          onSubmit={(e) => {
            e.preventDefault()
            const u = candidates.find((x) => String(x.id) === userId)
            if (!u) return
            setShare(u.id, level, u.username).then(() => setUserId(''))
          }}
        >
          <Select value={userId} onChange={setUserId} placeholder={t('Choose a user…')} options={candidates.map((u) => ({ value: String(u.id), label: u.username }))} />
          <Select value={level} onChange={setLevel} options={LEVELS.map((l) => ({ value: l.value, label: l.label }))} />
          <button className="btn primary" disabled={busy || !userId}>
            <UserPlus size={14} /> {t('Share')}
          </button>
          <span className="muted small">{LEVELS.find((l) => l.value === level)?.help}</span>
        </form>
      )}
    </Card>
  )
}
