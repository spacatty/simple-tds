import { useState } from 'react'
import { FolderOpen, UserPlus } from 'lucide-react'
import { get, put } from '../api'
import { useLoad } from '../hooks'
import type { Campaign, CampaignGroup, DirectoryEntry, GroupShare } from '../types'
import { Card, Empty, ErrorBox, Notice, Select, Skeleton, toast, useBusy } from '../components/ui'
import { t, tx } from '../i18n'

type Kind = 'campaign' | 'group'
interface Level {
  value: string
  label: string
  help: string
}

const LEVELS: Record<Kind, Level[]> = {
  campaign: [
    { value: 'stats', label: t('Stats only'), help: t('Reports, clicks and conversions for this campaign; no configuration.') },
    { value: 'read', label: t('Read-only'), help: t('Also sees streams and settings, but cannot change them.') },
    { value: 'edit', label: t('Can edit'), help: t('Can change streams and settings, and may use the campaign on their own domains and postback keys.') },
  ],
  group: [
    { value: 'stats', label: t('Stats only'), help: t('Reports, clicks and conversions for every campaign of the group; no configuration.') },
    { value: 'read', label: t('Read-only'), help: t('Also sees their streams and settings, but cannot change them.') },
    { value: 'edit', label: t('Can edit'), help: t('Can change their streams and settings, and may use the campaigns on their own domains and postback keys.') },
  ],
}
export const accessLabel = (access: string) => LEVELS.campaign.find((l) => l.value === access)?.label ?? access

/** One person on a share list, whatever is being shared. */
interface Person {
  user_id: number
  access: string
  username: string
}

/**
 * Who has access and at what level, with a form to add someone. Works for a
 * campaign and for a campaign group: both answer GET/PUT `<endpoint>` the same way.
 */
export function SharePanel({ endpoint, ownerId, kind }: { endpoint: string; ownerId: number; kind: Kind }) {
  const shares = useLoad(() => get<Person[] | null>(endpoint), [endpoint])
  const dir = useLoad(() => get<DirectoryEntry[]>('users/directory'), [])
  const [userId, setUserId] = useState('')
  const [level, setLevel] = useState('read')
  const [busy, run] = useBusy()
  const levels = LEVELS[kind]

  const list = shares.data ?? []
  const taken = new Set(list.map((s) => s.user_id))
  const candidates = (dir.data ?? []).filter((u) => u.id !== ownerId && !taken.has(u.id))

  const setShare = (uid: number, access: string, name: string) =>
    run(async () => {
      try {
        shares.setData(await put<Person[] | null>(endpoint, { user_id: uid, access }))
        toast.ok(access === 'none' ? t('{name} no longer has access', { name }) : `${name}: ${levels.find((l) => l.value === access)?.label ?? access}`)
      } catch (e) {
        toast.err(e)
      }
    })

  return (
    <>
      <ul className="levels">
        {levels.map((l) => (
          <li key={l.value}>
            <b>{l.label}</b> — {l.help}
          </li>
        ))}
        <li>{kind === 'group' ? t('Only the owner can share, rename or delete the group, and move campaigns in and out of it.') : t('Only the owner can share or delete the campaign.')}</li>
      </ul>

      <ErrorBox error={shares.error || dir.error} retry={() => (shares.reload(), dir.reload())} />

      <div className="section-head">
        <h4>{t('People with access')}</h4>
      </div>
      {shares.loading && !shares.data ? (
        <Skeleton rows={3} />
      ) : list.length === 0 ? (
        <Empty title={t('Not shared with anyone')}>{kind === 'group' ? t('Only you and administrators can see the campaigns of this group, unless a campaign is shared on its own.') : t('Only you and administrators can see this campaign.')}</Empty>
      ) : (
        <div className="list" style={{ marginTop: 0 }}>
          {list.map((s) => (
            <div className="list-row" key={s.user_id}>
              <span className="grow strong">{s.username}</span>
              <Select value={s.access} disabled={busy} onChange={(v) => v !== s.access && setShare(s.user_id, v, s.username)} options={[...levels.map((l) => ({ value: l.value, label: l.label })), { value: 'none', label: t('Remove access') }]} />
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
          <Select value={level} onChange={setLevel} options={levels.map((l) => ({ value: l.value, label: l.label }))} />
          <button className="btn primary" disabled={busy || !userId}>
            <UserPlus size={14} /> {t('Share')}
          </button>
          <span className="muted small">{levels.find((l) => l.value === level)?.help}</span>
        </form>
      )}
    </>
  )
}

/** Campaign tab: who the campaign is shared with, directly and through its group. */
export default function Sharing({ campaign }: { campaign: Campaign }) {
  const gid = campaign.group_id ?? 0
  const groups = useLoad(() => (gid ? get<CampaignGroup[] | null>('campaign-groups') : Promise.resolve(null)), [gid])
  const viaGroup = useLoad(() => (gid ? get<GroupShare[] | null>(`campaign-groups/${gid}/shares`) : Promise.resolve(null)), [gid])
  const group = (groups.data ?? []).find((g) => g.id === gid)
  const inherited = viaGroup.data ?? []

  return (
    <Card title={t('Sharing')}>
      <p className="muted">
        {campaign.owner_name
          ? tx('This campaign belongs to <b>{owner}</b>. Give other users of this panel access to it:', { b: (c) => <b>{c}</b>, owner: campaign.owner_name })
          : tx('This campaign belongs to <b>you</b>. Give other users of this panel access to it:', { b: (c) => <b>{c}</b> })}
      </p>
      {group && inherited.length > 0 && (
        <Notice title={tx('Also shared through the group <b>{group}</b>', { b: (c) => <b>{c}</b>, group: group.name })}>
          <span className="with-icon">
            <FolderOpen size={14} />
            {inherited.map((s) => `${s.username} (${accessLabel(s.access).toLowerCase()})`).join(', ')}
          </span>
          <div className="field-help">{t('These people see every campaign of the group. With a share here as well, the higher level counts. Manage the group on the Campaigns page.')}</div>
        </Notice>
      )}
      <SharePanel endpoint={`campaigns/${campaign.id}/shares`} ownerId={campaign.owner_id} kind="campaign" />
    </Card>
  )
}
