import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { BarChart3, ChevronDown, FileCode2, Globe, LayoutDashboard, LogOut, Menu, Moon, MousePointerClick, PanelLeftClose, PanelLeftOpen, Settings as SettingsIcon, ShieldCheck, Split, Sun, Target, Users as UsersIcon } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { User } from '../types'
import type { Theme } from '../hooks'

interface Item {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
  admin?: boolean
}

const GROUPS: { id: string; label: string; items: Item[] }[] = [
  { id: 'overview', label: 'Overview', items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true }] },
  {
    id: 'traffic',
    label: 'Traffic',
    items: [
      { to: '/campaigns', label: 'Campaigns', icon: Split },
      { to: '/domains', label: 'Domains', icon: Globe },
      { to: '/whitepages', label: 'Whitepages', icon: FileCode2 },
    ],
  },
  {
    id: 'tracking',
    label: 'Tracking',
    items: [
      { to: '/conversions', label: 'Conversions', icon: Target },
      { to: '/reports', label: 'Reports', icon: BarChart3 },
      { to: '/clicks', label: 'Clicks', icon: MousePointerClick },
    ],
  },
  { id: 'protection', label: 'Protection', items: [{ to: '/antibot', label: 'Anti-bot', icon: ShieldCheck, admin: true }] },
  {
    id: 'system',
    label: 'System',
    items: [
      { to: '/users', label: 'Users', icon: UsersIcon, admin: true },
      { to: '/settings', label: 'Settings', icon: SettingsIcon },
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

  // Navigating closes the overlay drawer on narrow screens.
  useEffect(() => setMobileOpen(false), [loc.pathname])

  const toggleRail = () => {
    setRail((r) => {
      save('tds_nav_rail', !r)
      return !r
    })
  }
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
        <button className="icon-btn" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
          <Menu size={20} />
        </button>
        <span className="brand-mark">
          <Split size={15} />
        </span>
        <b>TDS</b>
      </header>
      {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />}
      <aside className={'sidebar' + (compact ? ' rail' : '') + (mobileOpen ? ' mobile-open' : '')}>
        <div className="sidebar-head">
          <span className="brand-mark">
            <Split size={16} />
          </span>
          <span className="brand-name">TDS</span>
          <button className="icon-btn rail-toggle" onClick={toggleRail} title={rail ? 'Expand sidebar' : 'Collapse sidebar'} aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'}>
            {rail ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>

        <nav className="sidebar-nav">
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
          <div className="whoami" data-tip={`${user.username} · ${admin ? 'administrator' : 'user'}`}>
            <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
            <span className="who-text">
              <b className="ellipsis">{user.username}</b>
              <small>{admin ? 'Administrator' : 'User'}</small>
            </span>
          </div>
          <div className="foot-actions">
            <button className="icon-btn" onClick={toggleTheme} data-tip={theme === 'dark' ? 'Light theme' : 'Dark theme'} aria-label="Switch theme">
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button className="icon-btn" onClick={logout} data-tip="Sign out" aria-label="Sign out">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}
