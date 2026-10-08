// Keeps src/i18n/ru.json in step with the sources. Run by `npm run i18n` and
// as the first step of `npm run build`:
//
//   - every t('…'), tn(n, '…', '…') and tx('…') key must have a translation;
//   - a translation nobody uses any more must be removed;
//   - placeholders and <tags> must survive translation;
//   - English text written straight into JSX (not through t) is reported.
//
// `node scripts/i18n-check.mjs --fix` removes unused keys and adds missing ones
// with an empty value, which the check then reports until they are filled in.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src')
const dictPath = join(src, 'i18n', 'ru.json')
const fix = process.argv.includes('--fix')

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'i18n' ? [] : walk(p)
    return /\.tsx?$/.test(name) ? [p] : []
  })
}

const STR = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|` + '`(?:[^`\\\\]|\\\\.)*`'
const CALL = new RegExp(String.raw`(?<![\w.$])(t|tx|tn)\(\s*(?:(${STR})|([^)]))`, 'g')
const TN = new RegExp(String.raw`^[^,]+,\s*(${STR})\s*,\s*(${STR})`)

/** Value of a string literal, or null when it is a template with ${…}. */
function literal(lit) {
  if (lit[0] === '`' && lit.includes('${')) return null
  // eslint-disable-next-line no-new-func
  return new Function('return ' + lit)()
}

const used = new Map() // key → first place it is used
const plural = new Set()
const problems = []
const at = (file, text, index) => `${relative(root, file).replace(/\\/g, '/')}:${text.slice(0, index).split('\n').length}`

for (const file of walk(src)) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(CALL)) {
    const where = at(file, text, m.index)
    const fn = m[1]
    if (fn === 'tn') {
      const args = TN.exec(text.slice(m.index + m[0].length - 1))
      const one = args && literal(args[1])
      const other = args && literal(args[2])
      if (!one || !other) {
        problems.push(`${where}: tn() needs two string literals`)
        continue
      }
      plural.add(other)
      if (!used.has(other)) used.set(other, where)
      continue
    }
    const key = m[2] ? literal(m[2]) : null
    if (key === null) {
      // A lone t(x) inside a non-i18n scope (a local variable called t) is not ours to judge.
      if (m[3] !== undefined && !/import[^\n]*\bt\b[^\n]*from '[./]+i18n'/.test(text)) continue
      problems.push(`${where}: ${fn}() needs a string literal — use ts() for text that is not known in advance`)
      continue
    }
    if (!used.has(key)) used.set(key, where)
  }

  // English written straight into the markup.
  if (!file.endsWith('.tsx')) continue
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (line.includes('i18n-ignore') || (i > 0 && lines[i - 1].includes('i18n-ignore'))) return
    const found = []
    // title="Text", placeholder="Text"…
    for (const a of line.matchAll(/\b(title|placeholder|label|help|hint|aria-label|data-tip|alt|confirm|empty|text|message|description|tooltip)="([^"]*)"/g)) found.push(a[2])
    // Text inside string literals has already been through t(); what is left is markup.
    const bare = line.replace(new RegExp(STR, 'g'), "''")
    // >Text< — but not the inside of generics, arrows and comparisons.
    for (const a of bare.matchAll(/(?<![=)])>([^<>{}]+)<(?=[/a-zA-Z])/g)) {
      if (!/[=;|&[\]]|\?\.|\? |^\s*[,:(.]|\b(Promise|new|void)\b/.test(a[1])) found.push(a[1])
    }
    // a line that is nothing but text
    const alone = /^\s*([A-Z][^<>{}=;()`]*[a-z.!?…:,])\s*$/.exec(bare)
    if (alone && !/^\s*(\/\/|\*|\/\*)/.test(line) && !/^(case|default|return)\b/.test(alone[1].trim()) && !/['"|&?]|\b(as|extends|keyof|typeof)\b/.test(alone[1])) found.push(alone[1])
    for (const s of found) {
      // Words, not identifiers or abbreviations: two lowercase letters in a row.
      if (!/[A-Za-z][a-z]{2,}/.test(s)) continue
      if (/:\/\/|@|=/.test(s)) continue // a sample URL, address or query string
      if (/^\s*[\w.-]+\s*$/.test(s) && !/^[A-Z][a-z]+$/.test(s.trim())) continue // a code-like token
      problems.push(`${relative(root, file).replace(/\\/g, '/')}:${i + 1}: untranslated text "${s.trim()}" — wrap it in t(), or mark the line with i18n-ignore`)
    }
  })
}

const dict = JSON.parse(readFileSync(dictPath, 'utf8'))
const marks = (s) => [...s.matchAll(/\{\w+\}|<\/?\w+>/g)].map((m) => m[0]).sort().join(' ')

for (const [key, where] of used) {
  const v = dict[key]
  const src0 = key.split('@@')[0]
  if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) {
    problems.push(`${where}: no Russian translation for ${JSON.stringify(key)}`)
    if (fix && v === undefined) dict[key] = plural.has(key) ? [] : ''
    continue
  }
  if (plural.has(key)) {
    if (!Array.isArray(v) || v.length !== 3) problems.push(`ru.json: ${JSON.stringify(key)} is a plural and needs three forms (1, 2–4, 5+)`)
  } else if (typeof v !== 'string') {
    problems.push(`ru.json: ${JSON.stringify(key)} must be a string`)
  }
  for (const form of [v].flat()) {
    if (typeof form === 'string' && marks(form) !== marks(src0)) problems.push(`ru.json: placeholders or tags differ in ${JSON.stringify(key)} → ${JSON.stringify(form)}`)
  }
}
for (const key of Object.keys(dict)) {
  if (used.has(key)) continue
  if (fix) delete dict[key]
  else problems.push(`ru.json: ${JSON.stringify(key)} is not used anywhere — remove it`)
}

if (fix) {
  const sorted = Object.fromEntries(Object.entries(dict).sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase(), 'en') || (a < b ? -1 : 1)))
  writeFileSync(dictPath, JSON.stringify(sorted, null, 2) + '\n')
}

if (problems.length) {
  console.error(problems.join('\n'))
  console.error(`\ni18n: ${problems.length} problem(s). See "Translations" in AGENTS.md.`)
  process.exit(1)
}
console.log(`i18n: ${used.size} texts, all translated`)
