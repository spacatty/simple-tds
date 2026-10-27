import { useSyncExternalStore } from 'react'
import { get } from './api'
import type { CampaignGroup } from './types'

// The campaign groups, shared by the sidebar (which lists them) and the campaign pages (which change them).
let list: CampaignGroup[] | undefined
const watchers = new Set<() => void>()

function subscribe(fn: () => void) {
  watchers.add(fn)
  return () => {
    watchers.delete(fn)
  }
}

/** Fetches the groups again: after signing in and after each change. */
export async function reloadCampaignGroups(): Promise<void> {
  try {
    list = (await get<CampaignGroup[] | null>('campaign-groups')) ?? []
  } catch {
    // The sidebar must not break over this; the page reports its own errors.
    list = list ?? []
  }
  watchers.forEach((fn) => fn())
}

/** Undefined until the first answer. */
export function useCampaignGroups(): CampaignGroup[] | undefined {
  return useSyncExternalStore(subscribe, () => list)
}

/** The campaign list filtered to one group. */
export const groupHref = (id: number) => `/campaigns?group=${id}`

/**
 * Which groups the sidebar lists, and in what order: a personal preference, since a
 * shared group is somebody else's. `*` (the default) means every group, as the list comes.
 */
export const GROUP_PINS_PREF = 'campaign_group_pins'
export const GROUP_PINS_DEFAULT = '*'

function pinIds(pref: string, groups: CampaignGroup[]): number[] {
  if (pref === GROUP_PINS_DEFAULT) return groups.map((g) => g.id)
  return pref
    .split(',')
    .map(Number)
    .filter((id) => id > 0)
}

/** The pinned groups in sidebar order; deleted or lost groups are skipped. */
export function pinnedGroups(pref: string, groups: CampaignGroup[]): CampaignGroup[] {
  return pinIds(pref, groups).map((id) => groups.find((g) => g.id === id)).filter((g): g is CampaignGroup => !!g)
}

export function isPinned(pref: string, groups: CampaignGroup[], id: number): boolean {
  return pinIds(pref, groups).includes(id)
}

/** The preference after pinning (at the end) or unpinning one group. An empty list is kept as "-" so it differs from the default. */
export function withPin(pref: string, groups: CampaignGroup[], id: number, pinned: boolean): string {
  const ids = pinIds(pref, groups).filter((x) => x !== id && groups.some((g) => g.id === x))
  if (pinned) ids.push(id)
  return ids.join(',') || '-'
}

/** The preference with the pinned groups in the given order. */
export function pinOrder(ids: number[]): string {
  return ids.join(',') || '-'
}
