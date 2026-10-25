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
