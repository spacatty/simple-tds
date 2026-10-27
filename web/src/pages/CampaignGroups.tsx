import { useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ChevronDown, Pencil, Pin, PinOff, Plus, Trash2, Users } from 'lucide-react'
import { del, errMsg, post, put } from '../api'
import type { Campaign, CampaignGroup } from '../types'
import { Field, Modal, confirmDialog, toast, useBusy } from '../components/ui'
import { ActionMenu } from '../components/ActionMenu'
import type { MenuAction } from '../components/ActionMenu'
import { SharePanel } from './Sharing'
import { t, tn, tx } from '../i18n'

/** A group the viewer may manage: their own, or anybody's for an administrator. */
export const ownsGroup = (g: CampaignGroup) => g.access === 'owner'

/** '' = every campaign, 'none' = the ungrouped ones, else a group id. */
export type GroupTab = string

/** Beyond this many groups the strip folds the rest into a "More" menu. */
const MAX_TABS = 7

/**
 * The group strip above the campaign list: All, each group, Ungrouped, and a "+" to
 * create one. The open group's chevron holds its own actions.
 */
export function GroupTabs({
  groups,
  value,
  onChange,
  count,
  ungrouped,
  isPinned,
  onPin,
  onRename,
  onShare,
  onDelete,
  onCreate,
}: {
  groups: CampaignGroup[]
  value: GroupTab
  onChange: (v: GroupTab) => void
  count: (g: CampaignGroup) => number
  /** How many campaigns have no group; the tab shows when groups exist and some campaign is outside them. */
  ungrouped: number
  isPinned: (g: CampaignGroup) => boolean
  onPin: (g: CampaignGroup, pinned: boolean) => void
  onRename: (g: CampaignGroup) => void
  onShare: (g: CampaignGroup) => void
  onDelete: (g: CampaignGroup) => void
  onCreate: () => void
}) {
  const active = groups.find((g) => String(g.id) === value)
  // The open group always has a tab, even when it would fall into the overflow.
  let shown = groups
  let more: CampaignGroup[] = []
  if (groups.length > MAX_TABS) {
    shown = groups.slice(0, MAX_TABS - 1)
    if (active && !shown.includes(active)) shown = [...shown.slice(0, -1), active]
    more = groups.filter((g) => !shown.includes(g))
  }
  const tabs: { value: GroupTab; label: string; n: number; group?: CampaignGroup }[] = [
    { value: '', label: t('All@@campaigns'), n: groups.reduce((s, g) => s + count(g), 0) + ungrouped },
    ...shown.map((g) => ({ value: String(g.id), label: g.name, n: count(g), group: g })),
    ...(groups.length > 0 && ungrouped > 0 ? [{ value: 'none', label: t('Ungrouped@@campaigns'), n: ungrouped }] : []),
  ]
  // Left and Right walk the strip, as tab lists do everywhere else.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    const i = tabs.findIndex((x) => x.value === value)
    const next = tabs[(Math.max(i, 0) + step + tabs.length) % tabs.length]
    e.preventDefault()
    onChange(next.value)
  }
  const menuFor = (g: CampaignGroup): MenuAction[] => [
    isPinned(g) ? { icon: <PinOff size={15} />, label: t('Unpin from the sidebar'), onClick: () => onPin(g, false) } : { icon: <Pin size={15} />, label: t('Pin to the sidebar'), onClick: () => onPin(g, true) },
    ...(ownsGroup(g)
      ? [
          { icon: <Pencil size={15} />, label: t('Rename…'), onClick: () => onRename(g) },
          { icon: <Users size={15} />, label: t('Share…'), title: t('Choose who gets the campaigns of this group'), onClick: () => onShare(g) },
        ]
      : []),
  ]
  return (
    <div className="group-tabs" role="tablist" onKeyDown={onKey}>
      {tabs.map((x) => {
        const on = x.value === value
        return (
          <span key={x.value} className={'group-tab' + (on ? ' active' : '')}>
            <button role="tab" aria-selected={on} tabIndex={on ? 0 : -1} className="group-tab-btn" onClick={() => onChange(x.value)} title={x.group?.owner_name && !ownsGroup(x.group) ? t('Shared with you by {name}', { name: x.group.owner_name }) : undefined}>
              <span className="ellipsis">{x.label}</span>
              <span className="group-tab-n">{x.n}</span>
            </button>
            {on && x.group && (
              <ActionMenu
                className="group-tab-menu"
                label={<ChevronDown size={13} />}
                title={t('Group actions')}
                sections={[{ items: menuFor(x.group) }, { items: ownsGroup(x.group) ? [{ icon: <Trash2 size={15} />, label: t('Delete group…'), danger: true, onClick: () => onDelete(x.group as CampaignGroup) }] : [] }]}
              />
            )}
          </span>
        )
      })}
      {more.length > 0 && (
        <ActionMenu
          className="group-tab-btn group-tab-more"
          label={
            <>
              {t('More@@groups')} <span className="group-tab-n">{more.length}</span> <ChevronDown size={13} />
            </>
          }
          title={t('The other groups')}
          sections={[{ items: more.map((g) => ({ icon: <span className="group-tab-n">{count(g)}</span>, label: g.name, onClick: () => onChange(String(g.id)) })) }]}
        />
      )}
      <button className="group-tab-btn group-tab-add" onClick={onCreate} title={t('New group')} aria-label={t('New group')}>
        <Plus size={14} />
      </button>
    </div>
  )
}

/** Creating or renaming a group: one name. */
export function GroupNameModal({ group, onClose, onSaved }: { group?: CampaignGroup; onClose: () => void; onSaved: (g: CampaignGroup) => void }) {
  const [name, setName] = useState(group?.name ?? '')
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const submit = () =>
    run(async () => {
      setError('')
      try {
        const g = group ? await put<CampaignGroup>(`campaign-groups/${group.id}`, { name: name.trim() }) : await post<CampaignGroup>('campaign-groups', { name: name.trim() })
        toast.ok(group ? t('Group renamed') : t('Group created'))
        onSaved(g)
      } catch (e) {
        setError(errMsg(e))
      }
    })
  return (
    <Modal
      size="sm"
      title={group ? t('Rename group') : t('New group')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={submit}>
            {group ? t('Save') : t('Create')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) submit()
        }}
      >
        <Field label={t('Name')} help={group ? undefined : t('Groups keep campaigns together — by client, source or team. Share a group and everyone on it gets its campaigns, present and future.')}>
          <input className="input" autoFocus value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder={t('Client A')} />
        </Field>
        {error && <div className="field-error">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

/** Who gets the campaigns of a group. */
export function ShareGroupModal({ group, campaigns, onClose }: { group: CampaignGroup; campaigns: Campaign[]; onClose: () => void }) {
  const n = campaigns.filter((c) => c.group_id === group.id).length
  return (
    <Modal
      size="lg"
      onClose={onClose}
      title={t('Share group “{name}”', { name: group.name })}
      footer={
        <button className="btn primary" onClick={onClose}>
          {t('Done')}
        </button>
      }
    >
      <p className="muted">{tx('Everyone added here gets the chosen access to <b>every campaign in this group</b> ({count}) — including campaigns you move into it later.', { b: (c) => <b>{c}</b>, count: tn(n, '{n} campaign', '{n} campaigns') })}</p>
      <SharePanel endpoint={`campaign-groups/${group.id}/shares`} ownerId={group.owner_id} kind="group" />
    </Modal>
  )
}

/** Asks, then deletes the group; its campaigns stay and become ungrouped. Resolves to whether it happened. */
export async function deleteGroup(g: CampaignGroup, campaigns: Campaign[]): Promise<boolean> {
  const n = campaigns.filter((c) => c.group_id === g.id).length
  const ok = await confirmDialog({
    title: t('Delete group?'),
    message: tx('Group <b>{name}</b> will be deleted. Its campaigns ({count}) are kept and become ungrouped. Everyone who had access through the group loses it at once.', { b: (c) => <b>{c}</b>, name: g.name, count: tn(n, '{n} campaign', '{n} campaigns') }),
  })
  if (!ok) return false
  try {
    await del(`campaign-groups/${g.id}`)
    toast.ok(t('Group deleted'))
    return true
  } catch (e) {
    toast.err(e)
    return false
  }
}
