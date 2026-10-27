import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Merge } from 'lucide-react'
import type { Campaign, Stream } from '../types'
import { canRead } from '../hooks'
import { t, tn } from '../i18n'

/** The stream action that hands a visit to another campaign (engine.HandOverAction). */
export const HAND_OVER = 'campaign'

/** Who sends traffic to whom, read off the streams. */
export interface Flow {
  /** Campaign → the distinct campaigns its enabled streams hand over to. */
  targets: Map<number, number[]>
  /** Campaign → the campaigns with an enabled stream handing over to it. */
  sources: Map<number, number[]>
  /** Campaigns that only feed others: every enabled stream that delivers traffic hands it over. */
  donors: Set<number>
}

/** Actions that end the visit without sending it anywhere. */
const DEAD_ENDS = ['status', 'nothing', 'whitepage']

const EMPTY_FLOW: Flow = { targets: new Map(), sources: new Map(), donors: new Set() }

export function campaignFlow(streams: Stream[] | undefined): Flow {
  if (!streams) return EMPTY_FLOW
  const targets = new Map<number, number[]>()
  const sources = new Map<number, number[]>()
  // Per campaign: does every delivering stream hand over? Intercepting streams stop bots
  // and off-target visitors, and a stream that answers an error, nothing or the whitepage
  // delivers no traffic either (every campaign starts with a 404 fallback), so neither says
  // anything about where the real traffic goes.
  const delivering = new Map<number, { all: number; handing: number }>()
  const add = (m: Map<number, number[]>, k: number, v: number) => {
    const l = m.get(k)
    if (!l) m.set(k, [v])
    else if (!l.includes(v)) l.push(v)
  }
  for (const s of streams) {
    if (!s.enabled) continue
    const to = s.action_type === HAND_OVER ? Number(s.action_config?.campaign_id) : 0
    if (to > 0 && to !== s.campaign_id) {
      add(targets, s.campaign_id, to)
      add(sources, to, s.campaign_id)
    }
    if (s.kind === 'forced' || DEAD_ENDS.includes(s.action_type)) continue
    const d = delivering.get(s.campaign_id) ?? { all: 0, handing: 0 }
    d.all++
    if (to > 0) d.handing++
    delivering.set(s.campaign_id, d)
  }
  const donors = new Set<number>()
  for (const [id, d] of delivering) if (d.handing > 0 && d.handing === d.all) donors.add(id)
  return { targets, sources, donors }
}

export function useCampaignFlow(streams: Stream[] | undefined): Flow {
  return useMemo(() => campaignFlow(streams), [streams])
}

/** Where a campaign name leads: the editor, or its reports when only statistics are shared. */
function campaignHref(c: Campaign): string {
  return canRead(c) ? `/campaigns/${c.id}` : `/reports?campaign_id=${c.id}`
}

/**
 * "→ Target" and "fed by N": how a campaign is wired to the others. `nested` leaves out the
 * arrow when the row already sits under its target.
 */
export function FlowChips({ c, flow, campaigns, nested }: { c: Campaign; flow: Flow; campaigns: Campaign[]; nested?: boolean }) {
  const byId = (id: number) => campaigns.find((x) => x.id === id)
  const name = (id: number) => byId(id)?.name ?? `#${id}`
  const targets = flow.targets.get(c.id) ?? []
  const sources = flow.sources.get(c.id) ?? []
  if (targets.length === 0 && sources.length === 0) return null
  const donor = flow.donors.has(c.id)
  const single = targets.length === 1 ? byId(targets[0]) : undefined
  const outTitle = (donor ? t('All of its traffic goes on to: {names}', { names: targets.map(name).join(', ') }) : t('Some of its streams send visitors on to: {names}', { names: targets.map(name).join(', ') }))
  return (
    <>
      {targets.length > 0 &&
        !nested &&
        (single ? (
          <Link className={'camp-flow' + (donor ? ' donor' : '')} to={campaignHref(single)} title={outTitle}>
            <ArrowRight size={11} /> {single.name}
          </Link>
        ) : (
          <span className={'camp-flow' + (donor ? ' donor' : '')} title={outTitle}>
            <ArrowRight size={11} /> {tn(targets.length, '{n} campaign', '{n} campaigns')}
          </span>
        ))}
      {sources.length > 0 && (
        <span className="camp-flow in" title={t('Receives visitors from: {names}', { names: sources.map(name).join(', ') })}>
          <Merge size={11} /> {tn(sources.length, 'fed by {n}', 'fed by {n}')}
        </span>
      )}
    </>
  )
}
