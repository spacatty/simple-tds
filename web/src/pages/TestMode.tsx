import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Eraser, GitBranch, KeyRound, Link2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { del, get, post } from '../api'
import { useLoad } from '../hooks'
import type { Campaign, Stream, TestClick } from '../types'
import { Card, CodeBlock, CopyButton, Empty, ErrorBox, Field, Notice, NumberInput, Select, confirmDialog, toast, useBusy } from '../components/ui'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { StagePips } from '../components/Journey'
import { fmtAgo, fmtDateTime } from '../format'
import { t, tn, tx } from '../i18n'

/** Asks before a sync, runs it, and reports the outcome; resolves to whether it happened. */
export async function syncFork(c: Campaign): Promise<boolean> {
  const ok = await confirmDialog({
    title: t('Sync with the source?'),
    confirmLabel: t('Sync'),
    message: tx('The streams, the funnel and the cost settings of <b>{name}</b> will be replaced with those of the campaign it was forked from. Streams that exist only here are deleted. Click ids already issued keep working.', {
      b: (x) => <b>{x}</b>,
      name: c.name,
    }),
  })
  if (!ok) return false
  try {
    await post(`campaigns/${c.id}/sync`)
    toast.ok(t('Synced with the source'))
    return true
  } catch (e) {
    toast.err(e)
    return false
  }
}

/** Campaign tab of a test campaign: its key, its links and the click ids issued for it. */
export default function TestMode({ campaign, domain, domainSelect, onChanged, onSync }: { campaign: Campaign; domain: string; domainSelect: ReactNode; onChanged: (c: Campaign) => void; onSync: () => void }) {
  const base = `https://${domain || 'YOUR-DOMAIN'}`
  const key = campaign.test_key ?? ''
  const link = `${base}/${campaign.alias}?key=${key}`
  const script = `<script src="${base}/_j/${campaign.alias}.js?key=${key}"></script>`

  const regenerate = async () => {
    const ok = await confirmDialog({
      title: t('Generate a new key?'),
      confirmLabel: t('Regenerate'),
      message: t('The current key stops working immediately: every test link and script that carries it has to be updated.'),
    })
    if (!ok) return
    try {
      onChanged(await post<Campaign>(`campaigns/${campaign.id}/test-key`))
      toast.ok(t('New key generated'))
    } catch (e) {
      toast.err(e)
    }
  }

  return (
    <>
      <Card title={t('Test mode')}>
        <p className="muted">
          {t('This campaign answers only requests that carry its key; everyone else gets a 404. A request with the key is a clean first-time visitor: no antibot, no JS check, always unique. Its clicks and conversions are kept apart and stay out of every report that is not about this campaign.')}
        </p>
        {campaign.source_id ? (
          <div className="row gap wrap" style={{ marginBottom: 14 }}>
            <span className="with-icon">
              <GitBranch size={14} />
              {campaign.source_name && <Link to={`/campaigns/${campaign.source_id}`}>{campaign.source_name}</Link>}
              {campaign.outdated ? t('The source campaign has changed since the last sync.') : t('In sync with the source campaign.')}
            </span>
            <button className={'btn small' + (campaign.outdated ? ' primary' : '')} onClick={onSync}>
              <RefreshCw size={13} /> {t('Sync from source')}
            </button>
          </div>
        ) : (
          <p className="muted">{t('The campaign this one was forked from no longer exists, so there is nothing to sync with.')}</p>
        )}
        <Field label={t('Dev key')} help={t('Sent as the key parameter of the campaign link. Keep it private: whoever has it gets past every filter that guards the real campaign.')}>
          <div className="url-line">
            <code>{key}</code>
            <CopyButton text={key} label={t('Copy')} />
            <button className="btn small" onClick={regenerate}>
              <KeyRound size={13} /> {t('Regenerate')}
            </button>
          </div>
        </Field>
        {domainSelect}
        <Field label={t('Test link')} help={t('The streams still choose by their filters, so from your own machine you get what your address, browser and referrer deserve. To land in a particular stream, issue a click id for it below.')}>
          <div className="url-line">
            <code>{link}</code>
            <CopyButton text={link} label={t('Copy')} />
          </div>
        </Field>
        <Field label={t('Test script')} help={t('The JavaScript integration with the key. Add &click_id=… to enter with an issued click id.')}>
          <CodeBlock text={script} maxHeight={90} />
        </Field>
      </Card>
      <TestClicks campaign={campaign} link={link} />
    </>
  )
}

function TestClicks({ campaign, link }: { campaign: Campaign; link: string }) {
  const clicks = useLoad(() => get<{ rows: TestClick[] | null }>(`campaigns/${campaign.id}/test-clicks`).then((r) => r.rows ?? []), [campaign.id])
  const streams = useLoad(() => get<{ streams: Stream[] | null }>(`campaigns/${campaign.id}/streams`).then((r) => r.streams ?? []), [campaign.id, campaign.outdated])
  const [streamId, setStreamId] = useState('')
  const [count, setCount] = useState<number | ''>(1)
  const [note, setNote] = useState('')
  const [busy, run] = useBusy()

  const usable = useMemo(() => (streams.data ?? []).filter((s) => s.enabled), [streams.data])
  const streamName = (id: number) => (streams.data ?? []).find((s) => s.id === id)?.name ?? t('#{id} (missing)', { id })
  const rows = clicks.data ?? []
  const entered = rows.filter((r) => r.used_at).length

  const issue = () =>
    run(async () => {
      try {
        const n = count === '' ? 1 : count
        await post(`campaigns/${campaign.id}/test-clicks`, { stream_id: Number(streamId), count: n, note })
        toast.ok(tn(n, '{n} click id issued', '{n} click ids issued'))
        setNote('')
        await clicks.reload()
      } catch (e) {
        toast.err(e)
      }
    })
  const remove = async (r: TestClick) => {
    try {
      await del(`campaigns/${campaign.id}/test-clicks/${r.id}`)
      clicks.setData((d) => d?.filter((x) => x.id !== r.id))
    } catch (e) {
      toast.err(e)
    }
  }
  const clear = async () => {
    const ok = await confirmDialog({
      title: t('Delete the entered click ids?'),
      confirmLabel: t('Delete'),
      message: t('They cannot be entered again anyway. The clicks and conversions they recorded stay in the statistics of this campaign.'),
    })
    if (!ok) return
    try {
      await post(`campaigns/${campaign.id}/test-clicks/clear`)
      await clicks.reload()
    } catch (e) {
      toast.err(e)
    }
  }

  const columns: Column<TestClick>[] = [
    {
      key: 'id',
      title: t('Click ID'),
      render: (r) => (
        <span className="row gap-s">
          <code>{r.click_id}</code>
          <CopyButton text={r.click_id} className="icon-btn" title={t('Copy the click id')} />
          {!r.used_at && <CopyButton text={`${link}&click_id=${r.click_id}`} label={t('Link')} title={t('Copy the test link with this click id')} />}
        </span>
      ),
    },
    { key: 'stream', title: t('Stream'), sort: (r) => streamName(r.stream_id), render: (r) => <span className="ellipsis">{streamName(r.stream_id)}</span> },
    { key: 'note', title: t('Note'), render: (r) => <span className="muted">{r.note || '—'}</span> },
    { key: 'created', title: t('Issued'), sort: (r) => r.created_at, render: (r) => <span title={fmtDateTime(r.created_at)}>{fmtAgo(r.created_at)}</span> },
    {
      key: 'used',
      title: t('Entered'),
      sort: (r) => r.used_at ?? '',
      render: (r) => (r.used_at ? <span title={fmtDateTime(r.used_at)}>{fmtAgo(r.used_at)}</span> : <span className="muted">{t('not yet')}</span>),
    },
    { key: 'events', title: t('Events'), headTitle: t('The funnel stages that arrived for this click id'), render: (r) => <StagePips stages={campaign.stages ?? []} events={r.events ?? []} clickTs={r.created_at} /> },
    {
      key: 'actions',
      title: '',
      align: 'right',
      width: 44,
      render: (r) => (
        <button className="icon-btn" onClick={() => remove(r)} title={r.used_at ? t('Delete') : t('Delete: the click id can no longer be entered')} aria-label={t('Delete')}>
          <Trash2 size={15} />
        </button>
      ),
    },
  ]

  return (
    <Card
      title={t('Test click IDs')}
      pad={false}
      actions={
        <>
          <Link className="btn small" to={`/clicks?campaign_id=${campaign.id}`}>
            <Link2 size={13} /> {t('Click log')}
          </Link>
          {entered > 0 && (
            <button className="btn small" onClick={clear} title={t('Delete the click ids that were already entered')}>
              <Eraser size={13} /> {t('Delete entered')}
            </button>
          )}
          <button className="btn small" onClick={() => clicks.reload()} title={t('Refresh')} aria-label={t('Refresh')}>
            <RefreshCw size={13} className={clicks.loading ? 'spin' : ''} />
          </button>
        </>
      }
    >
      <div className="card-body">
        <p className="muted">
          {t('A click id issued here is accepted by postbacks at once, like the id of a real click, so services that only report conversions can use it straight away. With the key it can also be entered once: the visit takes this id and goes to the stream it was issued for, whatever the stream’s filters say. Such a click is dated by the moment its id was issued.')}
        </p>
        <ErrorBox error={clicks.error || streams.error} retry={() => (clicks.reload(), streams.reload())} />
        {streams.data && usable.length === 0 ? (
          <Notice tone="warn">{t('This campaign has no enabled streams to issue click ids for.')}</Notice>
        ) : (
          <form
            className="row gap wrap"
            onSubmit={(e) => {
              e.preventDefault()
              if (streamId) issue()
            }}
          >
            <span style={{ width: 280 }}>
              <Select value={streamId} onChange={setStreamId} placeholder={t('Choose a stream…')} options={usable.map((s) => ({ value: String(s.id), label: s.name }))} />
            </span>
            <span style={{ width: 84 }} title={t('How many click ids to issue')}>
              <NumberInput value={count} min={1} max={50} onChange={setCount} />
            </span>
            <input className="input" style={{ width: 220 }} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('Note (optional)')} />
            <button className="btn primary" disabled={busy || !streamId}>
              <Plus size={14} /> {t('Issue')}
            </button>
          </form>
        )}
      </div>
      <DataTable
        columns={columns}
        rows={clicks.data}
        rowKey={(r) => r.id}
        loading={clicks.loading}
        maxHeight={520}
        empty={<Empty title={t('No click ids issued yet')}>{t('Choose a stream above and issue the first one.')}</Empty>}
      />
    </Card>
  )
}
