import { useState } from 'react'
import { Pin, Plus } from 'lucide-react'
import { get, post, put } from '../api'
import { useLoad } from '../hooks'
import type { Board, BoardWidget } from '../types'
import { Dropdown, ErrorBox, MenuItem, Skeleton, toast, useBusy } from './ui'
import { t } from '../i18n'

function PinList({ widget, close }: { widget: Omit<BoardWidget, 'id'>; close: () => void }) {
  const boards = useLoad(() => get<Board[] | null>('dashboards'), [])
  const [name, setName] = useState('')
  const [busy, run] = useBusy()
  const done = (board: string) => {
    toast.ok(t('Pinned to dashboard “{name}”', { name: board }))
    close()
  }
  const pin = (b: Board) =>
    run(async () => {
      try {
        await put(`dashboards/${b.id}`, { widgets: [...(b.widgets ?? []), widget] })
        done(b.name)
      } catch (e) {
        toast.err(e)
      }
    })
  const create = () =>
    run(async () => {
      try {
        const b = await post<Board>('dashboards', { name: name.trim(), widgets: [widget] })
        done(b.name)
      } catch (e) {
        toast.err(e)
      }
    })
  return (
    <div className="menu pin-menu">
      <div className="menu-title">{t('Pin to a dashboard')}</div>
      <ErrorBox error={boards.error} retry={boards.reload} />
      {!boards.data && !boards.error && (
        <div className="pad-s">
          <Skeleton rows={2} />
        </div>
      )}
      {(boards.data ?? []).map((b) => (
        <MenuItem key={b.id} disabled={busy} onClick={() => pin(b)}>
          <Pin size={14} /> <span className="grow ellipsis">{b.name}</span>
        </MenuItem>
      ))}
      <div className="menu-sep" />
      <form
        className="row gap-s pad-s"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) create()
        }}
      >
        <input className="input input-sm grow" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('New dashboard…')} maxLength={64} />
        <button className="btn small primary" disabled={busy || !name.trim()} title={t('Create a dashboard and pin this to it')} aria-label={t('Create')}>
          <Plus size={14} />
        </button>
      </form>
    </div>
  )
}

/** "Pin": puts a widget on one of the user's own dashboards, or on a new one. */
export function PinMenu({ widget }: { widget: Omit<BoardWidget, 'id'> }) {
  return (
    <Dropdown
      align="right"
      className="btn"
      chevron={false}
      title={t('Keep this on one of your dashboards')}
      label={
        <>
          <Pin size={14} /> {t('Pin')}
        </>
      }
    >
      {(close) => <PinList widget={widget} close={close} />}
    </Dropdown>
  )
}
