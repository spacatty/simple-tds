import { LANGS, lang, setLang, t } from '../i18n'
import { Flag } from './icons'

/**
 * Shows the current language as a flag; a click switches to the next language
 * and reloads the panel. Passing `label` makes it a sidebar footer button, with
 * the language name next to the flag when it is true.
 */
export function LangSwitch({ className, tip, label }: { className?: string; tip?: boolean; label?: boolean }) {
  const i = Math.max(0, LANGS.findIndex((l) => l.code === lang))
  const current = LANGS[i]
  const next = LANGS[(i + 1) % LANGS.length]
  // The sidebar draws its own tooltips from data-tip; elsewhere the browser's will do.
  const hint = tip ? { 'data-tip': next.name } : { title: next.name }
  return (
    <button type="button" className={(label === undefined ? 'icon-btn' : 'foot-btn') + ' lang-btn' + (className ? ' ' + className : '')} onClick={() => setLang(next.code)} aria-label={t('Switch language')} {...hint}>
      <Flag code={current.flag} />
      {label && <span className="ellipsis">{current.name}</span>}
    </button>
  )
}
