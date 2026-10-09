import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Check, ExternalLink, FolderCog, LayoutList, Pencil, Plus, RefreshCw, Table2, Trash2, X } from 'lucide-react'
import { del, errMsg, get, post, put } from '../api'
import { canEdit, useInterval, useIsAdmin, useLoad, usePref } from '../hooks'
import type { BulkAddResult, Campaign, Domain, DomainGroup, SystemInfo } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { HEALTH, HealthTiles, RepBadge, RepChips, domainHealth, useProviderNames } from '../components/DomainHealth'
import type { Health } from '../components/DomainHealth'
import { Badge, CopyButton, Dropdown, Empty, ErrorBox, Field, MenuItem, Modal, Notice, PageHeader, SearchInput, Segmented, Select, Skeleton, Toggle, confirmDialog, toast, useBusy } from '../components/ui'
import type { Tone } from '../components/ui'
import { fmtAgo, fmtDateTime } from '../format'
import { t, tn, ts, tx } from '../i18n'

export const TLS_MODES = [
  { value: 'auto', label: t('Auto (Let’s Encrypt)'), help: t('The app terminates TLS and issues a Let’s Encrypt certificate itself. Point the domain straight at this server.') },
  { value: 'proxy', label: t('Proxy / CDN'), help: t('TLS is terminated by Cloudflare or another proxy in front of this server; no certificate is issued here.') },
]
export const IP_SOURCES = [
  { value: 'direct', label: t('Direct connection'), help: t('Use the address of the TCP connection (PROXY-protocol aware).') },
  { value: 'cf', label: 'CF-Connecting-IP', help: t('Cloudflare: take the visitor IP from the CF-Connecting-IP header.') },
  { value: 'xff', label: 'X-Forwarded-For', help: t('Take the left-most address of X-Forwarded-For.') },
  { value: 'x_real_ip', label: 'X-Real-IP', help: t('Take the address from the X-Real-IP header (nginx).') },
]
const label = (list: { value: string; label: string }[], v: string) => list.find((x) => x.value === v)?.label ?? v
const STATUS_TONE: Record<string, Tone> = { ok: 'ok', pending: 'warn', error: 'err' }
const STATUS_LABEL: Record<string, string> = { ok: t('ok@@domain'), pending: t('pending@@domain'), error: t('error@@domain') }
/** Visible name of a domain check status. */
export const domainStatus = (s: string) => STATUS_LABEL[s] ?? s

type View = 'cards' | 'table'
type Order = 'name' | 'state' | 'new'
const ORDERS: { value: Order; label: string }[] = [
  { value: 'name', label: t('By name') },
  { value: 'state', label: t('Problems first') },
  { value: 'new', label: t('Newest first') },
]
// Worst first, for the "problems first" order.
const HEALTH_RANK: Record<Health, number> = { flagged: 0, error: 1, pending: 2, ok: 3, off: 4 }
// How long the list keeps refreshing by itself while blocklist answers are on their way.
const WATCH_MS = 90_000

export default function Domains() {
  const list = useLoad(() => get<Domain[]>('domains'), [])
  const groups = useLoad(() => get<DomainGroup[]>('domain-groups'), [])
  const isAdmin = useIsAdmin()
  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])
  // A domain may only serve campaigns the user can edit.
  const usable = useMemo(() => (camps.data ?? []).filter(canEdit), [camps.data])
  const sys = useLoad(() => get<SystemInfo>('system'), [])
  const [sp, setSp] = useSearchParams()
  const [q, setQ] = useState('')
  const [group, setGroup] = useState('')
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Domain | null>(null)
  const [managing, setManaging] = useState(false)
  // Both follow the account, so the list looks the same on every device.
  const [view, setView] = usePref<View>('domains_view', 'cards')
  const [order, setOrder] = usePref<Order>('domains_sort', 'name')
  // The state filter lives in the address (?show=flagged): dashboards link to it.
  const show = (HEALTH.find((h) => h.key === sp.get('show'))?.key ?? '') as Health | ''
  const setShow = (v: Health | '') => setSp(v ? { show: v } : {}, { replace: true })

  const domains = useMemo(() => list.data ?? [], [list.data])
  const repOn = (sys.data?.reputation ?? []).length > 0
  const hasRep = repOn || domains.some((d) => (d.reputation ?? []).length > 0)
  // Set after an action that sends the checkers off: adding domains, "re-check".
  const [watch, setWatch] = useState(0)
  const [opened] = useState(() => Date.now())
  const unchecked = Date.now() < opened + WATCH_MS && domains.some((d) => d.enabled && !d.rep_status)
  const waiting = domains.some((d) => d.status === 'pending') || (repOn && (unchecked || Date.now() < watch))
  useInterval(() => list.reload(), 5000, waiting)
  // Checks also run on their own schedule: a page left open keeps up with them.
  useInterval(() => list.reload(), 60_000, !waiting)

  const groupName = (id: number | null) => (id === null ? '' : groups.data?.find((g) => g.id === id)?.name ?? `#${id}`)
  const campName = (id: number | null) => (id === null ? '' : camps.data?.find((c) => c.id === id)?.name ?? `#${id}`)

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase()
    return domains.filter((d) => {
      if (s && !d.name.includes(s) && !d.note.toLowerCase().includes(s)) return false
      if (group === 'none' ? d.group_id !== null : group && String(d.group_id) !== group) return false
      if (show && domainHealth(d) !== show) return false
      return true
    })
  }, [domains, q, group, show])
  // The table sorts by its own headers; the cards by the order picked in the toolbar.
  const cards = useMemo(() => {
    const byName = (a: Domain, b: Domain) => a.name.localeCompare(b.name)
    return [...rows].sort(order === 'state' ? (a, b) => HEALTH_RANK[domainHealth(a)] - HEALTH_RANK[domainHealth(b)] || byName(a, b) : order === 'new' ? (a, b) => b.created_at.localeCompare(a.created_at) || byName(a, b) : byName)
  }, [rows, order])

  const selected = rows.filter((d) => sel.has(d.id))
  const ids = selected.map((d) => d.id)
  const allChecked = rows.length > 0 && selected.length === rows.length
  const selectAll = (on: boolean) => setSel(on ? new Set(rows.map((d) => d.id)) : new Set())
  const select = (d: Domain, on: boolean) => {
    const n = new Set(sel)
    if (on) n.add(d.id)
    else n.delete(d.id)
    setSel(n)
  }

  const patch = async (d: Domain, body: Partial<Domain>) => {
    // The switch moves at once and goes back if the server refuses; see setEnabled in Campaigns.tsx.
    const swap = (n: Domain) => list.setData((all) => all?.map((x) => (x.id === d.id ? n : x)))
    swap({ ...d, ...body })
    try {
      swap(await put<Domain>(`domains/${d.id}`, body))
    } catch (e) {
      swap(d)
      toast.err(e)
    }
  }
  const bulkSet = async (set: Record<string, unknown>, what: string) => {
    try {
      const r = await post<{ updated: number }>('domains/bulk-update', { ids, set })
      toast.ok(tn(r.updated, '{what}: {n} domain updated', '{what}: {n} domains updated', { what }))
    } catch (e) {
      toast.err(e)
    }
    list.reload()
  }
  const recheck = async (which: number[]) => {
    try {
      await post('domains/check', { ids: which })
      // The check runs in the background; show it as pending until the poll picks the result up.
      list.setData(domains.map((d) => (which.includes(d.id) ? { ...d, status: 'pending', status_msg: '' } : d)))
      setWatch(Date.now() + WATCH_MS)
      toast.info(tn(which.length, 'Re-checking {n} domain…', 'Re-checking {n} domains…'))
    } catch (e) {
      toast.err(e)
    }
  }
  const remove = async (which: Domain[]) => {
    const ok = await confirmDialog({
      title: which.length === 1 ? t('Delete domain?') : tn(which.length, 'Delete {n} domain?', 'Delete {n} domains?'),
      message:
        which.length === 1
          ? tx('<b>{name}</b> will stop serving campaigns immediately. Statistics are kept.', { b: (c) => <b>{c}</b>, name: which[0].name })
          : tn(which.length, '{n} selected domain will stop serving campaigns immediately. Statistics are kept.', '{n} selected domains will stop serving campaigns immediately. Statistics are kept.'),
    })
    if (!ok) return
    try {
      if (which.length === 1) await del(`domains/${which[0].id}`)
      else {
        const r = await post<{ deleted: number }>('domains/bulk-delete', { ids: which.map((d) => d.id) })
        toast.ok(tn(r.deleted, '{n} domain deleted', '{n} domains deleted'))
      }
      setSel(new Set())
    } catch (e) {
      toast.err(e)
    }
    list.reload()
  }

  // Cells shared by the table and the cards.
  const checkbox = (d: Domain) => <input type="checkbox" aria-label={t('Select {name}', { name: d.name })} checked={sel.has(d.id)} onChange={(e) => select(d, e.target.checked)} />
  const nameLink = (d: Domain) => (
    <a href={`https://${d.name}/`} target="_blank" rel="noreferrer noopener" className="strong">
      {d.name}
    </a>
  )
  const connTitle = (d: Domain) => (d.status_msg ? ts(d.status_msg) + '\n' : '') + (d.checked_at ? t('Checked {time}', { time: fmtDateTime(d.checked_at) }) : t('Not checked yet'))
  const connBadge = (d: Domain) => <Badge tone={STATUS_TONE[d.status] ?? 'neutral'}>{d.status === 'pending' ? t('pending…@@domain') : domainStatus(d.status)}</Badge>
  const panelToggle = (d: Domain, text?: ReactNode) => <Toggle checked={d.admin_enabled} onChange={(v) => patch(d, { admin_enabled: v })} label={text} title={t('Panel access on this domain')} />
  const enabledToggle = (d: Domain, text?: ReactNode) => <Toggle checked={d.enabled} onChange={(v) => patch(d, { enabled: v })} label={text} />
  const actions = (d: Domain) => (
    <div className="row-actions">
      <button className="icon-btn" title={t('Re-check now')} onClick={() => recheck([d.id])}>
        <RefreshCw size={15} />
      </button>
      <button className="icon-btn" title={t('Edit')} onClick={() => setEditing(d)}>
        <Pencil size={15} />
      </button>
      <button className="icon-btn danger" title={t('Delete')} onClick={() => remove([d])}>
        <Trash2 size={15} />
      </button>
    </div>
  )

  const columns: Column<Domain>[] = [
    {
      key: 'sel',
      width: 32,
      title: <input type="checkbox" aria-label={t('Select all')} checked={allChecked} onChange={(e) => selectAll(e.target.checked)} />,
      render: checkbox,
    },
    {
      key: 'name',
      title: t('Domain'),
      sort: (d) => d.name,
      render: (d) => (
        <div>
          {nameLink(d)}
          {d.note && <div className="muted small">{d.note}</div>}
        </div>
      ),
    },
    { key: 'group', title: t('Group'), sort: (d) => groupName(d.group_id), render: (d) => (d.group_id === null ? <span className="muted">—</span> : <Badge>{groupName(d.group_id)}</Badge>) },
    {
      key: 'status',
      title: t('Connection'),
      sort: (d) => d.status,
      render: (d) => (
        <span title={connTitle(d)}>
          {connBadge(d)}
          {d.status === 'error' && d.status_msg && <span className="status-msg ellipsis">{ts(d.status_msg)}</span>}
          <span className="muted small"> {d.checked_at ? fmtAgo(d.checked_at) : ''}</span>
        </span>
      ),
    },
    ...(hasRep ? [{ key: 'rep', title: t('Reputation'), headTitle: t('What the blocklists say about the domain'), sort: (d: Domain) => d.rep_status, render: (d: Domain) => <RepBadge d={d} active={repOn} /> } as Column<Domain>] : []),
    { key: 'tls', title: 'TLS', sort: (d) => d.tls_mode, render: (d) => <span title={TLS_MODES.find((m) => m.value === d.tls_mode)?.help}>{d.tls_mode === 'auto' ? t('Auto') : t('Proxy')}</span> },
    { key: 'ip', title: t('Real IP'), sort: (d) => d.ip_source, render: (d) => <span title={IP_SOURCES.find((m) => m.value === d.ip_source)?.help}>{label(IP_SOURCES, d.ip_source)}</span> },
    { key: 'campaign', title: t('Default campaign'), sort: (d) => campName(d.campaign_id), render: (d) => (d.campaign_id === null ? <span className="muted">{t('— (404 on “/”)')}</span> : campName(d.campaign_id)) },
    ...(isAdmin ? [{ key: 'admin', title: t('Panel'), headTitle: t('Serve the admin panel on this domain under the admin path'), width: 70, render: (d: Domain) => panelToggle(d) } as Column<Domain>] : []),
    { key: 'enabled', title: t('Enabled@@domain'), width: 70, render: (d) => enabledToggle(d) },
    { key: 'actions', title: '', align: 'right', width: 110, render: actions },
  ]

  const groupOptions = [{ value: 'none', label: t('Without group') }, ...(groups.data ?? []).map((g) => ({ value: String(g.id), label: g.name }))]
  const serverIP = sys.data?.server_ip ?? ''
  const empty = (
    <Empty title={domains.length ? t('No domains match the filters') : t('No domains yet')} action={!domains.length && <button className="btn primary" onClick={() => setAdding(true)}><Plus size={15} /> {t('Add domains')}</button>}>
      {!domains.length && t('Add one or many domains at once, then point their DNS at this server.')}
    </Empty>
  )

  return (
    <div className="page">
      <PageHeader title={t('Domains')} sub={t('Domains that serve campaigns, postbacks and (optionally) this panel.')}>
        <button className="btn" onClick={() => setManaging(true)}>
          <FolderCog size={15} /> {t('Groups')}
        </button>
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Plus size={15} /> {t('Add domains')}
        </button>
      </PageHeader>

      <Notice>
        {tx('Point an <b>A record</b> of each domain at {server}. The domain is checked automatically and its status turns {ok} once it is verified — in Auto TLS mode that includes issuing the certificate, which can take a minute. Behind Cloudflare choose TLS “Proxy / CDN” and real IP “CF-Connecting-IP”.', {
          b: (c) => <b>{c}</b>,
          server: serverIP ? <><code>{serverIP}</code> <CopyButton text={serverIP} className="icon-btn" title={t('Copy the server IP')} /></> : t('this server'),
          ok: <Badge tone="ok">{domainStatus('ok')}</Badge>,
        })}
      </Notice>
      {isAdmin && sys.data && !repOn && domains.length > 0 && (
        <Notice>
          {tx('Blocklist checks are off. Switch on Google Safe Browsing, VirusTotal, Spamhaus and others under <a>Settings → Domain reputation</a> to see here when a domain gets flagged.', { a: (c) => <Link to="/settings?tab=reputation">{c}</Link> })}
        </Notice>
      )}
      <ErrorBox error={list.error} retry={list.reload} />

      {domains.length > 0 && <HealthTiles domains={domains} value={show} onChange={setShow} />}

      <div className="toolbar wrap">
        <SearchInput value={q} onChange={setQ} placeholder={t('Search domains…')} />
        <Select value={group} onChange={setGroup} placeholder={t('All groups')} options={groupOptions} />
        {view === 'cards' && (
          <>
            <Select value={order} onChange={(v) => setOrder(v as Order)} options={ORDERS} />
            <label className="check-all">
              <input type="checkbox" checked={allChecked} disabled={!rows.length} onChange={(e) => selectAll(e.target.checked)} /> {t('Select all')}
            </label>
          </>
        )}
        <span className="muted">
          {t('{shown} of {total}', { shown: rows.length, total: domains.length })}
        </span>
        <span className="grow" />
        <Segmented
          small
          value={view}
          onChange={setView}
          options={[
            { value: 'cards', label: <><LayoutList size={13} /> {t('Cards')}</>, title: t('One card per domain, with every check spelled out') },
            { value: 'table', label: <><Table2 size={13} /> {t('Table')}</>, title: t('A compact table, sortable by any column') },
          ]}
        />
      </div>

      {selected.length > 0 && (
        <div className="bulkbar">
          <b>{t('{n} selected', { n: selected.length })}</b>
          <Dropdown className="btn small" label={t('Set group')}>
            {(close) => (
              <div className="menu">
                <MenuItem onClick={() => (close(), bulkSet({ group_id: null }, t('Group removed')))}>{t('No group')}</MenuItem>
                {(groups.data ?? []).map((g) => (
                  <MenuItem key={g.id} onClick={() => (close(), bulkSet({ group_id: g.id }, t('Group set')))}>
                    {g.name}
                  </MenuItem>
                ))}
              </div>
            )}
          </Dropdown>
          <Dropdown className="btn small" label={t('Set campaign')}>
            {(close) => (
              <div className="menu">
                <MenuItem onClick={() => (close(), bulkSet({ campaign_id: null }, t('Default campaign removed')))}>{t('No default campaign')}</MenuItem>
                {usable.map((c) => (
                  <MenuItem key={c.id} onClick={() => (close(), bulkSet({ campaign_id: c.id }, t('Default campaign set')))}>
                    {c.name}
                  </MenuItem>
                ))}
              </div>
            )}
          </Dropdown>
          <Dropdown className="btn small" label={t('TLS mode')}>
            {(close) => (
              <div className="menu">
                {TLS_MODES.map((m) => (
                  <MenuItem key={m.value} onClick={() => (close(), bulkSet({ tls_mode: m.value }, t('TLS mode set')))}>
                    {m.label}
                  </MenuItem>
                ))}
              </div>
            )}
          </Dropdown>
          <Dropdown className="btn small" label={t('IP source')}>
            {(close) => (
              <div className="menu">
                {IP_SOURCES.map((m) => (
                  <MenuItem key={m.value} onClick={() => (close(), bulkSet({ ip_source: m.value }, t('IP source set')))}>
                    {m.label}
                  </MenuItem>
                ))}
              </div>
            )}
          </Dropdown>
          <button className="btn small" onClick={() => bulkSet({ enabled: true }, t('Enabled@@bulk'))}>
            <Check size={14} /> {t('Enable')}
          </button>
          <button className="btn small" onClick={() => bulkSet({ enabled: false }, t('Disabled@@bulk'))}>
            <X size={14} /> {t('Disable')}
          </button>
          <button className="btn small" onClick={() => recheck(ids)}>
            <RefreshCw size={14} /> {t('Re-check')}
          </button>
          <button className="btn small danger-outline" onClick={() => remove(selected)}>
            <Trash2 size={14} /> {t('Delete')}
          </button>
          <span className="grow" />
          <button className="btn small ghost" onClick={() => setSel(new Set())}>
            {t('Clear selection')}
          </button>
        </div>
      )}

      {view === 'table' ? (
        <div className="card">
          <DataTable columns={columns} rows={list.data ? rows : undefined} rowKey={(d) => d.id} loading={list.loading} rowClass={(d) => (sel.has(d.id) ? 'selected' : d.enabled ? '' : 'dim')} empty={empty} />
        </div>
      ) : !list.data ? (
        !list.error && (
          <div className="card pad">
            <Skeleton rows={6} height={18} />
          </div>
        )
      ) : cards.length === 0 ? (
        <div className="card">{empty}</div>
      ) : (
        <div className={'dcards' + (hasRep ? ' with-rep' : '') + (list.loading ? ' reloading' : '')}>
          {cards.map((d) => {
            const health = domainHealth(d)
            return (
              <article key={d.id} className={`dcard h-${health}` + (sel.has(d.id) ? ' selected' : '')}>
                <div className="dcard-check">{checkbox(d)}</div>
                <div className="dcard-main">
                  <div className="dcard-name">
                    {nameLink(d)}
                    {d.group_id !== null && <Badge>{groupName(d.group_id)}</Badge>}
                    {d.admin_enabled && !isAdmin && <Badge tone="info">{t('Panel')}</Badge>}
                  </div>
                  {d.note && <div className="muted small ellipsis" title={d.note}>{d.note}</div>}
                  <dl className="dcard-meta">
                    <div title={TLS_MODES.find((m) => m.value === d.tls_mode)?.help}>
                      <dt>TLS</dt>
                      <dd>{d.tls_mode === 'auto' ? t('Auto') : t('Proxy')}</dd>
                    </div>
                    <div title={IP_SOURCES.find((m) => m.value === d.ip_source)?.help}>
                      <dt>{t('Real IP')}</dt>
                      <dd>{label(IP_SOURCES, d.ip_source)}</dd>
                    </div>
                    <div>
                      <dt>{t('Default campaign')}</dt>
                      <dd className="ellipsis">{d.campaign_id === null ? <span className="muted">{t('— (404 on “/”)')}</span> : campName(d.campaign_id)}</dd>
                    </div>
                  </dl>
                </div>
                <div className="dcard-col" title={connTitle(d)}>
                  <div className="dcard-label">{t('Connection')}</div>
                  <div className="row gap-s">
                    {connBadge(d)}
                    <span className="muted small">{d.checked_at ? fmtAgo(d.checked_at) : t('Not checked yet')}</span>
                  </div>
                  {d.status_msg && <div className={'dcard-msg' + (d.status === 'error' ? ' err' : '')}>{ts(d.status_msg)}</div>}
                </div>
                {hasRep && (
                  <div className="dcard-col">
                    <div className="dcard-label">
                      {t('Reputation')}
                      {d.rep_checked_at && <span className="muted"> · {fmtAgo(d.rep_checked_at)}</span>}
                    </div>
                    <RepChips d={d} active={repOn} />
                  </div>
                )}
                <div className="dcard-ctl">
                  {isAdmin && panelToggle(d, t('Panel'))}
                  {enabledToggle(d, t('Enabled@@domain'))}
                  {actions(d)}
                </div>
              </article>
            )
          })}
        </div>
      )}

      {adding && (
        <AddDomains
          isAdmin={isAdmin}
          groups={groups.data ?? []}
          campaigns={usable}
          onClose={() => {
            setAdding(false)
            list.reload()
          }}
          onAdded={() => {
            setWatch(Date.now() + WATCH_MS)
            list.reload()
          }}
        />
      )}
      {editing && (
        <EditDomain
          domain={editing}
          isAdmin={isAdmin}
          groups={groups.data ?? []}
          // The picker offers editable campaigns, plus the current one if it was set by someone with more rights.
          campaigns={[...(camps.data ?? []).filter((c) => c.id === editing.campaign_id && !canEdit(c)), ...usable]}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            list.reload()
          }}
        />
      )}
      {managing && (
        <GroupsModal
          groups={groups.data ?? []}
          domains={domains}
          reload={async () => {
            await Promise.all([groups.reload(), list.reload()])
          }}
          onClose={() => setManaging(false)}
        />
      )}
    </div>
  )
}

function DomainOptions({
  v,
  set,
  groups,
  campaigns,
}: {
  v: { group_id: string; campaign_id: string; tls_mode: string; ip_source: string }
  set: (p: Partial<{ group_id: string; campaign_id: string; tls_mode: string; ip_source: string }>) => void
  groups: DomainGroup[]
  campaigns: Campaign[]
}) {
  return (
    <div className="form-grid">
      <Field label={t('Group')}>
        <Select value={v.group_id} onChange={(group_id) => set({ group_id })} placeholder={t('No group')} options={groups.map((g) => ({ value: String(g.id), label: g.name }))} />
      </Field>
      <Field label={t('Default campaign')} help={t('Served on the root URL “/” of the domain. Other campaigns stay reachable by /alias.')}>
        <Select value={v.campaign_id} onChange={(campaign_id) => set({ campaign_id })} placeholder={t('None (404 on “/”)')} options={campaigns.map((c) => ({ value: String(c.id), label: c.name }))} />
      </Field>
      <Field label={t('TLS mode')} help={TLS_MODES.find((m) => m.value === v.tls_mode)?.help}>
        <Select value={v.tls_mode} onChange={(tls_mode) => set({ tls_mode })} options={TLS_MODES} />
      </Field>
      <Field label={t('Real visitor IP from')} help={IP_SOURCES.find((m) => m.value === v.ip_source)?.help}>
        <Select value={v.ip_source} onChange={(ip_source) => set({ ip_source })} options={IP_SOURCES} />
      </Field>
      {v.ip_source !== 'direct' && (
        <div className="span-2">
          <Notice tone="warn">{t('Forwarding headers are only trusted from the addresses listed under Settings → Network → Trusted proxies. From any other address the socket IP is used.')}</Notice>
        </div>
      )}
    </div>
  )
}

const idOrNull = (s: string) => (s ? Number(s) : null)

function AddDomains({ isAdmin, groups, campaigns, onClose, onAdded }: { isAdmin: boolean; groups: DomainGroup[]; campaigns: Campaign[]; onClose: () => void; onAdded: () => void }) {
  const [names, setNames] = useState('')
  const [v, setV] = useState({ group_id: '', campaign_id: '', tls_mode: 'auto', ip_source: 'direct' })
  const [admin, setAdmin] = useState(false)
  const [result, setResult] = useState<BulkAddResult | null>(null)
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const count = names.split(/[\s,;]+/).filter(Boolean).length

  const submit = () =>
    run(async () => {
      setError('')
      try {
        const r = await post<BulkAddResult>('domains/bulk', { names, group_id: idOrNull(v.group_id), campaign_id: idOrNull(v.campaign_id), tls_mode: v.tls_mode, ip_source: v.ip_source, ...(isAdmin ? { admin_enabled: admin } : {}) })
        setResult(r)
        onAdded()
      } catch (e) {
        setError(errMsg(e))
      }
    })

  if (result) {
    const failed = result.results.filter((r) => !r.ok)
    return (
      <Modal title={t('Domains added')} onClose={onClose} footer={<><button className="btn" onClick={() => { setResult(null); setNames(failed.map((f) => f.name).join('\n')) }}>{t('Add more')}</button><button className="btn primary" onClick={onClose}>{t('Done')}</button></>}>
        <Notice tone={failed.length ? 'warn' : 'ok'}>
          {failed.length > 0
            ? t('{added} added, {refused} refused. New domains are checked in the background; watch the Status column.', { added: result.added, refused: failed.length })
            : t('{added} added. New domains are checked in the background; watch the Status column.', { added: result.added })}
        </Notice>
        <div className="table-wrap" style={{ maxHeight: 340 }}>
          <table className="table">
            <thead>
              <tr>
                <th>{t('Domain')}</th>
                <th>{t('Result')}</th>
              </tr>
            </thead>
            <tbody>
              {result.results.map((r, i) => (
                <tr key={i}>
                  <td className="mono">{r.name}</td>
                  <td>{r.ok ? <Badge tone="ok">{t('added@@domain')}</Badge> : <span className="field-error">{ts(r.error)}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      title={t('Add domains')}
      size="lg"
      onClose={onClose}
      footer={
        <>
          {error && <div className="field-error grow">{error}</div>}
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || count === 0} onClick={submit}>
            {busy ? t('Adding…') : count ? tn(count, 'Add {n} domain', 'Add {n} domains') : t('Add domains')}
          </button>
        </>
      }
    >
      <Field label={t('Domain names')} help={t('One per line, or separated by commas or spaces. URLs and upper case are fine — they are normalised.')}>
        <textarea className="input mono" rows={7} autoFocus value={names} onChange={(e) => setNames(e.target.value)} placeholder={'example.com\npromo.example.net, go.example.org'} />
      </Field>
      <DomainOptions v={v} set={(p) => setV((x) => ({ ...x, ...p }))} groups={groups} campaigns={campaigns} />
      {isAdmin && (
        <Field help={t('The panel becomes reachable at https://domain/<admin-path>/ once the domain is verified.')}>
          <Toggle checked={admin} onChange={setAdmin} label={t('Also serve the admin panel on these domains')} />
        </Field>
      )}
      <Notice>{t('Point an A record of every domain at this server before or right after adding it; the status turns OK when the check passes.')}</Notice>
    </Modal>
  )
}

function EditDomain({ domain, isAdmin, groups, campaigns, onClose, onSaved }: { domain: Domain; isAdmin: boolean; groups: DomainGroup[]; campaigns: Campaign[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(domain.name)
  const [note, setNote] = useState(domain.note)
  const [v, setV] = useState({ group_id: domain.group_id === null ? '' : String(domain.group_id), campaign_id: domain.campaign_id === null ? '' : String(domain.campaign_id), tls_mode: domain.tls_mode, ip_source: domain.ip_source })
  const [admin, setAdmin] = useState(domain.admin_enabled)
  const [enabled, setEnabled] = useState(domain.enabled)
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const names = useProviderNames()
  const reputation = domain.reputation ?? []
  const save = () =>
    run(async () => {
      setError('')
      try {
        await put(`domains/${domain.id}`, { name, note, group_id: idOrNull(v.group_id), campaign_id: idOrNull(v.campaign_id), tls_mode: v.tls_mode, ip_source: v.ip_source, enabled, ...(isAdmin ? { admin_enabled: admin } : {}) })
        toast.ok(t('Domain saved'))
        onSaved()
      } catch (e) {
        setError(errMsg(e))
      }
    })
  return (
    <Modal
      title={t('Edit {name}', { name: domain.name })}
      size="lg"
      onClose={onClose}
      footer={
        <>
          {error && <div className="field-error grow">{error}</div>}
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={save}>
            {t('Save')}
          </button>
        </>
      }
    >
      {domain.status !== 'ok' && (
        <Notice tone={domain.status === 'error' ? 'err' : 'warn'} title={t('Status: {status}', { status: domainStatus(domain.status) })}>
          {domain.status_msg ? ts(domain.status_msg) : t('Waiting for the check to finish.')} {domain.checked_at && <span className="muted">{t('(checked {time})', { time: fmtDateTime(domain.checked_at) })}</span>}
        </Notice>
      )}
      <div className="form-grid">
        <Field label={t('Domain name')} help={t('Renaming or changing the TLS mode triggers a new check.')}>
          <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('Note')}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
      <DomainOptions v={v} set={(p) => setV((x) => ({ ...x, ...p }))} groups={groups} campaigns={campaigns} />
      <div className="form-grid">
        {isAdmin && (
          <Field help={t('Serve the admin panel at https://domain/<admin-path>/.')}>
            <Toggle checked={admin} onChange={setAdmin} label={t('Panel access')} />
          </Field>
        )}
        <Field help={t('A disabled domain answers nothing.')}>
          <Toggle checked={enabled} onChange={setEnabled} label={t('Enabled@@domain')} />
        </Field>
      </div>
      {reputation.length > 0 && (
        <>
          <div className="section-head">
            <h4>{t('Reputation')}</h4>
            <span className="muted small">{t('checked {ago}', { ago: fmtAgo(domain.rep_checked_at) })}</span>
          </div>
          <div className="list rep-list">
            {reputation.map((r) => (
              <div className="list-row" key={r.provider}>
                <span className="strong rep-list-name">{names.full(r.provider)}</span>
                <Badge tone={r.status === 'listed' ? 'err' : r.status === 'clean' ? 'ok' : 'warn'}>{r.status === 'listed' ? t('listed') : r.status === 'clean' ? t('not listed') : t('no answer')}</Badge>
                <span className="grow muted small">{ts(r.detail)}</span>
                {r.url && (
                  <a className="icon-btn" href={r.url} target="_blank" rel="noreferrer noopener" title={t('Open the provider’s page about this domain')}>
                    <ExternalLink size={14} />
                  </a>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  )
}

function GroupsModal({ groups, domains, reload, onClose }: { groups: DomainGroup[]; domains: Domain[]; reload: () => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState('')
  const [edit, setEdit] = useState<{ id: number; name: string } | null>(null)
  const [busy, run] = useBusy()
  const count = (id: number) => domains.filter((d) => d.group_id === id).length

  const create = () =>
    run(async () => {
      await post('domain-groups', { name })
      setName('')
      await reload()
    })
  const rename = () =>
    run(async () => {
      if (!edit) return
      await put(`domain-groups/${edit.id}`, { name: edit.name })
      setEdit(null)
      await reload()
    })
  const remove = async (g: DomainGroup) => {
    const n = count(g.id)
    if (!(await confirmDialog({ title: t('Delete group?'), message: <>{tx('Group <b>{name}</b> will be deleted.', { b: (c) => <b>{c}</b>, name: g.name })}{n > 0 && ' ' + tn(n, 'Its {n} domain is kept and becomes ungrouped.', 'Its {n} domains are kept and become ungrouped.')}</> }))) return
    run(async () => {
      await del(`domain-groups/${g.id}`)
      await reload()
    })
  }

  return (
    <Modal title={t('Domain groups')} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>{t('Done')}</button>}>
      <form
        className="row gap"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) create()
        }}
      >
        <input className="input grow" placeholder={t('New group name')} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" disabled={busy || !name.trim()}>
          <Plus size={14} /> {t('Create')}
        </button>
      </form>
      <div className="list">
        {groups.length === 0 && <div className="muted pad">{t('No groups yet. Groups are labels for filtering and bulk actions.')}</div>}
        {groups.map((g) => (
          <div className="list-row" key={g.id}>
            {edit && edit.id === g.id ? (
              <form
                className="row gap grow"
                onSubmit={(e) => {
                  e.preventDefault()
                  rename()
                }}
              >
                <input className="input grow" autoFocus value={edit.name} onChange={(e) => setEdit({ id: g.id, name: e.target.value })} />
                <button className="btn small primary" disabled={busy || !edit.name.trim()}>
                  {t('Save')}
                </button>
                <button type="button" className="btn small" onClick={() => setEdit(null)}>
                  {t('Cancel')}
                </button>
              </form>
            ) : (
              <>
                <span className="grow strong">{g.name}</span>
                <span className="muted">{tn(count(g.id), '{n} domain', '{n} domains')}</span>
                <button className="icon-btn" title={t('Rename')} onClick={() => setEdit({ id: g.id, name: g.name })}>
                  <Pencil size={15} />
                </button>
                <button className="icon-btn danger" title={t('Delete')} onClick={() => remove(g)}>
                  <Trash2 size={15} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </Modal>
  )
}
