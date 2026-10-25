import type { ReactNode } from 'react'
import { Check, MoreVertical } from 'lucide-react'
import { Dropdown } from './ui'
import { t } from '../i18n'

export interface MenuAction {
  icon: ReactNode
  label: string
  title?: string
  onClick: () => void
  danger?: boolean
  checked?: boolean
}
export interface MenuSection {
  title?: string
  items: MenuAction[]
  /** Free content after the items, such as an empty-state line. */
  extra?: ReactNode
}

/** A "more" menu built from sections; empty sections are left out and the rest divided by hairlines. */
export function ActionMenu({ sections, label, className = 'icon-btn', title = t('More') }: { sections: MenuSection[]; label?: ReactNode; className?: string; title?: string }) {
  const live = sections.filter((s) => s.items.length > 0 || s.extra)
  return (
    <Dropdown align="right" className={className} chevron={false} label={label ?? <MoreVertical size={15} />} title={title}>
      {(close) => (
        <div className="amenu">
          {live.map((s, si) => (
            <div key={si} className="amenu-sec">
              {s.title && <div className="amenu-title">{s.title}</div>}
              {s.items.map((a, i) => (
                <button
                  key={i}
                  type="button"
                  className={'amenu-item' + (a.danger ? ' danger' : '')}
                  title={a.title}
                  onClick={() => {
                    close()
                    a.onClick()
                  }}
                >
                  <span className="amenu-ico">{a.icon}</span>
                  <span className="amenu-label">{a.label}</span>
                  {a.checked && <Check size={14} className="amenu-check" />}
                </button>
              ))}
              {s.extra}
            </div>
          ))}
        </div>
      )}
    </Dropdown>
  )
}
