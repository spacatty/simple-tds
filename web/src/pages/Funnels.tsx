import { useEffect, useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Layers, MousePointerClick, Settings2, Target } from 'lucide-react'
import { get } from '../api'
import { canRead, useLoad } from '../hooks'
import type { Campaign, Stream } from '../types'
import { useDateRange } from '../components/DateRangePicker'
import { Empty, ErrorBox, PageHeader, Select, Skeleton } from '../components/ui'
import { buildSearch } from '../filters'
import { FunnelView } from './FunnelDrawer'
import { t, tn } from '../i18n'

const LS_LAST = 'tds_funnel_campaign'

/** The funnel of any campaign on a page of its own: pick the campaign, and a stream of it to narrow down. */
export default function Funnels() {
  const [range, setRange] = useDateRange()
  const [sp, setSp] = useSearchParams()
  const camps = useLoad(() => get<Campaign[] | null>('campaigns'), [])
  const streams = useLoad(() => get<Stream[] | null>('streams'), [])

  const list = useMemo(() => [...(camps.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [camps.data])
  // The campaign in the URL, else the one opened last, else the first that has stages.
  const campaign = useMemo(() => {
    let last = ''
    try {
      last = localStorage.getItem(LS_LAST) ?? ''
    } catch {
      /* private mode */
    }
    const byId = (id: string | null) => (id ? list.find((c) => String(c.id) === id) : undefined)
    return byId(sp.get('campaign')) ?? byId(last) ?? list.find((c) => (c.stages ?? []).length > 0) ?? list[0]
  }, [list, sp])
  const own = useMemo(() => (streams.data ?? []).filter((s) => s.campaign_id === campaign?.id), [streams.data, campaign?.id])
  const stream = own.find((s) => String(s.id) === sp.get('stream'))

  useEffect(() => {
    if (!campaign) return
    try {
      localStorage.setItem(LS_LAST, String(campaign.id))
    } catch {
      /* private mode */
    }
  }, [campaign])

  const pick = (campaignId: string, streamId = '') => setSp(streamId ? { campaign: campaignId, stream: streamId } : { campaign: campaignId }, { replace: true })

  return (
    <div className="page">
      <PageHeader title={t('Funnels')} sub={t('How far the clicks of a campaign get: every stage, the trend and a breakdown by any dimension.')}>
        <Link className="btn" to="/funnels/presets">
          <Layers size={14} /> {t('Presets')}
        </Link>
      </PageHeader>

      <ErrorBox error={camps.error} retry={camps.reload} />
      {!camps.data ? (
        !camps.error && <Skeleton rows={6} />
      ) : !campaign ? (
        <Empty
          title={t('No campaigns yet')}
          action={
            <Link className="btn primary" to="/campaigns">
              {t('Go to campaigns')}
            </Link>
          }
        >
          {t('A funnel shows up here once a campaign gets clicks.')}
        </Empty>
      ) : (
        <FunnelView
          key={campaign.id + (stream ? ':s' : '')}
          campaign={campaign}
          stream={stream ? { id: stream.id, name: stream.name } : undefined}
          range={range}
          setRange={setRange}
          toolbarStart={
            <>
              <Select
                value={String(campaign.id)}
                onChange={(v) => pick(v)}
                title={t('Campaign')}
                options={list.map((c) => {
                  const n = (c.stages ?? []).length
                  return { value: String(c.id), label: n > 0 ? `${c.name} · ${tn(n, '{n} stage', '{n} stages')}` : c.name }
                })}
              />
              <Select value={stream ? String(stream.id) : ''} onChange={(v) => pick(String(campaign.id), v)} title={t('Stream')} disabled={own.length === 0} options={[{ value: '', label: t('All streams') }, ...own.map((s) => ({ value: String(s.id), label: s.name }))]} />
            </>
          }
          toolbarEnd={
            <>
              <Link className="btn" to={'/clicks' + buildSearch({ range, filters: { campaign_id: campaign.id, stream_id: stream?.id } })}>
                <MousePointerClick size={14} /> {t('View clicks')}
              </Link>
              <Link className="btn" to={'/conversions?' + new URLSearchParams({ campaign_id: String(campaign.id) }).toString()}>
                <Target size={14} /> {t('Conversions')}
              </Link>
              {canRead(campaign) && (
                <Link className="btn" to={`/campaigns/${campaign.id}?tab=funnel`}>
                  <Settings2 size={14} /> {t('Funnel stages')}
                </Link>
              )}
            </>
          }
        />
      )}
    </div>
  )
}
