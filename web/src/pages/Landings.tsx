import { useMemo, useState } from 'react'
import { Copy, ExternalLink, Eye, FilePlus2, Pencil, Plus, Save, Trash2, Upload } from 'lucide-react'
import { del, errMsg, get, put, upload } from '../api'
import { useLoad, useMeta } from '../hooks'
import type { Loaded } from '../hooks'
import type { Campaign, Landing, LandingPreset, LandingVar, SystemInfo, WPFile } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { Badge, Empty, ErrorBox, Field, Modal, Notice, PageHeader, Select, Tabs, Toggle, confirmDialog, toast, useBusy } from '../components/ui'
import { CodeEditor } from '../components/CodeEditor'
import { VAR_KIND_HELP, VarValues, varKindLabel } from '../components/LandingVars'
import { FileInput } from './Whitepages'
import { fmtBytes, fmtDateTime, fmtInt } from '../format'
import { t, tn, tx } from '../i18n'

const BASE_HELP = t(
  'Inserts <base href="…"> into the page so that relative links to images, styles, scripts and other pages keep working when the landing is shown on a campaign URL such as /alias. Turn it off only if the page already uses absolute URLs or sets its own <base>.',
)

const TEXT_FILE = /\.(html?|php|m?js|css|json|svg|xml|txt|webmanifest)$/i

function languageOfFile(name: string): string {
  if (/\.(html?|php|svg|xml)$/i.test(name)) return 'html'
  if (/\.m?js$/i.test(name)) return 'javascript'
  if (/\.(json|webmanifest)$/i.test(name)) return 'json'
  return 'text'
}

interface PreviewState {
  landing: Landing
  url: string
}

async function previewURL(id: number, preset?: number, campaignId?: number): Promise<string> {
  const r = await get<{ url: string }>(`landings/${id}/preview-url`, { preset: preset || undefined, campaign_id: campaignId || undefined })
  return r.url
}

export default function Landings() {
  const list = useLoad(() => get<Landing[]>('landings'), [])
  const sys = useLoad(() => get<SystemInfo>('system'), [])
  const [uploading, setUploading] = useState(false)
  const [editing, setEditing] = useState<Landing | null>(null)
  const [preview, setPreview] = useState<PreviewState | null>(null)

  const openPreview = async (l: Landing, preset?: number, campaignId?: number) => {
    try {
      setPreview({ landing: l, url: await previewURL(l.id, preset, campaignId) })
    } catch (e) {
      toast.err(e)
    }
  }
  const remove = async (l: Landing) => {
    if (!(await confirmDialog({ title: t('Delete landing?'), message: tx('<b>{name}</b>, its {files} and its presets will be deleted from the server.', { b: (c) => <b>{c}</b>, name: l.name, files: tn(l.file_count, '{n} file', '{n} files') }) }))) return
    try {
      await del(`landings/${l.id}`)
      toast.ok(t('Landing deleted'))
      list.reload()
    } catch (e) {
      toast.err(e)
    }
  }

  const phpOff = sys.data ? !sys.data.php_enabled : false

  const columns: Column<Landing>[] = [
    {
      key: 'name',
      title: t('Name'),
      sort: (l) => l.name.toLowerCase(),
      render: (l) => (
        <div>
          <button className="link strong" onClick={() => setEditing(l)}>
            {l.name}
          </button>
          {l.note && <div className="muted small">{l.note}</div>}
        </div>
      ),
    },
    {
      key: 'kind',
      title: t('Kind@@whitepage'),
      sort: (l) => l.kind,
      render: (l) => (
        <Badge tone={l.kind === 'php' ? (phpOff ? 'warn' : 'accent') : 'neutral'} title={l.kind === 'php' && phpOff ? t('PHP is not configured on this server: this page will not execute') : undefined}>
          {l.kind.toUpperCase()}
        </Badge>
      ),
    },
    { key: 'vars', title: t('Variables'), align: 'right', sort: (l) => (l.vars ?? []).length, render: (l) => fmtInt((l.vars ?? []).length) },
    { key: 'presets', title: t('Presets'), align: 'right', sort: (l) => (l.presets ?? []).length, render: (l) => fmtInt((l.presets ?? []).length) },
    { key: 'entry', title: t('Entry file'), render: (l) => <code>{l.entry}</code> },
    { key: 'files', title: t('Files'), align: 'right', sort: (l) => l.file_count, render: (l) => fmtInt(l.file_count) },
    { key: 'size', title: t('Size'), align: 'right', sort: (l) => l.size, render: (l) => fmtBytes(l.size) },
    { key: 'created', title: t('Uploaded@@whitepage'), sort: (l) => l.created_at, render: (l) => fmtDateTime(l.created_at, false) },
    {
      key: 'actions',
      title: '',
      align: 'right',
      width: 120,
      render: (l) => (
        <div className="row-actions">
          <button className="icon-btn" title={t('Preview')} onClick={() => openPreview(l)}>
            <Eye size={15} />
          </button>
          <button className="icon-btn" title={t('Edit')} onClick={() => setEditing(l)}>
            <Pencil size={15} />
          </button>
          <button className="icon-btn danger" title={t('Delete')} onClick={() => remove(l)}>
            <Trash2 size={15} />
          </button>
        </div>
      ),
    },
  ]

  return (
    <div className="page">
      <PageHeader title={t('Landings')} sub={t('Pages with variables, served by the “Landing” stream action. One landing is shown with different values by different streams.')}>
        <button className="btn primary" onClick={() => setUploading(true)}>
          <Upload size={15} /> {t('Upload landing')}
        </button>
      </PageHeader>
      {phpOff && (list.data ?? []).some((l) => l.kind === 'php') && (
        <Notice tone="warn" title={t('PHP is not enabled on this server')}>
          {t('PHP landings will not execute. Start the bundled PHP-FPM service (or configure its address) to run them; HTML landings work as usual.')}
        </Notice>
      )}
      <ErrorBox error={list.error} retry={list.reload} />
      <div className="card">
        <DataTable
          columns={columns}
          rows={list.data}
          rowKey={(l) => l.id}
          loading={list.loading}
          empty={
            <Empty title={t('No landings yet')} action={<button className="btn primary" onClick={() => setUploading(true)}><Upload size={15} /> {t('Upload the first one')}</button>}>
              {t('Upload a .zip with a whole site, or a single .html / .php file. Tokens such as CRELLA_VAR_TITLE in its files become variables.')}
            </Empty>
          }
        />
      </div>

      {uploading && (
        <UploadModal
          onClose={() => setUploading(false)}
          onDone={(l) => {
            setUploading(false)
            list.reload()
            setEditing(l)
          }}
        />
      )}
      {editing && (
        <LandingEditor
          landing={editing}
          phpOff={phpOff}
          onClose={() => {
            setEditing(null)
            list.reload()
          }}
          onPreview={openPreview}
        />
      )}
      {preview && (
        <Modal
          size="xl"
          title={
            <>
              {t('Preview: {name}', { name: preview.landing.name })}{' '}
              <a href={preview.url} target="_blank" rel="noreferrer noopener" className="small">
                <ExternalLink size={13} /> {t('open in a new tab')}
              </a>
            </>
          }
          onClose={() => setPreview(null)}
        >
          <iframe className="preview-frame" title={t('Landing preview')} src={preview.url} sandbox="allow-scripts allow-forms allow-popups" />
          <div className="field-help">{t('The preview is sandboxed and shows the saved landing; the link expires in two hours. There is no click behind it, so visitor macros are empty and events are not recorded.')}</div>
        </Modal>
      )}
    </div>
  )
}

function UploadModal({ onClose, onDone }: { onClose: () => void; onDone: (l: Landing) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [injectBase, setInjectBase] = useState(true)
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const submit = () =>
    run(async () => {
      if (!file) return
      setError('')
      const fd = new FormData()
      fd.append('file', file)
      fd.append('name', name)
      fd.append('note', note)
      fd.append('inject_base', injectBase ? 'true' : 'false')
      try {
        const l = await upload<Landing>('landings', fd)
        toast.ok(tn((l.vars ?? []).length, 'Uploaded “{name}”: {n} variable found', 'Uploaded “{name}”: {n} variables found', { name: l.name }))
        onDone(l)
      } catch (e) {
        setError(errMsg(e))
      }
    })
  return (
    <Modal
      title={t('Upload landing')}
      onClose={onClose}
      footer={
        <>
          {error && <div className="field-error grow">{error}</div>}
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !file} onClick={submit}>
            {busy ? t('Uploading…') : t('Upload')}
          </button>
        </>
      }
    >
      <FileInput file={file} onChange={setFile} />
      <Field label={t('Name')} help={t('Defaults to the file name.')}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={file ? file.name.replace(/\.zip$/i, '') : ''} />
      </Field>
      <Field label={t('Note')}>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Field help={BASE_HELP}>
        <Toggle checked={injectBase} onChange={setInjectBase} label={t('Inject <base> tag')} />
      </Field>
    </Modal>
  )
}

type Tab = 'vars' | 'presets' | 'files' | 'settings'

/** Variables the server knows and the draft does not are added; "used" always comes from the server. */
function mergeVars(draft: LandingVar[], server: LandingVar[]): LandingVar[] {
  const byName = new Map(server.map((v) => [v.name, v]))
  const out = draft.map((v) => ({ ...v, used: byName.get(v.name)?.used ?? false }))
  for (const v of server) if (!draft.some((d) => d.name === v.name)) out.push(v)
  return out
}

function LandingEditor({ landing: initial, phpOff, onClose, onPreview }: { landing: Landing; phpOff: boolean; onClose: () => void; onPreview: (l: Landing, preset?: number, campaignId?: number) => void }) {
  const meta = useMeta()
  const prefix = meta.landing_var_prefix ?? 'CRELLA_VAR_'
  const kinds = meta.landing_var_kinds ?? ['text', 'html', 'url', 'js', 'server']
  const [l, setL] = useState(initial)
  const [tab, setTab] = useState<Tab>('vars')
  const [name, setName] = useState(initial.name)
  const [note, setNote] = useState(initial.note)
  const [entry, setEntry] = useState(initial.entry)
  const [injectBase, setInjectBase] = useState(initial.inject_base)
  const [vars, setVars] = useState<LandingVar[]>(initial.vars ?? [])
  const [presets, setPresets] = useState<LandingPreset[]>(initial.presets ?? [])
  const [presetId, setPresetId] = useState<number>(initial.presets?.[0]?.id ?? 0)
  const [campaignId, setCampaignId] = useState(0)
  const [newVar, setNewVar] = useState('')
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const files = useLoad(() => get<WPFile[]>(`landings/${initial.id}/files`), [initial.id])
  const camps = useLoad(() => get<Campaign[]>('campaigns'), [])

  const baseline = useMemo(() => JSON.stringify([l.name, l.note, l.entry, l.inject_base, l.vars ?? [], l.presets ?? []]), [l])
  const dirty = JSON.stringify([name, note, entry, injectBase, vars, presets]) !== baseline

  const campaign = (camps.data ?? []).find((c) => c.id === campaignId)
  const preset = presets.find((p) => p.id === presetId)
  const entryFiles = (files.data ?? []).filter((f) => /\.(html?|php)$/i.test(f.name))

  /** Takes the server's version of the landing after something other than the form changed it. */
  const adopt = (n: Landing) => {
    setL(n)
    setVars((cur) => mergeVars(cur, n.vars ?? []))
    setEntry((cur) => (cur === l.entry ? n.entry : cur))
  }

  const save = () =>
    run(async () => {
      setError('')
      try {
        const selected = preset?.name
        const n = await put<Landing>(`landings/${l.id}`, { name, note, entry, inject_base: injectBase, vars, presets })
        setL(n)
        setName(n.name)
        setNote(n.note)
        setEntry(n.entry)
        setInjectBase(n.inject_base)
        setVars(n.vars ?? [])
        setPresets(n.presets ?? [])
        // New presets get their real ids from the server.
        setPresetId((n.presets ?? []).find((p) => p.name === selected)?.id ?? n.presets?.[0]?.id ?? 0)
        toast.ok(t('Landing saved'))
      } catch (e) {
        setError(errMsg(e))
      }
    })
  const close = async () => {
    if (dirty && !(await confirmDialog({ title: t('Discard unsaved changes?'), confirmLabel: t('Discard'), message: t('The changes you made to this landing have not been saved.') }))) return
    onClose()
  }

  const setVar = (i: number, patch: Partial<LandingVar>) => setVars(vars.map((v, j) => (j === i ? { ...v, ...patch } : v)))
  const addVar = () => {
    const n = newVar.trim().toUpperCase().replace(new RegExp('^' + prefix), '')
    if (!/^[A-Z0-9]+(_[A-Z0-9]+)*$/.test(n)) return setError(t('A variable name is capital letters, digits and single underscores: TITLE, DB_DSN.'))
    if (vars.some((v) => v.name === n)) return setError(t('Variable {name} is already declared.', { name: n }))
    setError('')
    setVars([...vars, { name: n, label: '', kind: 'text', default: '', used: false }])
    setNewVar('')
  }

  const setPreset = (patch: Partial<LandingPreset>) => setPresets(presets.map((p) => (p.id === presetId ? { ...p, ...patch } : p)))
  const addPreset = (from?: LandingPreset) => {
    // Negative ids mark presets the server has not numbered yet.
    const id = Math.min(0, ...presets.map((p) => p.id)) - 1
    let n = from ? t('{name} (copy)', { name: from.name }) : t('Preset {n}', { n: presets.length + 1 })
    while (presets.some((p) => p.name.toLowerCase() === n.toLowerCase())) n += ' *'
    setPresets([...presets, { id, name: n, values: { ...(from?.values ?? {}) } }])
    setPresetId(id)
  }
  const removePreset = () => {
    const rest = presets.filter((p) => p.id !== presetId)
    setPresets(rest)
    setPresetId(rest[0]?.id ?? 0)
  }

  return (
    <Modal
      title={t('Landing: {name}', { name: l.name })}
      size="xl"
      onClose={close}
      footer={
        <>
          {error ? <div className="field-error grow">{error}</div> : <div className="grow muted small">{dirty ? t('Unsaved changes') : ''}</div>}
          <button
            className="btn"
            disabled={dirty}
            title={dirty ? t('Save first: the preview shows the saved landing') : tab === 'presets' && preset ? t('Preview with preset “{name}”', { name: preset.name }) : t('Preview with the default values')}
            onClick={() => onPreview(l, tab === 'presets' && presetId > 0 ? presetId : undefined, campaignId || undefined)}
          >
            <Eye size={14} /> {t('Preview')}
          </button>
          <button className="btn" onClick={close}>
            {t('Close')}
          </button>
          <button className="btn primary" disabled={busy || !name.trim() || !dirty} onClick={save}>
            {t('Save')}
          </button>
        </>
      }
    >
      {l.kind === 'php' && phpOff && <Notice tone="warn">{t('PHP is not enabled on this server, so this page will not execute.')}</Notice>}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'vars', label: t('Variables ({n})', { n: vars.length }) },
          { value: 'presets', label: t('Presets ({n})', { n: presets.length }) },
          { value: 'files', label: t('Files ({n})', { n: l.file_count }) },
          { value: 'settings', label: t('Settings') },
        ]}
      />

      {tab === 'vars' && (
        <div className="tab-body">
          <div className="field-help lead">
            {tx('Write a token such as <code>{token}</code> anywhere in the landing’s files: every token found there is a variable. A variable takes its value from the stream, else from the preset the stream shows, else from the default below. Values may contain macros.', {
              code: (c) => <code>{c}</code>,
              token: prefix + 'TITLE',
            })}
          </div>
          {vars.length === 0 && <div className="muted pad-s">{t('No variables yet.')}</div>}
          {vars.length > 0 && (
            <div className="table-wrap">
              <table className="table lvar-table">
                <thead>
                  <tr>
                    <th>{t('Token')}</th>
                    <th>{t('Label')}</th>
                    <th>{t('Kind@@variable')}</th>
                    <th>{t('Default')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {vars.map((v, i) => (
                    <tr key={v.name}>
                      <td>
                        <code>{prefix + v.name}</code>
                        {!v.used && (
                          <div>
                            <Badge tone="neutral" title={t('The token is not in the files. That is normal for a value PHP reads from $_SERVER; otherwise the variable can be removed.')}>
                              {t('not in files')}
                            </Badge>
                          </div>
                        )}
                      </td>
                      <td>
                        <input className="input input-sm" value={v.label} placeholder={t('What it is for')} onChange={(e) => setVar(i, { label: e.target.value })} />
                      </td>
                      <td title={VAR_KIND_HELP[v.kind]}>
                        <Select className="input-sm" value={v.kind} onChange={(kind) => setVar(i, { kind })} options={kinds.map((k) => ({ value: k, label: varKindLabel(k) }))} />
                      </td>
                      <td>
                        <input
                          className={'input input-sm mono' + (v.kind === 'server' ? ' masked' : '')}
                          spellCheck={false}
                          autoComplete="off"
                          value={v.default}
                          placeholder={t('empty')}
                          onFocus={(e) => e.currentTarget.classList.remove('masked')}
                          onBlur={(e) => v.kind === 'server' && e.currentTarget.classList.add('masked')}
                          onChange={(e) => setVar(i, { default: e.target.value })}
                        />
                      </td>
                      <td>
                        <button className="icon-btn danger" disabled={v.used} title={v.used ? t('The token is in the files: remove it there first') : t('Remove variable')} onClick={() => setVars(vars.filter((_, j) => j !== i))}>
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row gap-s lvar-add">
            <input
              className="input input-sm mono"
              style={{ maxWidth: 260 }}
              value={newVar}
              placeholder={t('NAME of a variable PHP reads')}
              onChange={(e) => setNewVar(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addVar()}
            />
            <button className="btn small" disabled={!newVar.trim()} onClick={addVar}>
              <Plus size={14} /> {t('Add variable')}
            </button>
          </div>
          <div className="section-head">
            <h4>{t('Kinds of variables')}</h4>
          </div>
          <dl className="kinds">
            {kinds.map((k) => (
              <div key={k}>
                <dt>{varKindLabel(k)}</dt>
                <dd>{VAR_KIND_HELP[k]}</dd>
              </div>
            ))}
          </dl>
          <div className="field-help">
            {tx('In PHP every variable, whatever its kind, is also in <code>$_SERVER[\'{token}\']</code> with its value unescaped. PHP source is not rewritten before it runs: a token in a string literal reaches the script as written, and is replaced only in what the script prints.', {
              code: (c) => <code>{c}</code>,
              token: prefix + 'NAME',
            })}
          </div>
        </div>
      )}

      {tab === 'presets' && (
        <div className="tab-body">
          <div className="field-help lead">{t('A preset is a named set of values: production and staging settings, or the variants of an A/B test. A stream shows the landing with one preset, or splits its visitors between several.')}</div>
          <div className="row gap-s wrap">
            <Select className="grow" value={presetId ? String(presetId) : ''} placeholder={t('No presets yet')} onChange={(v) => setPresetId(Number(v))} options={presets.map((p) => ({ value: String(p.id), label: p.name }))} />
            <button className="btn" onClick={() => addPreset()}>
              <Plus size={14} /> {t('New preset')}
            </button>
            <button className="btn" disabled={!preset} onClick={() => preset && addPreset(preset)}>
              <Copy size={14} /> {t('Duplicate')}
            </button>
            <button className="btn danger-outline" disabled={!preset} onClick={removePreset}>
              <Trash2 size={14} /> {t('Delete')}
            </button>
          </div>
          {preset && (
            <>
              <div className="form-grid">
                <Field label={t('Preset name')}>
                  <input className="input" value={preset.name} onChange={(e) => setPreset({ name: e.target.value })} />
                </Field>
                <Field
                  label={t('Funnel stages from campaign')}
                  help={t('Choose a campaign to insert its browser stages as event macros, and to resolve them in the preview. A stream can show this landing only if its own campaign has every stage the values report; saving the stream checks that.')}
                >
                  <Select
                    value={campaignId ? String(campaignId) : ''}
                    placeholder={t('No campaign')}
                    onChange={(v) => setCampaignId(Number(v) || 0)}
                    options={(camps.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
                  />
                </Field>
              </div>
              <VarValues
                prefix={prefix}
                vars={vars}
                values={preset.values ?? {}}
                onChange={(values) => setPreset({ values })}
                placeholder={(n) => {
                  const v = vars.find((x) => x.name === n)
                  return !v?.default ? t('empty (the default)') : v.kind === 'server' ? t('the default') : t('default: {value}', { value: v.default })
                }}
                macros={meta.macros}
                stages={campaign?.stages ?? []}
                offer
              />
            </>
          )}
        </div>
      )}

      {tab === 'files' && <FilesTab landing={l} files={files} prefix={prefix} onChanged={adopt} />}

      {tab === 'settings' && (
        <div className="tab-body">
          <div className="form-grid">
            <Field label={t('Name')}>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={t('Entry file')} help={t('The file served on the campaign URL.')}>
              <Select value={entry} onChange={setEntry} options={entryFiles.map((f) => ({ value: f.name, label: `${f.name} (${fmtBytes(f.size)})` }))} />
            </Field>
            <Field label={t('Note')} className="span-2">
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <Field className="span-2" help={BASE_HELP}>
              <Toggle checked={injectBase} onChange={setInjectBase} label={t('Inject <base> tag')} />
            </Field>
          </div>
          <div className="field-help">
            {t('Other pages and scripts of the landing get the same values as the first page through a cookie set with it, for seven days. Opened without that cookie, a page shows the defaults and reports no events. The JS and PHP integrations deliver the first page only.')}
          </div>
        </div>
      )}
    </Modal>
  )
}

function FilesTab({ landing, files, prefix, onChanged }: { landing: Landing; files: Loaded<WPFile[]>; prefix: string; onChanged: (l: Landing) => void }) {
  const [path, setPath] = useState(landing.entry)
  const [content, setContent] = useState<string | null>(null)
  const [saved, setSaved] = useState('')
  const [error, setError] = useState('')
  const [newName, setNewName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, run] = useBusy()
  const templated = new Set(landing.templated ?? [])

  const open = async (name: string, fresh = false) => {
    if (content !== null && content !== saved && !(await confirmDialog({ title: t('Discard unsaved changes?'), confirmLabel: t('Discard'), message: t('The changes you made to {name} have not been saved.', { name: path }) }))) return
    setError('')
    setPath(name)
    if (fresh) {
      setContent('')
      setSaved('\u0000') // differs from any content: a new file is unsaved until written
      return
    }
    setContent(null)
    try {
      const r = await get<{ content: string }>(`landings/${landing.id}/file`, { path: name })
      setContent(r.content)
      setSaved(r.content)
    } catch (e) {
      setError(errMsg(e))
    }
  }
  // The entry page is what people come here to edit.
  useLoad(async () => {
    if (TEXT_FILE.test(landing.entry)) await open(landing.entry)
  }, [landing.id])

  const saveFile = () =>
    run(async () => {
      if (content === null) return
      setError('')
      try {
        const n = await put<Landing>(`landings/${landing.id}/file?path=${encodeURIComponent(path)}`, { content })
        setSaved(content)
        onChanged(n)
        await files.reload()
        toast.ok(t('{name} saved', { name: path }))
      } catch (e) {
        setError(errMsg(e))
      }
    })
  const create = () => {
    const n = newName.trim().replace(/^\/+/, '')
    if (!TEXT_FILE.test(n)) return setError(t('Only text files can be created here: html, php, js, css, json, svg, xml, txt.'))
    setNewName('')
    open(n, !(files.data ?? []).some((f) => f.name === n))
  }
  const replace = () =>
    run(async () => {
      if (!file) return
      if (!(await confirmDialog({ title: t('Replace all files?'), danger: true, confirmLabel: t('Replace'), message: tx('Every file of <b>{name}</b> is replaced by the contents of <b>{file}</b>. Streams showing this landing switch to the new version immediately; variables and presets are kept.', { b: (c) => <b>{c}</b>, name: landing.name, file: file.name }) }))) return
      setError('')
      const fd = new FormData()
      fd.append('file', file)
      try {
        const n = await upload<Landing>(`landings/${landing.id}/upload`, fd)
        onChanged(n)
        setFile(null)
        setContent(null)
        setSaved('')
        setPath(n.entry)
        await files.reload()
        toast.ok(tn(n.file_count, 'Files replaced: {n} file, entry {entry}', 'Files replaced: {n} files, entry {entry}', { entry: n.entry }))
      } catch (e) {
        setError(errMsg(e))
      }
    })

  const unsaved = content !== null && content !== saved
  return (
    <div className="tab-body">
      <ErrorBox error={files.error} />
      <div className="lfiles">
        <div className="lfiles-list">
          <div className="filelist mono">
            {(files.data ?? []).slice(0, 500).map((f) =>
              TEXT_FILE.test(f.name) ? (
                <button key={f.name} type="button" className={f.name === path ? 'entry' : ''} onClick={() => open(f.name)} title={templated.has(f.name) ? t('Carries variables: rendered for each visitor') : undefined}>
                  <span className="grow ellipsis">{f.name}</span>
                  <span className="muted">{fmtBytes(f.size)}</span>
                </button>
              ) : (
                <div key={f.name} className="muted">
                  <span className="grow ellipsis">{f.name}</span>
                  <span>{fmtBytes(f.size)}</span>
                </div>
              ),
            )}
            {files.data && files.data.length > 500 && <div className="muted">{t('… and {n} more', { n: files.data.length - 500 })}</div>}
            {files.data && files.data.length === 0 && <div className="muted">{t('No files on disk.')}</div>}
          </div>
          <div className="row gap-s">
            <input className="input input-sm mono grow" value={newName} placeholder={t('new-file.html')} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
            <button className="btn small" disabled={!newName.trim()} onClick={create} title={t('Create a file')}>
              <FilePlus2 size={14} />
            </button>
          </div>
        </div>
        <div className="lfiles-editor">
          <div className="row gap-s">
            <code className="grow ellipsis">{path}</code>
            {unsaved && <span className="muted small">{t('Unsaved changes')}</span>}
            <button className="btn small primary" disabled={busy || !unsaved} onClick={saveFile}>
              <Save size={14} /> {t('Save file')}
            </button>
          </div>
          {error && <div className="field-error">{error}</div>}
          {content !== null ? (
            <CodeEditor key={path} value={content} onChange={setContent} language={languageOfFile(path)} varPrefix={prefix} minHeight={340} maxHeight={520} ariaLabel={path} />
          ) : (
            !error && <div className="muted pad-s">{TEXT_FILE.test(path) ? t('Loading…') : t('Choose a text file on the left to edit it.')}</div>
          )}
          <div className="field-help">{t('Saving a file takes effect at once for the streams showing this landing. Images and other binary files are changed by uploading the archive again.')}</div>
        </div>
      </div>

      <div className="section-head">
        <h4>{t('Replace files')}</h4>
        <span className="muted grow">{t('Upload a new .zip / .html / .php; the landing keeps its id, variables and presets, so streams need no changes.')}</span>
      </div>
      <FileInput file={file} onChange={setFile} />
      {file && (
        <div className="form-actions">
          <button className="btn" disabled={busy} onClick={replace}>
            <Upload size={14} /> {t('Replace files with {name}', { name: file.name })}
          </button>
        </div>
      )}
    </div>
  )
}
