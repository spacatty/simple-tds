import { useEffect, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { Activity, BarChart3, Check, ChevronDown, ChevronsUpDown, EyeOff, FileCode2, Globe, KeyRound, LayoutDashboard, LayoutTemplate, Layers, Link2, LogOut, Menu, Moon, MousePointerClick, PanelLeftClose, PanelLeftOpen, Settings as SettingsIcon, ShieldCheck, Split, Sun, Target, Unlink, UserCog, Users as UsersIcon, Webhook } from 'lucide-react'
import type { ReactNode } from 'react'
import type { User } from '../types'
import type { Theme } from '../hooks'
import { LANGS, lang, setLang, t } from '../i18n'
import { Flag, FunnelIcon } from './icons'
import { APP_NAME, Logo } from './Logo'
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
    id: 'conversions',
    label: t('Conversions'),
    items: [{ to: '/conversions/keys', label: t('Keys & postback URLs'), icon: KeyRound }],
  },
  {
    id: 'resources',
    label: t('Resources'),
    items: [
      { to: '/domains', label: t('Domains'), icon: Globe },
      { to: '/whitepages', label: t('Whitepages'), icon: FileCode2 },
      { to: '/landings', label: t('Landings'), icon: LayoutTemplate },
    ],
  },
  {
    id: 'tracking',
    label: t('Tracking'),
    items: [
      { to: '/clicks', label: t('Click log'), icon: MousePointerClick },
      // "end": the other two pages live under /conversions/ and must not light this one up.
      { to: '/conversions', label: t('Conversion log'), icon: Target, end: true },
      { to: '/conversions/postbacks', label: t('Postback log'), icon: Webhook },
    ],
  },
  {
    id: 'reports',
    label: t('Reports'),
    items: [
      // "end": the other reports live under /reports/ and must not light this one up.
      { to: '/reports', label: t('Breakdown'), icon: BarChart3, end: true },
      { to: '/reports/referrers', label: t('Referrers'), icon: Link2 },
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
      { to: '/settings', label: t('Settings'), icon: SettingsIcon, admin: true },
    ],
  },
]

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

  const isActive = (it: Item) => (it.end ? loc.pathname === it.to : loc.pathname === it.to || loc.pathname.startsWith(it.to + '/'))
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
        <b>{APP_NAME}</b>
      </header>
      {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />}
      <aside className={'sidebar' + (compact ? ' rail' : '') + (mobileOpen ? ' mobile-open' : '')}>
        <div className="sidebar-head">
          <Logo />
          <span className="brand-name">{APP_NAME}</span>
          <button className="icon-btn rail-toggle" onClick={toggleRail} title={(rail ? t('Expand sidebar') : t('Collapse sidebar')) + ' (Ctrl+B)'} aria-label={rail ? t('Expand sidebar') : t('Collapse sidebar')}>
            {rail ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>

        <nav className="sidebar-nav" aria-label={t('Main navigation')}>
          {groups.map((g) => {
            const isFolded = !compact && folded.includes(g.id)
            // A folded group still shows its active page, so the current location is never hidden.
            const items = isFolded ? g.items.filter(isActive) : g.items
            return (
              <div className="nav-group" key={g.id}>
                <button className={'nav-group-head' + (isFolded ? ' folded' : '')} onClick={() => toggleGroup(g.id)} aria-expanded={!isFolded} title={compact ? g.label : undefined}>
                  <span>{g.label}</span>
                  <ChevronDown size={13} />
                </button>
                {items.map((n) => (
                  <NavLink key={n.to} to={n.to} end={n.end} data-tip={n.label} className={({ isActive: a }) => 'nav-item' + (a ? ' active' : '')}>
                    <n.icon size={17} />
                    <span>{n.label}</span>
                  </NavLink>
                ))}
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
