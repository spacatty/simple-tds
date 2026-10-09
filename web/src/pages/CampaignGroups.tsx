import { useState } from 'react'
import { ArrowLeft, Check, Folder, Pencil, Plus, Trash2, Users, X } from 'lucide-react'
import { del, errMsg, post, put } from '../api'
import type { Campaign, CampaignGroup } from '../types'
import { Modal, confirmDialog, toast, useBusy } from '../components/ui'
import { SharePanel, accessLabel } from './Sharing'
import { t, tn, tx } from '../i18n'

/** A group the viewer may manage: their own, or anybody's for an administrator. */
export const ownsGroup = (g: CampaignGroup) => g.access === 'owner'

/**
 * Campaign groups: create, rename, share and delete them. A group is a folder
 * of its owner's campaigns; sharing it shares every campaign inside.
 */
export function GroupsModal({ groups, campaigns, shareId, onClose, onChanged }: { groups: CampaignGroup[]; campaigns: Campaign[]; shareId?: number; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null)
  const [sharing, setSharing] = useState<number | null>(shareId ?? null)
  const [busy, run] = useBusy()
  const count = (g: CampaignGroup) => campaigns.filter((c) => c.group_id === g.id).length
  const mine = groups.filter(ownsGroup)
  const shared = groups.filter((g) => !ownsGroup(g))
  const shareGroup = groups.find((g) => g.id === sharing && ownsGroup(g))

  const act = (fn: () => Promise<unknown>, ok?: string) =>
    run(async () => {
      setError('')
      try {
        await fn()
        if (ok) toast.ok(ok)
        onChanged()
      } catch (e) {
        setError(errMsg(e))
      }
    })
  const create = () => act(() => post('campaign-groups', { name: name.trim() }).then(() => setName('')), t('Group created'))
  const rename = () => {
    if (!renaming) return
    const g = renaming
    setRenaming(null)
    if (g.name.trim() && g.name.trim() !== groups.find((x) => x.id === g.id)?.name) act(() => put(`campaign-groups/${g.id}`, { name: g.name.trim() }))
  }
  const remove = async (g: CampaignGroup) => {
    const n = count(g)
    const ok = await confirmDialog({
      title: t('Delete group?'),
      message: tx('Group <b>{name}</b> will be deleted. Its campaigns ({count}) are kept and become ungrouped. Everyone who had access through the group loses it at once.', { b: (c) => <b>{c}</b>, name: g.name, count: tn(n, '{n} campaign', '{n} campaigns') }),
    })
    if (ok) act(() => del(`campaign-groups/${g.id}`), t('Group deleted'))
  }

  if (shareGroup) {
    return (
      <Modal
        size="lg"
        onClose={onClose}
        title={
          <>
            <button className="icon-btn" onClick={() => setSharing(null)} title={t('Back to the groups')} aria-label={t('Back to the groups')}>
              <ArrowLeft size={16} />
            </button>{' '}
            {t('Share group “{name}”', { name: shareGroup.name })}
          </>
        }
        footer={
          <button className="btn primary" onClick={onClose}>
            {t('Done')}
          </button>
        }
      >
        <p className="muted">
          {tx('Everyone added here gets the chosen access to <b>every campaign in this group</b> ({count}) — including campaigns you move into it later.', { b: (c) => <b>{c}</b>, count: tn(count(shareGroup), '{n} campaign', '{n} campaigns') })}
        </p>
        <SharePanel endpoint={`campaign-groups/${shareGroup.id}/shares`} ownerId={shareGroup.owner_id} kind="group" />
      </Modal>
    )
  }

  return (
    <Modal
      size="md"
      title={t('Campaign groups')}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          {t('Done')}
        </button>
      }
    >
      <p className="muted">{t('Groups keep campaigns together — by client, source or team. Share a group and everyone on it gets its campaigns, present and future.')}</p>
      {mine.length === 0 ? (
        <div className="muted pad-s">{t('No groups yet.')}</div>
      ) : (
        <div className="list" style={{ marginTop: 0 }}>
          {mine.map((g) => (
            <div className="list-row" key={g.id}>
              <Folder size={15} className="muted" />
              {renaming?.id === g.id ? (
                <form
                  className="row gap-s grow"
                  onSubmit={(e) => {
                    e.preventDefault()
                    rename()
                  }}
                >
                  <input className="input input-sm grow" autoFocus maxLength={64} value={renaming.name} onChange={(e) => setRenaming({ id: g.id, name: e.target.value })} />
                  <button className="icon-btn" title={t('Save name')}>
                    <Check size={14} />
                  </button>
                  <button type="button" className="icon-btn" title={t('Cancel')} onClick={() => setRenaming(null)}>
                    <X size={14} />
                  </button>
                </form>
              ) : (
                <>
                  <span className="grow ellipsis">
                    <span className="strong">{g.name}</span> <span className="muted small">· {tn(count(g), '{n} campaign', '{n} campaigns')}</span>
                  </span>
                  <button className="btn small" onClick={() => setSharing(g.id)} title={t('Choose who gets the campaigns of this group')}>
                    <Users size={13} /> {t('Share')}
                  </button>
                  <button className="icon-btn" title={t('Rename group')} onClick={() => setRenaming({ id: g.id, name: g.name })}>
                    <Pencil size={14} />
                  </button>
                  <button className="icon-btn danger" disabled={busy} title={t('Delete group')} onClick={() => remove(g)}>
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <form
        className="row gap-s"
        style={{ marginTop: 12 }}
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) create()
        }}
      >
        <input className="input grow" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder={t('New group, e.g. Client A')} />
        <button className="btn primary" disabled={busy || !name.trim()}>
          <Plus size={14} /> {t('Create group')}
        </button>
      </form>
      {error && <div className="field-error">{error}</div>}

      {shared.length > 0 && (
        <>
          <div className="section-head">
            <h4>{t('Shared with you')}</h4>
          </div>
          <div className="list" style={{ marginTop: 0 }}>
            {shared.map((g) => (
              <div className="list-row" key={g.id}>
                <Folder size={15} className="muted" />
                <span className="grow ellipsis">
                  <span className="strong">{g.name}</span> <span className="muted small">· {tn(count(g), '{n} campaign', '{n} campaigns')}</span>
                </span>
                <span className="muted small">{g.owner_name ? t('by {name}@@owner', { name: g.owner_name }) : ''}</span>
                <span className="badge neutral">{accessLabel(g.access ?? '')}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}
