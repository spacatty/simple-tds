import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { Activity, AppWindow, BarChart3, Bookmark, Check, ChevronDown, ChevronsUpDown, Earth, EyeOff, FileCode2, Folder, Globe, HeartPulse, KeyRound, LayoutDashboard, LayoutTemplate, Layers, Link2, ListOrdered, LogOut, MapPin, Menu, MonitorSmartphone, Moon, MousePointerClick, PanelLeftClose, PanelLeftOpen, Settings as SettingsIcon, ShieldCheck, Split, Sun, Target, Unlink, UserCog, Users as UsersIcon, Webhook } from 'lucide-react'
import type { ReactNode } from 'react'
import type { User } from '../types'
import type { Theme } from '../hooks'
import { LANGS, lang, setLang, t } from '../i18n'
import { Flag, FunnelIcon } from './icons'
import { APP_NAME, Logo } from './Logo'
import { BUILTIN_PINS_DEFAULT, BUILTIN_PINS_PREF, BUILTIN_PRESETS, TOP_PATH, builtinHref, builtinOf, presetHref, reloadReportPresets, useReportPresets } from '../reportPresets'
import { usePref } from '../hooks'
import { GROUP_PINS_DEFAULT, GROUP_PINS_PREF, groupHref, pinOrder, pinnedGroups, reloadCampaignGroups, useCampaignGroups } from '../campaignGroups'
import { Dropdown } from './ui'

interface Item {
  to: string
  label: string
  icon: (props: { size?: number }) => ReactNode
  end?: boolean
  admin?: boolean
}

const GROUPS: { id: string; label: string; items: Item[] }[] = [
  { id: 'overview', label: t('Overview'), items: [{ to: '/', label: t('Dashboard'), icon: LayoutDashboard, end: true }] },
  {
    id: 'traffic',
    label: t('Traffic'),
    items: [
      { to: '/campaigns', label: t('Campaigns'), icon: Split },
      // "end": the presets live under /funnels/ and must not light this one up.
      { to: '/funnels', label: t('Funnels'), icon: FunnelIcon, end: true },
      { to: '/funnels/presets', label: t('Funnel presets'), icon: Layers },
    ],
  },
  {
    // Everything about conversions in one place: what arrived, every postback request, and the keys.
    id: 'conversions',
    label: t('Conversions'),
    items: [
      // "end": the other two pages live under /conversions/ and must not light this one up.
      { to: '/conversions', label: t('Conversion log'), icon: Target, end: true },
      { to: '/conversions/postbacks', label: t('Postback log'), icon: Webhook },
      { to: '/conversions/keys', label: t('Keys & postback URLs'), icon: KeyRound },
    ],
  },
  {
    id: 'resources',
    label: t('Resources'),
    items: [
      { to: '/domains', label: t('Domains'), icon: Globe },
      { to: '/whitepages', label: t('Whitepages'), icon: FileCode2 },
      { to: '/landings', label: t('Landings'), icon: LayoutTemplate },
      { to: '/geo-presets', label: t('Geo presets'), icon: MapPin },
    ],
  },
  {
    id: 'reports',
    label: t('Reports'),
    items: [
      { to: '/clicks', label: t('Click log'), icon: MousePointerClick },
      // "end": the other reports live under /reports/ and must not light this one up.
      { to: '/reports', label: t('Breakdown'), icon: BarChart3, end: true },
      { to: '/reports/referrer-activity', label: t('Referrer activity'), icon: HeartPulse },
      { to: TOP_PATH, label: t('Top lists'), icon: ListOrdered },
    ],
  },
  {
    id: 'utilities',
    label: t('Utilities'),
    items: [
      { to: '/antibot', label: t('Anti-bot'), icon: ShieldCheck, admin: true },
      { to: '/suppress/ips', label: t('Suppress IPs'), icon: EyeOff },
      { to: '/suppress/referrers', label: t('Suppress referrers'), icon: Unlink },
    ],
  },
  {
    id: 'system',
    label: t('System'),
    items: [
      { to: '/status', label: t('Status'), icon: Activity, admin: true },
      { to: '/users', label: t('Users'), icon: UsersIcon, admin: true },
      { to: '/settings', label: t('Settings'), icon: SettingsIcon, admin: true },
    ],
  },
]

const BUILTIN_ICONS: Record<string, Item['icon']> = { referrers: Link2, geo: Earth, devices: MonitorSmartphone, os: AppWindow }

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {
    /* private mode */
  }
}

export function Sidebar({ user, theme, toggleTheme, logout }: { user: User; theme: Theme; toggleTheme: () => void; logout: () => void }) {
  const [rail, setRail] = useState<boolean>(() => load('tds_nav_rail', false))
  const [folded, setFolded] = useState<string[]>(() => load('tds_nav_folded', []))
  const [mobileOpen, setMobileOpen] = useState(false)
  const loc = useLocation()
  const admin = user.role === 'admin'
  const role = admin ? t('Administrator') : t('User')

  // The saved report views the user keeps in the sidebar.
  const presets = useReportPresets()
  useEffect(() => {
    reloadReportPresets()
    reloadCampaignGroups()
  }, [user.id])
  // The pinned campaign groups hang under Campaigns, in the order the user keeps them: each opens the list filtered to it.
  const allGroups = useCampaignGroups() ?? []
  const [groupPins, setGroupPins] = usePref<string>(GROUP_PINS_PREF, GROUP_PINS_DEFAULT)
  const campGroups = pinnedGroups(groupPins, allGroups)
  const openGroup = loc.pathname === '/campaigns' ? campGroups.find((g) => String(g.id) === new URLSearchParams(loc.search).get('group')) : undefined
  // Dragging a pinned group up or down the list saves the new order. The dragged id lives in
  // a ref: drag events come fast, and the state (for the styling) may lag a render behind.
  const dragging = useRef<number | null>(null)
  const [dragId, setDragId] = useState<number | null>(null)
  const [overId, setOverId] = useState<number | null>(null)
  const startDrag = (id: number | null) => {
    dragging.current = id
    setDragId(id)
    if (id === null) setOverId(null)
  }
  const dropGroup = (onto: number) => {
    const from = dragging.current
    if (from === null || from === onto) return
    const ids = campGroups.map((g) => g.id).filter((id) => id !== from)
    ids.splice(ids.indexOf(onto), 0, from)
    setGroupPins(pinOrder(ids))
  }
  const pinned = (presets ?? []).filter((p) => p.pinned)
  const openPreset = loc.pathname === TOP_PATH ? pinned.find((p) => String(p.id) === new URLSearchParams(loc.search).get('preset')) : undefined
  // And the built-in ones: which of them are listed is a preference on the account.
  const [builtinPins] = usePref<string>(BUILTIN_PINS_PREF, BUILTIN_PINS_DEFAULT)
  const builtins = BUILTIN_PRESETS.filter((b) => builtinPins.split(',').includes(b.key))
  const openBuiltin = loc.pathname === TOP_PATH ? builtins.find((b) => b === builtinOf(loc.search)) : undefined

  // Navigating closes the overlay drawer on narrow screens.
  useEffect(() => setMobileOpen(false), [loc.pathname])
  // So does Escape.
  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileOpen])

  const toggleRail = () => {
    setRail((r) => {
      save('tds_nav_rail', !r)
      return !r
    })
  }
  // Ctrl+B (⌘B) folds the sidebar; on narrow screens it opens and closes the drawer instead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.code !== 'KeyB') return
      e.preventDefault()
      if (window.matchMedia('(max-width: 900px)').matches) setMobileOpen((o) => !o)
      else toggleRail()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const toggleGroup = (id: string) => {
    setFolded((f) => {
      const next = f.includes(id) ? f.filter((x) => x !== id) : [...f, id]
      save('tds_nav_folded', next)
      return next
    })
  }

  // A pinned preset is a view of the report constructor: while one is open it is lit instead of the page's own item.
  const isActive = (it: Item) => ((it.to === TOP_PATH && (openPreset || openBuiltin)) || (it.to === '/campaigns' && openGroup) ? false : it.end ? loc.pathname === it.to : loc.pathname === it.to || loc.pathname.startsWith(it.to + '/'))
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => !i.admin || admin) })).filter((g) => g.items.length > 0)
  // The rail has no room for headers, so folding only applies to the full sidebar.
  const compact = rail && !mobileOpen

  return (
    <>
      <header className="topbar">
        <button className="icon-btn" onClick={() => setMobileOpen(true)} aria-label={t('Open navigation')}>
          <Menu size={20} />
        </button>
        <Logo size={24} />
        <b className="wordmark">{APP_NAME}</b>
      </header>
      {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />}
      <aside className={'sidebar' + (compact ? ' rail' : '') + (mobileOpen ? ' mobile-open' : '')}>
        <div className="sidebar-head">
          <Logo />
          <span className="brand-name wordmark">{APP_NAME}</span>
          <button className="icon-btn rail-toggle" onClick={toggleRail} title={(rail ? t('Expand sidebar') : t('Collapse sidebar')) + ' (Ctrl+B)'} aria-label={rail ? t('Expand sidebar') : t('Collapse sidebar')}>
            {rail ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>

        <nav className="sidebar-nav" aria-label={t('Main navigation')}>
          {groups.map((g) => {
            const isFolded = !compact && folded.includes(g.id)
            // A folded group still shows its active page, so the current location is never hidden.
            const items = isFolded ? g.items.filter((i) => isActive(i) || (i.to === '/campaigns' && openGroup)) : g.items
            return (
              <div className="nav-group" key={g.id}>
                <button className={'nav-group-head' + (isFolded ? ' folded' : '')} onClick={() => toggleGroup(g.id)} aria-expanded={!isFolded} title={compact ? g.label : undefined}>
                  <span>{g.label}</span>
                  <ChevronDown size={13} />
                </button>
                {items.map((n) => (
                  <div key={n.to} className="nav-entry">
                    <NavLink to={n.to} end={n.end} data-tip={n.label} className={() => 'nav-item' + (isActive(n) ? ' active' : '')}>
                      <n.icon size={17} />
                      <span>{n.label}</span>
                    </NavLink>
                    {n.to === '/campaigns' && campGroups.length > 0 && (!isFolded || openGroup) && (
                      <div className="nav-sub">
                        {campGroups
                          .filter((cg) => !isFolded || cg === openGroup)
                          .map((cg) => (
                            <Link
                              key={cg.id}
                              to={groupHref(cg.id)}
                              data-tip={cg.name}
                              title={campGroups.length > 1 ? t('{name} — drag to reorder', { name: cg.name }) : cg.name}
                              className={'nav-item' + (cg === openGroup ? ' active' : '') + (dragId === cg.id ? ' dragging' : '') + (overId === cg.id && dragId !== cg.id ? ' drop-target' : '')}
                              aria-current={cg === openGroup ? 'page' : undefined}
                              draggable={campGroups.length > 1 && !isFolded}
                              onDragStart={(e) => {
                                e.dataTransfer.effectAllowed = 'move'
                                startDrag(cg.id)
                              }}
                              onDragEnter={() => dragging.current !== null && setOverId(cg.id)}
                              onDragOver={(e) => {
                                if (dragging.current === null) return
                                e.preventDefault()
                                e.dataTransfer.dropEffect = 'move'
                              }}
                              onDrop={(e) => {
                                e.preventDefault()
                                dropGroup(cg.id)
                                startDrag(null)
                              }}
                              onDragEnd={() => startDrag(null)}
                            >
                              <Folder size={16} />
                              <span className="ellipsis">{cg.name}</span>
                            </Link>
                          ))}
                      </div>
                    )}
                  </div>
                ))}
                {/* The pinned views of Top lists hang under it, the last item of the group. */}
                {g.id === 'reports' && (isFolded ? !!(openBuiltin || openPreset) : builtins.length + pinned.length > 0) && (
                  <div className="nav-sub">
                    {builtins
                      .filter((b) => !isFolded || b === openBuiltin)
                      .map((b) => {
                        const Icon = BUILTIN_ICONS[b.key] ?? Bookmark
                        return (
                          <Link key={b.key} to={builtinHref(b)} data-tip={b.name} className={'nav-item' + (b === openBuiltin ? ' active' : '')} aria-current={b === openBuiltin ? 'page' : undefined}>
                            <Icon size={17} />
                            <span className="ellipsis">{b.name}</span>
                          </Link>
                        )
                      })}
                    {pinned
                      .filter((p) => !isFolded || p === openPreset)
                      .map((p) => (
                        <Link key={p.id} to={presetHref(p)} data-tip={p.name} title={p.name} className={'nav-item' + (p === openPreset ? ' active' : '')} aria-current={p === openPreset ? 'page' : undefined}>
                          <Bookmark size={17} />
                          <span className="ellipsis">{p.name}</span>
                        </Link>
                      ))}
                  </div>
                )}
              </div>
            )
          })}
        </nav>

        <div className="sidebar-foot">
          <Dropdown
            className="profile-btn"
            chevron={false}
            title={compact ? `${user.username} · ${role}` : undefined}
            label={
              <>
                <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
                <span className="who-text">
                  <b className="ellipsis">{user.username}</b>
                  <small>{role}</small>
                </span>
                <ChevronsUpDown size={14} className="profile-chevron" />
              </>
            }
          >
            {(close) => (
              <div className="menu profile-menu">
                <div className="profile-menu-head">
                  <b className="ellipsis">{user.username}</b>
                  <small>{role}</small>
                </div>
                <div className="menu-sep" />
                <Link className="menu-item" to="/account" onClick={close}>
                  <UserCog size={15} /> {t('Account')}
                </Link>
                {admin && (
                  <Link className="menu-item" to="/users" onClick={close}>
                    <UsersIcon size={15} /> {t('Users')}
                  </Link>
                )}
                <div className="menu-sep" />
                <div className="menu-title">{t('Language')}</div>
                {LANGS.map((l) => (
                  <button key={l.code} className="menu-item" role="menuitemradio" aria-checked={l.code === lang} onClick={() => (close(), setLang(l.code))}>
                    <Flag code={l.flag} /> {l.name}
                    {l.code === lang && <Check size={14} className="menu-check" />}
                  </button>
                ))}
                <div className="menu-sep" />
                <button
                  className="menu-item"
                  onClick={() => {
                    close()
                    toggleTheme()
                  }}
                >
                  {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />} {theme === 'dark' ? t('Light theme') : t('Dark theme')}
                </button>
                <div className="menu-sep" />
                <button
                  className="menu-item danger"
                  onClick={() => {
                    close()
                    logout()
                  }}
                >
                  <LogOut size={15} /> {t('Sign out')}
                </button>
              </div>
            )}
          </Dropdown>
        </div>
      </aside>
    </>
  )
}
