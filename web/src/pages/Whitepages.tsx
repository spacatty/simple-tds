import { useRef, useState } from 'react'
import { ExternalLink, Eye, Pencil, Trash2, Upload } from 'lucide-react'
import { del, errMsg, get, put, upload } from '../api'
import { useLoad } from '../hooks'
import type { SystemInfo, WPFile, Whitepage } from '../types'
import { DataTable } from '../components/DataTable'
import type { Column } from '../components/DataTable'
import { Badge, Empty, ErrorBox, Field, Modal, Notice, PageHeader, Select, Toggle, confirmDialog, toast, useBusy } from '../components/ui'
import { fmtBytes, fmtDateTime, fmtInt } from '../format'

const BASE_HELP =
  'Inserts <base href="…"> into the page so that relative links to images, styles and scripts keep working when the whitepage is shown on a campaign URL such as /alias. Turn it off only if the page already uses absolute URLs or sets its own <base>.'

async function previewURL(id: number): Promise<string> {
  const r = await get<{ url: string }>(`whitepages/${id}/preview-url`)
  return r.url
}

export default function Whitepages() {
  const list = useLoad(() => get<Whitepage[]>('whitepages'), [])
  const sys = useLoad(() => get<SystemInfo>('system'), [])
  const [uploading, setUploading] = useState(false)
  const [editing, setEditing] = useState<Whitepage | null>(null)
  const [preview, setPreview] = useState<{ wp: Whitepage; url: string } | null>(null)

  const openPreview = async (w: Whitepage) => {
    try {
      setPreview({ wp: w, url: await previewURL(w.id) })
    } catch (e) {
      toast.err(e)
    }
  }
  const remove = async (w: Whitepage) => {
    if (!(await confirmDialog({ title: 'Delete whitepage?', message: <><b>{w.name}</b> and its {w.file_count} files will be deleted from the server.</> }))) return
    try {
      await del(`whitepages/${w.id}`)
      toast.ok('Whitepage deleted')
      list.reload()
    } catch (e) {
      toast.err(e)
    }
  }

  const phpOff = sys.data ? !sys.data.php_enabled : false
  const hasPHP = (list.data ?? []).some((w) => w.kind === 'php')

  const columns: Column<Whitepage>[] = [
    {
      key: 'name',
      title: 'Name',
      sort: (w) => w.name.toLowerCase(),
      render: (w) => (
        <div>
          <button className="link strong" onClick={() => setEditing(w)}>
            {w.name}
          </button>
          {w.note && <div className="muted small">{w.note}</div>}
        </div>
      ),
    },
    {
      key: 'kind',
      title: 'Kind',
      sort: (w) => w.kind,
      render: (w) => (
        <Badge tone={w.kind === 'php' ? (phpOff ? 'warn' : 'accent') : 'neutral'} title={w.kind === 'php' && phpOff ? 'PHP is not configured on this server: this page will not execute' : undefined}>
          {w.kind.toUpperCase()}
        </Badge>
      ),
    },
    { key: 'entry', title: 'Entry file', render: (w) => <code>{w.entry}</code> },
    { key: 'files', title: 'Files', align: 'right', sort: (w) => w.file_count, render: (w) => fmtInt(w.file_count) },
    { key: 'size', title: 'Size', align: 'right', sort: (w) => w.size, render: (w) => fmtBytes(w.size) },
    { key: 'base', title: '<base>', headTitle: 'Inject <base> so relative assets resolve', render: (w) => (w.inject_base ? 'on' : <span className="muted">off</span>) },
    { key: 'created', title: 'Uploaded', sort: (w) => w.created_at, render: (w) => fmtDateTime(w.created_at, false) },
    {
      key: 'actions',
      title: '',
      align: 'right',
      width: 120,
      render: (w) => (
        <div className="row-actions">
          <button className="icon-btn" title="Preview" onClick={() => openPreview(w)}>
            <Eye size={15} />
          </button>
          <button className="icon-btn" title="Edit / replace files" onClick={() => setEditing(w)}>
            <Pencil size={15} />
          </button>
          <button className="icon-btn danger" title="Delete" onClick={() => remove(w)}>
            <Trash2 size={15} />
          </button>
        </div>
      ),
    },
  ]

  return (
    <div className="page">
      <PageHeader title="Whitepages" sub="Safe pages served by the “Whitepage” stream action, typically to bots and moderators.">
        <button className="btn primary" onClick={() => setUploading(true)}>
          <Upload size={15} /> Upload whitepage
        </button>
      </PageHeader>
      {phpOff && (
        <Notice tone="warn" title="PHP is not enabled on this server">
          PHP whitepages will not execute{hasPHP ? ' — the PHP pages listed below are affected' : ''}. Start the bundled PHP-FPM service (or configure its address) to run them; HTML whitepages work as usual.
        </Notice>
      )}
      <ErrorBox error={list.error} retry={list.reload} />
      <div className="card">
        <DataTable
          columns={columns}
          rows={list.data}
          rowKey={(w) => w.id}
          loading={list.loading}
          empty={
            <Empty title="No whitepages yet" action={<button className="btn primary" onClick={() => setUploading(true)}><Upload size={15} /> Upload the first one</button>}>
              Upload a .zip with a whole site, or a single .html / .php file.
            </Empty>
          }
        />
      </div>

      {uploading && (
        <UploadModal
          onClose={() => setUploading(false)}
          onDone={() => {
            setUploading(false)
            list.reload()
          }}
        />
      )}
      {editing && (
        <EditModal
          wp={editing}
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
              Preview: {preview.wp.name}{' '}
              <a href={preview.url} target="_blank" rel="noreferrer noopener" className="small">
                <ExternalLink size={13} /> open in a new tab
              </a>
            </>
          }
          onClose={() => setPreview(null)}
        >
          <iframe className="preview-frame" title="Whitepage preview" src={preview.url} sandbox="allow-scripts allow-forms allow-popups" />
          <div className="field-help">The preview is sandboxed and the link expires in two hours. Macros and visitor data are empty in preview.</div>
        </Modal>
      )}
    </div>
  )
}

function FileInput({ file, onChange }: { file: File | null; onChange: (f: File | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  return (
    <div
      className={'dropzone' + (drag ? ' drag' : '')}
      onClick={() => ref.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDrag(false)
        if (e.dataTransfer.files[0]) onChange(e.dataTransfer.files[0])
      }}
    >
      <input ref={ref} type="file" hidden accept=".zip,.html,.htm,.php" onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
      <Upload size={20} />
      {file ? (
        <div>
          <b>{file.name}</b> <span className="muted">{fmtBytes(file.size)}</span>
        </div>
      ) : (
        <div>
          <b>Choose a file</b> or drop it here
          <div className="muted small">.zip archive of a site, or a single .html / .php file (up to 256 MB)</div>
        </div>
      )}
    </div>
  )
}

function UploadModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
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
        const w = await upload<Whitepage>('whitepages', fd)
        toast.ok(`Uploaded “${w.name}”: ${w.file_count} files, entry ${w.entry}`)
        onDone()
      } catch (e) {
        setError(errMsg(e))
      }
    })
  return (
    <Modal
      title="Upload whitepage"
      onClose={onClose}
      footer={
        <>
          {error && <div className="field-error grow">{error}</div>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !file} onClick={submit}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </>
      }
    >
      <FileInput file={file} onChange={setFile} />
      <Field label="Name" help="Defaults to the file name.">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={file ? file.name.replace(/\.zip$/i, '') : ''} />
      </Field>
      <Field label="Note">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Field help={BASE_HELP}>
        <Toggle checked={injectBase} onChange={setInjectBase} label="Inject <base> tag" />
      </Field>
    </Modal>
  )
}

function EditModal({ wp: initial, phpOff, onClose, onPreview }: { wp: Whitepage; phpOff: boolean; onClose: () => void; onPreview: (w: Whitepage) => void }) {
  const [wp, setWp] = useState(initial)
  const [name, setName] = useState(initial.name)
  const [note, setNote] = useState(initial.note)
  const [entry, setEntry] = useState(initial.entry)
  const [injectBase, setInjectBase] = useState(initial.inject_base)
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [busy, run] = useBusy()
  const files = useLoad(() => get<WPFile[]>(`whitepages/${initial.id}/files`), [initial.id])

  const entryFiles = (files.data ?? []).filter((f) => /\.(html?|php)$/i.test(f.name))
  const save = () =>
    run(async () => {
      setError('')
      try {
        const n = await put<Whitepage>(`whitepages/${wp.id}`, { name, note, entry, inject_base: injectBase })
        setWp(n)
        toast.ok('Whitepage saved')
        onClose()
      } catch (e) {
        setError(errMsg(e))
      }
    })
  const replace = () =>
    run(async () => {
      if (!file) return
      if (!(await confirmDialog({ title: 'Replace all files?', danger: true, confirmLabel: 'Replace', message: <>Every file of <b>{wp.name}</b> is replaced by the contents of <b>{file.name}</b>. Streams using this whitepage switch to the new version immediately.</> }))) return
      setError('')
      const fd = new FormData()
      fd.append('file', file)
      try {
        const n = await upload<Whitepage>(`whitepages/${wp.id}/upload`, fd)
        setWp(n)
        setEntry(n.entry)
        setFile(null)
        await files.reload()
        toast.ok(`Files replaced: ${n.file_count} files, entry ${n.entry}`)
      } catch (e) {
        setError(errMsg(e))
      }
    })

  return (
    <Modal
      title={`Whitepage: ${wp.name}`}
      size="lg"
      onClose={onClose}
      footer={
        <>
          {error && <div className="field-error grow">{error}</div>}
          <button className="btn" onClick={() => onPreview(wp)}>
            <Eye size={14} /> Preview
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={save}>
            Save
          </button>
        </>
      }
    >
      {wp.kind === 'php' && phpOff && <Notice tone="warn">PHP is not enabled on this server, so this page will not execute.</Notice>}
      <div className="form-grid">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Entry file" help="The file served on the campaign URL.">
          <Select value={entry} onChange={setEntry} options={entryFiles.map((f) => ({ value: f.name, label: `${f.name} (${fmtBytes(f.size)})` }))} />
        </Field>
        <Field label="Note" className="span-2">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Field className="span-2" help={BASE_HELP}>
          <Toggle checked={injectBase} onChange={setInjectBase} label="Inject <base> tag" />
        </Field>
      </div>

      <div className="section-head">
        <h4>Files</h4>
        <span className="muted grow">
          {fmtInt(wp.file_count)} files · {fmtBytes(wp.size)} · {wp.kind.toUpperCase()}
        </span>
      </div>
      <ErrorBox error={files.error} />
      <div className="filelist mono">
        {(files.data ?? []).slice(0, 500).map((f) => (
          <div key={f.name} className={f.name === entry ? 'entry' : ''}>
            <span className="grow ellipsis">{f.name}</span>
            <span className="muted">{fmtBytes(f.size)}</span>
          </div>
        ))}
        {files.data && files.data.length > 500 && <div className="muted">… and {files.data.length - 500} more</div>}
        {files.data && files.data.length === 0 && <div className="muted">No files on disk.</div>}
      </div>

      <div className="section-head">
        <h4>Replace files</h4>
        <span className="muted grow">Upload a new .zip / .html / .php; the whitepage keeps its id, so streams need no changes.</span>
      </div>
      <FileInput file={file} onChange={setFile} />
      {file && (
        <div className="form-actions">
          <button className="btn" disabled={busy} onClick={replace}>
            <Upload size={14} /> Replace files with {file.name}
          </button>
        </div>
      )}
    </Modal>
  )
}
