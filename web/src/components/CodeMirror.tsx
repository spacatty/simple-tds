import { useEffect, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { Decoration, MatchDecorator, ViewPlugin, keymap } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { completionStatus } from '@codemirror/autocomplete'
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { searchPanelOpen } from '@codemirror/search'
import { tags as tg } from '@lezer/highlight'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import type { CodeEditorProps } from './CodeEditor'
import { t } from '../i18n'

// Every colour is a design token from styles.css, so the editor follows the
// panel theme without being rebuilt when it is switched.
const chrome = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--code-bg)', fontSize: '12.5px', height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--text)', padding: '8px 0' },
  '.cm-line': { padding: '0 12px 0 6px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--text-3)', border: 'none', paddingLeft: '4px' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '28px', padding: '0 6px 0 4px' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--text-3)', cursor: 'pointer' },
  '.cm-activeLine': { backgroundColor: 'var(--code-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--code-line)', color: 'var(--text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--code-sel)' },
  '.cm-content ::selection': { backgroundColor: 'var(--code-sel)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--code-match)' },
  '.cm-searchMatch': { backgroundColor: 'var(--code-find)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--code-find-current)' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--code-match)', outline: '1px solid var(--border-strong)' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--err-soft)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-3)', border: 'none', color: 'var(--text-3)', padding: '0 5px', margin: '0 2px' },
  '.cm-macro': { color: 'var(--code-macro)', backgroundColor: 'var(--accent-soft)', borderRadius: '3px' },
  '.cm-macro *': { color: 'inherit' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '6px', boxShadow: 'var(--shadow-lg)', overflow: 'hidden' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--mono)', fontSize: '12px', maxHeight: '220px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px', lineHeight: '1.5' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text)' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--accent-text)', fontWeight: '600' },
  '.cm-completionDetail': { color: 'var(--text-3)', fontStyle: 'normal', fontFamily: 'var(--sans)' },
  '.cm-completionIcon': { opacity: '0.7' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--text)', fontFamily: 'var(--sans)', fontSize: '12px' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '6px 28px 6px 8px' },
  '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '12px', color: 'var(--text-2)' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--text-3)', fontSize: '18px', top: '4px', right: '6px', cursor: 'pointer' },
  '.cm-textfield': { backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: '5px', padding: '3px 6px', fontSize: '12px' },
  '.cm-textfield:focus': { outline: 'none', borderColor: 'var(--accent)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: '5px', padding: '3px 8px', fontSize: '12px', cursor: 'pointer' },
  '.cm-button:hover': { backgroundColor: 'var(--surface-3)' },
  '.cm-button:active': { backgroundImage: 'none', backgroundColor: 'var(--surface-3)' },
})

const syntax = HighlightStyle.define([
  { tag: [tg.comment, tg.docComment], color: 'var(--code-comment)' },
  { tag: [tg.keyword, tg.modifier, tg.operatorKeyword, tg.definitionKeyword, tg.atom, tg.bool, tg.null, tg.self], color: 'var(--code-keyword)' },
  { tag: [tg.controlKeyword, tg.moduleKeyword], color: 'var(--code-control)' },
  { tag: [tg.string, tg.special(tg.string), tg.attributeValue], color: 'var(--code-string)' },
  { tag: [tg.regexp, tg.escape], color: 'var(--code-regexp)' },
  { tag: [tg.number, tg.integer, tg.float], color: 'var(--code-number)' },
  { tag: [tg.function(tg.variableName), tg.function(tg.propertyName), tg.function(tg.definition(tg.variableName))], color: 'var(--code-function)' },
  { tag: [tg.variableName, tg.propertyName, tg.attributeName, tg.labelName], color: 'var(--code-variable)' },
  { tag: [tg.typeName, tg.className, tg.namespace], color: 'var(--code-type)' },
  { tag: [tg.tagName, tg.documentMeta], color: 'var(--code-tag)' },
  { tag: [tg.angleBracket, tg.processingInstruction], color: 'var(--code-punct)' },
  { tag: tg.invalid, color: 'var(--err)' },
])

const LANGS: Record<string, () => Extension> = {
  html: () => html(),
  javascript: () => javascript(),
  json: () => json(),
}

// The search panel is the only built-in piece with text of its own.
const phrases = EditorState.phrases.of({
  Find: t('Find'),
  Replace: t('Replace@@search'),
  next: t('next@@search'),
  previous: t('previous@@search'),
  all: t('all@@search'),
  'match case': t('match case'),
  regexp: t('regexp'),
  'by word': t('by word'),
  replace: t('replace@@search'),
  'replace all': t('replace all'),
  close: t('close@@search'),
})

const MACRO = /\{(?:[a-z_][a-z0-9_]*|(?:param|event):[\w-]+)\}/g

/** Known {macros} stand out from the code around them. */
function macroMarks(known: () => string[]) {
  const mark = Decoration.mark({ class: 'cm-macro' })
  const matcher = new MatchDecorator({
    regexp: MACRO,
    decoration: (m) => {
      const name = m[0].slice(1, -1)
      return name.includes(':') || known().includes(name) ? mark : null
    },
  })
  return ViewPlugin.fromClass(
    class {
      marks: DecorationSet
      constructor(view: EditorView) {
        this.marks = matcher.createDeco(view)
      }
      update(u: ViewUpdate) {
        this.marks = matcher.updateDeco(u, this.marks)
      }
    },
    { decorations: (p) => p.marks },
  )
}

/** Landing variable tokens stand out too. */
function varMarks(prefix: string) {
  const mark = Decoration.mark({ class: 'cm-macro' })
  // The prefix is letters and underscores: nothing in it to escape.
  const matcher = new MatchDecorator({ regexp: new RegExp(prefix + '[A-Z0-9]+(?:_[A-Z0-9]+)*', 'g'), decoration: () => mark })
  return ViewPlugin.fromClass(
    class {
      marks: DecorationSet
      constructor(view: EditorView) {
        this.marks = matcher.createDeco(view)
      }
      update(u: ViewUpdate) {
        this.marks = matcher.updateDeco(u, this.marks)
      }
    },
    { decorations: (p) => p.marks },
  )
}

/** Typing "{c" offers the macros; a bare "{" does not, it opens too many blocks in real code. */
function macroCompletion(known: () => string[]) {
  const apply = (view: EditorView, c: Completion, from: number, to: number) => {
    // closeBrackets has usually typed the "}" already.
    const end = view.state.sliceDoc(to, to + 1) === '}' ? to + 1 : to
    view.dispatch({ changes: { from, to: end, insert: c.label }, selection: { anchor: from + c.label.length } })
  }
  return (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/\{[a-z_][\w:]*/)
    if (!word) return null
    const options = known().map((m): Completion => ({ label: `{${m}}`, type: 'constant', detail: t('macro'), apply, boost: 1 }))
    return options.length ? { from: word.from, options, validFor: /^\{[\w:]*$/ } : null
  }
}

export default function CodeMirror({ value, onChange, language = 'text', readOnly, macros, varPrefix, minHeight = 220, maxHeight = 520, invalid, onFocus, handle, ariaLabel }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // The latest props, for callbacks created once with the editor.
  const live = useRef({ onChange, onFocus, macros: macros ?? [] })
  live.current = { onChange, onFocus, macros: macros ?? [] }
  const lang = useRef(new Compartment())
  const ro = useRef(new Compartment())

  useEffect(() => {
    const known = () => live.current.macros
    const v = new EditorView({
      parent: host.current as HTMLDivElement,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          EditorState.tabSize.of(2),
          phrases,
          chrome,
          syntaxHighlighting(syntax),
          lang.current.of(LANGS[language]?.() ?? []),
          ro.current.of([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly)]),
          macroMarks(known),
          varPrefix ? varMarks(varPrefix) : [],
          EditorState.languageData.of(() => [{ autocomplete: macroCompletion(known) }]),
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel ?? '', spellcheck: 'false' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) live.current.onChange(u.state.doc.toString())
            if (u.focusChanged && u.view.hasFocus) live.current.onFocus?.()
          }),
          EditorView.domEventHandlers({
            keydown(e, cm) {
              if (e.key !== 'Escape') return false
              // Escape belongs to the editor (it closes the popup or the search panel), not to the drawer around it.
              e.stopPropagation()
              if (completionStatus(cm.state) === null && !searchPanelOpen(cm.state)) cm.contentDOM.blur()
              return false
            },
          }),
        ],
      }),
    })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
    // Created once; later prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
  }, [value])
  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(LANGS[language]?.() ?? []) })
  }, [language])
  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure([EditorState.readOnly.of(!!readOnly), EditorView.editable.of(!readOnly)]) })
  }, [readOnly])

  useEffect(() => {
    if (!handle) return
    handle.current = {
      insert(text) {
        const v = view.current
        if (!v) return
        v.dispatch(v.state.replaceSelection(text), { scrollIntoView: true, userEvent: 'input' })
        v.focus()
      },
    }
    return () => {
      handle.current = null
    }
  }, [handle])

  return <div ref={host} className={'code-editor' + (invalid ? ' invalid' : '') + (readOnly ? ' read-only' : '')} style={{ minHeight, maxHeight }} />
}
