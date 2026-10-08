import { LANGS, lang, setLang, t } from '../i18n'

/** Shows the current language code; a click switches to the next language and reloads the panel. */
export function LangSwitch({ className, tip }: { className?: string; tip?: boolean }) {
  const next = LANGS[(LANGS.findIndex((l) => l.code === lang) + 1) % LANGS.length]
  // The sidebar draws its own tooltips from data-tip; elsewhere the browser's will do.
  const hint = tip ? { 'data-tip': next.name } : { title: next.name }
  return (
    <button type="button" className={'icon-btn lang-btn' + (className ? ' ' + className : '')} onClick={() => setLang(next.code)} aria-label={t('Switch language')} lang={next.code} {...hint}>
      {lang.toUpperCase()}
    </button>
  )
}
