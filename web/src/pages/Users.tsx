import { useState } from 'react'
import { Dices, KeyRound, Plus, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react'
import { del, errMsg, get, post, put } from '../api'
import { useApp, useLoad } from '../hooks'
import type { User } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { Badge, CopyButton, Empty, ErrorBox, Field, Modal, Notice, PageHeader, Segmented, Toggle, confirmDialog, toast, useBusy } from '../components/ui'
import { t, tx } from '../i18n'

/** Random password from an unambiguous alphabet, using the browser CSPRNG. */
function generatePassword(length = 18): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const out: string[] = []
  const buf = new Uint32Array(length * 2)
  crypto.getRandomValues(buf)
  const limit = Math.floor(0x100000000 / alphabet.length) * alphabet.length
  for (let i = 0; i < buf.length && out.length < length; i++) {
    if (buf[i] < limit) out.push(alphabet[buf[i] % alphabet.length])
  }
  while (out.length < length) out.push(alphabet[out.length % alphabet.length])
  return out.join('')
}

const ROLE_HELP: Record<string, string> = {
  user: t('Works with their own campaigns, domains, whitepages and postback keys, plus campaigns shared with them.'),
  admin: t('Sees and changes everything, manages users, anti-bot and global settings.'),
}

export default function UsersPage() {
  const { user: me } = useApp()
  const list = useLoad(() => get<User[]>('users'), [])
  const [creating, setCreating] = useState(false)
  const [resetting, setResetting] = useState<User | null>(null)
  const users = list.data ?? []

  const patch = async (u: User, body: { role?: string; enabled?: boolean }, ok: string) => {
    try {
      const n = await put<User>(`users/${u.id}`, body)
      list.setData(users.map((x) => (x.id === u.id ? n : x)))
      toast.ok(ok)
    } catch (e) {
      toast.err(e)
    }
  }
  const setRole = async (u: User, role: string) => {
    const ok = await confirmDialog({
      title: role === 'admin' ? t('Make {name} an administrator?', { name: u.username }) : t('Make {name} a regular user?', { name: u.username }),
      danger: false,
      confirmLabel: role === 'admin' ? t('Make admin') : t('Make user'),
      message: role === 'admin' ? t('Administrators see and change everything in the panel, including other users, anti-bot and global settings.') : t('They keep what they own, but lose access to other people’s data, Users, Anti-bot and global settings.'),
    })
    if (ok) patch(u, { role }, role === 'admin' ? t('{name} is now an administrator', { name: u.username }) : t('{name} is now a regular user', { name: u.username }))
  }
  const remove = async (u: User) => {
    const ok = await confirmDialog({
      title: t('Delete user {name}?', { name: u.username }),
      message: tx('The account is removed and can no longer sign in. <b>Everything they own — campaigns, domains, groups, whitepages and postback keys — is handed over to you ({me})</b>, so live campaigns and domains keep working. This cannot be undone.', { b: (c) => <b>{c}</b>, me: me.username }),
    })
    if (!ok) return
    try {
      await del(`users/${u.id}`)
      toast.ok(t('{name} deleted; their items now belong to you', { name: u.username }))
      list.reload()
    } catch (e) {
      toast.err(e)
    }
  }

  const columns: Column<User>[] = [
    {
      key: 'username',
      title: t('Username'),
      sort: (u) => u.username.toLowerCase(),
      render: (u) => (
        <span className="row gap-s">
          <span className="strong">{u.username}</span>
          {u.id === me.id && <Badge>{t('you')}</Badge>}
        </span>
      ),
    },
    { key: 'role', title: t('Role'), sort: (u) => u.role, render: (u) => <Badge tone={u.role === 'admin' ? 'accent' : 'neutral'} title={ROLE_HELP[u.role]}>{u.role === 'admin' ? t('Administrator') : t('User')}</Badge> },
    {
      key: 'enabled',
      title: t('Enabled'),
      width: 90,
      sort: (u) => (u.enabled ? 1 : 0),
      render: (u) => (
        <Toggle
          checked={u.enabled}
          disabled={u.id === me.id}
          title={u.id === me.id ? t('You cannot disable your own account') : u.enabled ? t('Can sign in') : t('Disabled: cannot sign in')}
          onChange={(enabled) => patch(u, { enabled }, enabled ? t('{name} enabled', { name: u.username }) : t('{name} disabled and signed out', { name: u.username }))}
        />
      ),
    },
    { key: 'totp', title: '2FA', sort: (u) => (u.totp_enabled ? 1 : 0), render: (u) => (u.totp_enabled ? <Badge tone="ok">{t('on@@2FA')}</Badge> : <span className="muted">{t('off@@2FA')}</span>) },
    {
      key: 'actions',
      title: '',
      align: 'right',
      width: 130,
      render: (u) => (
        <div className="row-actions">
          {u.role === 'admin' ? (
            <button className="icon-btn" title={t('Make a regular user')} disabled={u.id === me.id} onClick={() => setRole(u, 'user')}>
              <ShieldOff size={15} />
            </button>
          ) : (
            <button className="icon-btn" title={t('Make administrator')} onClick={() => setRole(u, 'admin')}>
              <ShieldCheck size={15} />
            </button>
          )}
          <button className="icon-btn" title={t('Reset password')} onClick={() => setResetting(u)}>
            <KeyRound size={15} />
          </button>
          <button className="icon-btn danger" title={u.id === me.id ? t('You cannot delete your own account') : t('Delete user')} disabled={u.id === me.id} onClick={() => remove(u)}>
            <Trash2 size={15} />
          </button>
        </div>
      ),
    },
  ]

  return (
    <div className="page page-narrow">
      <PageHeader title={t('Users')} sub={t("Each user works with their own campaigns, domains, whitepages and postback keys. Campaigns can be shared from the campaign's Sharing tab.")}>
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={15} /> {t('New user')}
        </button>
      </PageHeader>
      <ErrorBox error={list.error} retry={list.reload} />
      <div className="card">
        <DataTable columns={columns} rows={list.data} rowKey={(u) => u.id} loading={list.loading} rowClass={(u) => (u.enabled ? '' : 'dim')} empty={<Empty title={t('No users')} />} />
      </div>
      {creating && (
        <PasswordDialog
          mode="create"
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false)
            list.reload()
          }}
        />
      )}
      {resetting && <PasswordDialog mode="reset" user={resetting} onClose={() => setResetting(null)} onDone={() => setResetting(null)} />}
    </div>
  )
}

/** Create a user, or set a new password for an existing one. */
function PasswordDialog({ mode, user, onClose, onDone }: { mode: 'create' | 'reset'; user?: User; onClose: () => void; onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('user')
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const nameErr = mode === 'create' && username && !/^[A-Za-z0-9._-]{3,32}$/.test(username) ? t('3–32 letters, digits, dot, dash or underscore') : ''
  const pwErr = password && password.length < 10 ? t('At least 10 characters') : ''
  const valid = password.length >= 10 && (mode === 'reset' || (!!username && !nameErr))

  const submit = () =>
    run(async () => {
      setError('')
      try {
        if (mode === 'create') {
          await post<User>('users', { username, password, role })
          toast.ok(t('User {name} created', { name: username }))
        } else if (user) {
          await put<User>(`users/${user.id}`, { password })
          toast.ok(t('Password of {name} changed; their sessions were signed out', { name: user.username }))
        }
        onDone()
      } catch (e) {
        setError(errMsg(e))
      }
    })

  return (
    <Modal
      title={mode === 'create' ? t('New user') : t('Reset password: {name}', { name: user?.username ?? '' })}
      onClose={onClose}
      footer={
        <>
          {error && <div className="field-error grow">{error}</div>}
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !valid} onClick={submit}>
            {mode === 'create' ? t('Create user') : t('Set password')}
          </button>
        </>
      }
    >
      {mode === 'create' && (
        <Field label={t('Username')} error={nameErr}>
          <input className="input" autoFocus autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value.trim())} />
        </Field>
      )}
      <Field label={mode === 'create' ? t('Password') : t('New password')} error={pwErr} help={t('At least 10 characters. It is shown here so you can pass it on; it cannot be viewed later.')}>
        <div className="row gap-s">
          <input className="input mono grow" autoComplete="off" spellCheck={false} autoFocus={mode === 'reset'} value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="button" className="btn" title={t('Generate a random password')} onClick={() => setPassword(generatePassword())}>
            <Dices size={14} /> {t('Generate')}
          </button>
          <CopyButton text={password} className="btn" />
        </div>
      </Field>
      {mode === 'create' ? (
        <Field label={t('Role')} help={ROLE_HELP[role]}>
          <Segmented
            value={role}
            onChange={setRole}
            options={[
              { value: 'user', label: t('User') },
              { value: 'admin', label: t('Administrator') },
            ]}
          />
        </Field>
      ) : (
        <Notice tone="warn">{t('The user is signed out everywhere and must sign in with the new password. Two-factor authentication, if enabled, stays on.')}</Notice>
      )}
    </Modal>
  )
}
