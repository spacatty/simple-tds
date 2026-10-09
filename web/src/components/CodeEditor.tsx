import { Suspense, lazy } from 'react'

export interface CodeEditorHandle {
  /** Puts text at the cursor, replacing the selection, and focuses the editor. */
  insert: (text: string) => void
}

export interface CodeEditorProps {
  value: string
  onChange: (v: string) => void
  /** html | javascript | json; anything else is plain text. */
  language?: string
  readOnly?: boolean
  /** Macro names (without braces) to highlight and complete. */
  macros?: string[]
  /** Highlight tokens that start with this prefix: the variables of a landing. */
  varPrefix?: string
  minHeight?: number
  maxHeight?: number
  invalid?: boolean
  onFocus?: () => void
  handle?: { current: CodeEditorHandle | null }
  ariaLabel?: string
}

// The editor is a few hundred kilobytes: it is fetched when a code field is first shown.
const Impl = lazy(() => import('./CodeMirror'))

/** Code field with syntax highlighting, line numbers, search and macro completion. */
export function CodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={<div className="code-editor loading" style={{ minHeight: props.minHeight ?? 220 }} />}>
      <Impl {...props} />
    </Suspense>
  )
}

/** The editor language for a response content type. */
export function languageOf(contentType: unknown): string {
  const ct = String(contentType ?? '')
  return ct.includes('html') ? 'html' : ct.includes('javascript') ? 'javascript' : ct.includes('json') ? 'json' : 'text'
}
