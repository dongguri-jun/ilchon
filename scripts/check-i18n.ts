/**
 * Checks the string tables, the Japanese translation table, the language plumbing
 * and the strings outside the string tables. No network. Run: pnpm check:i18n
 *
 * Numbering is one line, T1 to T20.
 *
 *   T1  Korean and English have the same keys; no empty value (Japanese too)
 *   T2  same placeholders in every language; full-width braces warn
 *   T3  generated ja-strings.ts keys all exist in Korean; no Hangul in Japanese
 *   T4  Japanese missing, waiting for review (warning only)
 *   T5  no backslash in any value (the table writes line breaks as \n)
 *   T6  every key of scripts/i18n-safety.ts exists
 *   T7  가 번역/context.json, 나 ja-strings.ts byte-equal to renderJaFile, 다 번역/ja-status.json
 *   T8  JA_STAGE not 'off': every Japanese safety string has a valid AI cross-check
 *   T9  words to avoid (scripts/i18n-glossary.ts); do-not-translate words kept (warning)
 *   T10 Japanese has kana or kanji (English pasted in fails)
 *   T11 no Hangul outside the string tables (comments excluded)
 *   T12 no `${t(` (text glued together by code)
 *   T13 pickLang
 *   T14 public/boot-splash.js picks the same language as the deploy build
 *   T15 Japanese values: no U+00B7, negation kept (warning only)
 *   T16 full-width digits: amount and fee cleaning and the caret count turn fullwidth digits,
 *       ． and ， into ASCII (not NFKC: ½ ① ² make no digits)
 *   T17 no stored language: no 'ilchon' + ':lang', no localStorage in the language code
 *   T18 no text below 11px in any language: every --fs-* token and literal font size is
 *       11px or more, and no rule asks for a size token that is not defined
 *   T19 camera messages on the connect screen: a dismissed or
 *       refused camera prompt is not "no camera" (qr-scanner hides the NotAllowedError
 *       behind 'Camera not found.'), an unknown permission state with a camera listed says
 *       neither, every reason's string key exists in Korean and English, and every
 *       branch of the scanner's effect returns the cleanup that marks it disposed
 *   T20 no relay word in screen text outside the settings screen:
 *       no 중계 / relay in any ko or en value (Japanese is not scanned) of a namespace other than settings,
 *       except the keys listed in RELAY_WORD_OK (privacy statements and the settings link)
 *
 * --review-gate (run before Japanese leaves beta): every key with Japanese is human-ok.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { Lang } from '../src/contracts'
import { listDictionaries } from '../src/i18n'
import { browserLanguages, pickLang } from '../src/i18n/detect'
import { JA_STAGE, offeredLangs } from '../src/i18n/lang'
import { sanitizeAmount, significantBefore } from '../src/lib/money'
import { sanitizeFee } from '../src/screens/board/format'
import { avatarFontSize } from '../src/ui/avatar-size'
import { cameraReason, LIBRARY_NO_CAMERA, type CameraContext } from '../src/ui/qr/camera-reason'
import { COPY } from '../src/screens/shell/crash-copy'
import { avoidedIn, dntWords } from './i18n-glossary'
import { aiCheckValid, COMPUTED_WHERE, hasFullwidthBrace, HANGUL, KANA_KANJI, loadCatalog, placeholders, readContext, readStatus, renderJaFile, reviewGate, stateOf, t8 } from './i18n/lib'
import { SAFETY_KEYS } from './i18n-safety'
// Every string table, so T15 sees every Japanese value.
import '../src/screens/board/strings'
import '../src/screens/connect/strings'
import '../src/screens/contacts/strings'
import '../src/screens/lock/strings'
import '../src/screens/room/strings'
import '../src/screens/settings/strings'
import '../src/screens/shell/strings'
import '../src/screens/shell/install-strings'
import '../src/ui/strings'

const ROOT = join(import.meta.dirname, '..')

let failed = 0
let warned = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS ${name}`)
  else {
    failed++
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function warn(name: string, detail: string): void {
  warned++
  console.log(`WARN ${name} — ${detail}`)
}

function walk(dir: string, exts: readonly string[]): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p, exts))
    else if (exts.some((e) => name.endsWith(e))) out.push(p)
  }
  return out
}
const rel = (p: string) => relative(ROOT, p).split(sep).join('/')

/**
 * Source text with comments blanked out. Strings and template literals are kept
 * (that is where text lives). Regex literals are not parsed; none in src holds
 * a quote or a comment marker that would confuse this.
 */
export function stripComments(src: string): string {
  let out = ''
  let i = 0
  // Stack of open template literals; each entry is the brace depth inside its current ${ }.
  const tpl: number[] = []
  let inTplText = false
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (inTplText) {
      if (c === '\\') {
        out += c + (n ?? '')
        i += 2
      } else if (c === '`') {
        out += c
        i++
        tpl.pop()
        inTplText = false
      } else if (c === '$' && n === '{') {
        out += '${'
        i += 2
        inTplText = false
        tpl[tpl.length - 1] = 0
      } else {
        out += c
        i++
      }
      continue
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'
        i++
      }
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      out += c
      i++
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') {
          out += src[i]
          i++
        }
        out += src[i] ?? ''
        i++
      }
      out += src[i] ?? ''
      i++
      continue
    }
    if (c === '`') {
      out += c
      i++
      tpl.push(0)
      inTplText = true
      continue
    }
    if (tpl.length > 0 && c === '{') tpl[tpl.length - 1]++
    if (tpl.length > 0 && c === '}') {
      if (tpl[tpl.length - 1] === 0) {
        out += c
        i++
        inTplText = true
        continue
      }
      tpl[tpl.length - 1]--
    }
    out += c
    i++
  }
  return out
}

// ---------------------------------------------------------------- T1 to T10 the string tables and the translation table

const ctx = readContext()
const status = readStatus()
const cat = await loadCatalog(ctx)
const dicts = listDictionaries()
/** Every value with its id, for the checks that look at all three languages. */
const jaEntries = cat.entries.filter((e) => e.ja !== undefined)

{
  // T1 Korean and English always complete.
  const problems: string[] = []
  for (const [ns, d] of dicts) {
    const ko = Object.keys(d.ko)
    const en = Object.keys(d.en)
    const onlyKo = ko.filter((k) => !(k in d.en))
    const onlyEn = en.filter((k) => !(k in d.ko))
    if (onlyKo.length) problems.push(`${ns}: English misses ${onlyKo.join(', ')}`)
    if (onlyEn.length) problems.push(`${ns}: English has extra ${onlyEn.join(', ')}`)
  }
  for (const e of cat.entries) {
    if (!e.ko?.trim()) problems.push(`${e.id}: empty Korean`)
    if (!e.en?.trim()) problems.push(`${e.id}: empty English`)
    if (e.ja !== undefined && !e.ja.trim()) problems.push(`${e.id}: empty Japanese (leave the key out instead)`)
  }
  check(`T1 Korean and English keys match, no empty value (${cat.entries.length} strings)`, problems.length === 0, problems.join('\n  '))
}

{
  // T2 placeholders.
  const problems: string[] = []
  for (const e of cat.entries) {
    const ko = placeholders(e.ko).join(' ')
    if (placeholders(e.en).join(' ') !== ko) problems.push(`${e.id}: en {${placeholders(e.en).join(' ')}} vs ko {${ko}}`)
    if (e.ja !== undefined && placeholders(e.ja).join(' ') !== ko) problems.push(`${e.id}: ja {${placeholders(e.ja).join(' ')}} vs ko {${ko}}`)
    for (const [lang, v] of [
      ['ko', e.ko],
      ['en', e.en],
      ['ja', e.ja],
    ] as const) {
      if (v !== undefined && hasFullwidthBrace(v)) warn(`T2 ${e.id}`, `${lang} has full-width braces ｛｝; placeholders use half-width {name}`)
    }
  }
  check('T2 same placeholders in every language', problems.length === 0, problems.join('\n  '))
}

{
  // T3 typo keys in the generated files, Hangul in Japanese.
  const typos: string[] = []
  for (const info of cat.namespaces) {
    for (const k of Object.keys(info.ja)) if (!info.keys.includes(k)) typos.push(`${info.jaFile}: '${k}' is not a key of ${info.ns}`)
  }
  check('T3 every ja-strings.ts key exists in Korean', typos.length === 0, typos.join('\n  '))
  const hangul = jaEntries.filter((e) => HANGUL.test(e.ja!)).map((e) => `${e.id}: ${e.ja}`)
  check('T3 no Hangul in Japanese values', hangul.length === 0, hangul.join('\n  '))
}

{
  // T4 missing Japanese and the review queue (warnings only).
  const missing = cat.entries.filter((e) => e.ja === undefined)
  const missingSafety = missing.filter((e) => e.safety)
  const waiting = jaEntries.filter((e) => stateOf(e, status[e.id]) !== 'human-ok')
  const needsFix = jaEntries.filter((e) => stateOf(e, status[e.id]) === 'needs-fix')
  // Name every missing key (safety keys marked *), so a key added without Japanese is seen
  // in pnpm check instead of on a device. Still a notice, never a failure.
  const missingList = missing.map((e) => `${e.id}${e.safety ? '*' : ''}`).join(', ')
  if (missing.length) warn('T4 Japanese missing', `${missing.length} of ${cat.entries.length} (safety ${missingSafety.length}, marked *); these show in English: ${missingList}`)
  if (waiting.length) warn('T4 검수 대기', `${waiting.length} (needs-fix ${needsFix.length}${needsFix.length ? `: ${needsFix.map((e) => e.id).join(', ')}` : ''})`)
}

{
  // T5 no backslash anywhere: the table writes a line break as the two characters \n.
  const hits: string[] = []
  for (const e of cat.entries)
    for (const [lang, v] of [
      ['ko', e.ko],
      ['en', e.en],
      ['ja', e.ja],
    ] as const)
      if (v?.includes('\\')) hits.push(`${e.id} (${lang})`)
  check('T5 no backslash in any value', hits.length === 0, hits.join(', '))
}

{
  // T6 every safety key exists.
  const all = Object.values(SAFETY_KEYS).flat()
  const missing = all.filter((k) => !cat.byId.has(k))
  const dup = all.filter((k, i) => all.indexOf(k) !== i)
  check(`T6 every safety key exists (${new Set(all).size} keys)`, missing.length === 0, missing.join(', '))
  check('T6 no safety key listed twice', dup.length === 0, dup.join(', '))
}

{
  // T7 가 번역/context.json.
  const problems: string[] = []
  for (const id of Object.keys(ctx.keys)) {
    const e = cat.byId.get(id)
    if (!e || e.outside) problems.push(`keys.${id}: not a key of the string tables`)
  }
  for (const ns of new Set(cat.entries.map((e) => e.ns))) if (!ctx.screens[ns]) problems.push(`screens.${ns}: missing`)
  const seen = new Set<string>()
  for (const o of ctx.outside) {
    if (!o.key.startsWith('_outside.')) problems.push(`outside ${o.key}: key must start with _outside.`)
    if (seen.has(o.key)) problems.push(`outside ${o.key}: listed twice`)
    seen.add(o.key)
    for (const lang of ['ko', 'en', 'ja'] as const) {
      const v = o[lang]
      if (v === null || v === undefined) continue
      const files = ([] as string[]).concat(o.files?.[lang] ?? [])
      if (!files.length) problems.push(`outside ${o.key}: no ${lang} file`)
      const pieces = v.split(/\{\w+\}/).filter(Boolean)
      for (const f of files) {
        const p = join(ROOT, f)
        let text = ''
        try {
          text = readFileSync(p, 'utf8')
        } catch {
          problems.push(`outside ${o.key}: ${f} does not exist`)
          continue
        }
        const absent = pieces.filter((piece) => !text.includes(piece))
        if (absent.length) problems.push(`outside ${o.key}: ${lang} not in ${f}: ${absent.map((a) => JSON.stringify(a)).join(', ')} (move it there by hand)`)
      }
    }
  }
  check('T7 가 번역/context.json matches the string tables and the files outside them', problems.length === 0, problems.join('\n  '))
  const noContext = cat.entries.filter((e) => !e.outside && !ctx.keys[e.id]).length
  console.log(`T7 가 keys without context: ${noContext} (the table shows the file:line or ${COMPUTED_WHERE})`)
}

{
  // T7 나 the generated files are in the one shape the import script writes.
  const problems: string[] = []
  for (const info of cat.namespaces) {
    if (!info.connected) problems.push(`${info.stringsFile}: does not pass the generated table as ja (import { ja } from './${info.jaFile.split('/').pop()!.replace(/\.ts$/, '')}')`)
    let text: string | undefined
    try {
      text = readFileSync(join(ROOT, info.jaFile), 'utf8')
    } catch {
      problems.push(`${info.jaFile}: missing`)
      continue
    }
    if (text !== renderJaFile(info.keys, info.ja)) problems.push(`${info.jaFile}: not in the generated shape (pnpm i18n:import --normalize --write)`)
  }
  check(`T7 나 ${cat.namespaces.length} ja-strings.ts files connected and in the generated shape`, problems.length === 0, problems.join('\n  '))
}

{
  // T7 다 번역/ja-status.json.
  const problems: string[] = []
  const HASH = /^[0-9a-f]{12}$/
  for (const [id, rec] of Object.entries(status)) {
    const e = cat.byId.get(id)
    if (!e) {
      problems.push(`${id}: not a key of the string tables or of context.json outside`)
      continue
    }
    if (rec.aiCheck) {
      if (!HASH.test(rec.aiCheck.ko) || !HASH.test(rec.aiCheck.ja)) problems.push(`${id}: aiCheck hash is not 12 hex characters`)
      if (!e.safety) problems.push(`${id}: aiCheck on a key that is not in scripts/i18n-safety.ts`)
      if (rec.aiCheck.record !== undefined && typeof rec.aiCheck.record !== 'string') problems.push(`${id}: aiCheck record is not a string`)
    }
    if (rec.human) {
      if (!HASH.test(rec.human.ko) || !HASH.test(rec.human.ja)) problems.push(`${id}: human hash is not 12 hex characters`)
      if (rec.human.status !== 'human-ok' && rec.human.status !== 'needs-fix') problems.push(`${id}: human status ${String(rec.human.status)}`)
    }
  }
  check(`T7 다 번역/ja-status.json (${Object.keys(status).length} records)`, problems.length === 0, problems.join('\n  '))
}

{
  // T8 the cross-check rule.
  const { fails, warns } = t8(JA_STAGE, cat.entries, status)
  const withJa = jaEntries.filter((e) => e.safety)
  const valid = withJa.filter((e) => aiCheckValid(e, status[e.id])).length
  if (warns.length) warn(`T8 JA_STAGE '${JA_STAGE}'`, `${warns.length} Japanese safety strings without a valid cross-check: ${warns.join(', ')}`)
  check(`T8 JA_STAGE '${JA_STAGE}': safety strings with Japanese ${withJa.length}, cross-checked ${valid}`, fails.length === 0, fails.join('\n  '))
}

{
  // T9 words to avoid, do-not-translate words.
  const fails: string[] = []
  const dnt = dntWords()
  for (const e of jaEntries) {
    for (const a of avoidedIn(e.ja!)) {
      if (a.fail) fails.push(`${e.id}: ${a.ja} (${a.note})`)
      else warn(`T9 ${e.id}`, `avoid ${a.ja} (${a.note}): ${e.ja}`)
    }
    for (const w of dnt) if (e.ko.includes(w) && !e.ja!.includes(w)) warn(`T9 ${e.id}`, `keep '${w}' as is: ${e.ja}`)
  }
  check('T9 no word that must not be used in Japanese', fails.length === 0, fails.join('\n  '))
}

{
  // T9 an avoided word inside an approved glossary word is not a hit (キー in パスキー).
  const has = (ja: string, w: string) => avoidedIn(ja).some((a) => a.ja === w)
  check('T9 パスキー alone is not キー', !has('パスキーでロックを解除します', 'キー'))
  check('T9 a bare キー still warns', has('キーを入力してください', 'キー'))
  check('T9 パスキー and a bare キー in one value still warns', has('パスキーとキー', 'キー'))
  check(
    'T9 請求書 still fails',
    avoidedIn('請求書を貼り付け').some((a) => a.ja === '請求書' && a.fail),
  )
}

{
  // T10 kana or kanji in every Japanese value. Placeholders, spaces, punctuation, symbols,
  // digits and the do-not-translate words (sats, ilchon, QR, NIP-05, PIN, BTC, …) may be
  // all there is; any other Latin-only value is English pasted in.
  const allowed = [...new Set([...dntWords(), 'PIN'])].sort((a, b) => b.length - a.length)
  const bad: string[] = []
  for (const e of jaEntries) {
    let rest = e.ja!.replace(/\{\w+\}/g, '')
    for (const w of allowed) rest = rest.split(w).join('')
    rest = rest.replace(/[\s\p{P}\p{S}\p{N}]/gu, '')
    if (rest && !KANA_KANJI.test(rest)) bad.push(`${e.id}: ${e.ja}`)
  }
  check('T10 every Japanese value has kana or kanji', bad.length === 0, bad.join('\n  '))
}

if (process.argv.includes('--review-gate')) {
  const open = reviewGate(cat.entries, status)
  check(`review gate: every Japanese value human-ok (${jaEntries.length} values)`, open.length === 0, `${open.length} not human-ok: ${open.join(', ')}`)
}

// ---------------------------------------------------------------- T11 Hangul outside the tables

/** Files allowed to hold Hangul outside comments. */
function hangulAllowed(path: string): boolean {
  return path.endsWith('strings.ts') || path === 'src/screens/shell/crash-copy.ts' || path === 'src/i18n/lang.ts' || path === 'src/lib/support-log/copy-log-copy.ts'
}

const sources = walk(join(ROOT, 'src'), ['.ts', '.tsx'])
{
  const hits: string[] = []
  for (const file of sources) {
    const path = rel(file)
    if (hangulAllowed(path)) continue
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
    lines.forEach((line, i) => {
      if (HANGUL.test(line)) hits.push(`${path}:${i + 1}: ${line.trim().slice(0, 80)}`)
    })
  }
  check('T11 no Hangul outside the string tables', hits.length === 0, hits.join('\n  '))
}

{
  // The stripper itself: comments go, text in strings stays.
  const s = stripComments('const a = \'wss://x\' // 한\n/* 한 */ const b = `${x}가` + "//나"')
  check('T11 stripComments keeps strings and drops comments', !s.includes('한') && s.includes('가') && s.includes('//나') && s.includes('wss://x'), s)
}

// ---------------------------------------------------------------- T12 glued text

{
  const hits: string[] = []
  for (const file of sources) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
    lines.forEach((line, i) => {
      if (line.includes('`${t(')) hits.push(`${rel(file)}:${i + 1}`)
    })
  }
  check('T12 no `${t(` in src', hits.length === 0, hits.join(', '))
}

// ---------------------------------------------------------------- T13 pickLang

const KO_EN_JA: readonly Lang[] = ['ko', 'en', 'ja']
const KO_EN: readonly Lang[] = ['ko', 'en']
const PICK_CASES: { langs: string[]; offered: readonly Lang[]; want: Lang }[] = [
  { langs: ['ja', 'ko'], offered: KO_EN_JA, want: 'ja' },
  { langs: ['en-US', 'ja'], offered: KO_EN_JA, want: 'en' },
  { langs: ['zh-TW', 'ja'], offered: KO_EN_JA, want: 'ja' },
  { langs: ['JA_jp'], offered: KO_EN_JA, want: 'ja' },
  { langs: ['ja-Latn'], offered: KO_EN_JA, want: 'ja' },
  { langs: [], offered: KO_EN_JA, want: 'en' },
  { langs: ['fr'], offered: KO_EN_JA, want: 'en' },
  { langs: ['ja'], offered: KO_EN, want: 'en' },
  { langs: ['ko-KR', 'en'], offered: KO_EN, want: 'ko' },
  { langs: ['fr', 'ko'], offered: KO_EN, want: 'ko' },
]
for (const c of PICK_CASES) {
  const got = pickLang(c.langs, c.offered)
  check(`T13 pickLang(${JSON.stringify(c.langs)}, ${c.offered.join('/')}) = ${c.want}`, got === c.want, `got ${got}`)
}
check('T13 browserLanguages uses languages', browserLanguages({ languages: ['ja-JP', 'en'], language: 'ko' }).join() === 'ja-JP,en')
check('T13 browserLanguages falls back to language', browserLanguages({ languages: [], language: 'ko-KR' }).join() === 'ko-KR')
check('T13 browserLanguages with nothing is empty', browserLanguages({}).length === 0)
{
  const throwing = Object.defineProperty({}, 'languages', {
    get() {
      throw new Error('blocked')
    },
  }) as { languages?: readonly string[] }
  check('T13 browserLanguages never throws', browserLanguages(throwing).length === 0)
}

// ---------------------------------------------------------------- T14 boot splash

{
  // Node has no import.meta.env, so offeredLangs() here is what the deploy build offers.
  const deployOffered = offeredLangs()
  check(`T14 deploy offeredLangs matches JA_STAGE '${JA_STAGE}'`, JA_STAGE === 'off' ? deployOffered.join() === 'ko,en' : deployOffered.join() === 'ko,en,ja', deployOffered.join())
  const script = readFileSync(join(ROOT, 'public/boot-splash.js'), 'utf8')
  const splashLang = (langs: string[]) => {
    const html = { lang: 'ko' }
    const p = { textContent: '' }
    const button = { textContent: '', hidden: true, addEventListener() {} }
    const splash = { querySelector: (q: string) => (q === 'p' ? p : button) }
    const sandbox = {
      document: { documentElement: html, getElementById: () => splash },
      navigator: { languages: langs, language: langs[0] },
      setTimeout: () => 0,
      location: { reload() {} },
    }
    // Reading storage must not be needed: any touch throws.
    Object.defineProperty(sandbox, 'localStorage', {
      get() {
        throw new Error('boot-splash.js read localStorage')
      },
    })
    runInNewContext(script, sandbox)
    return { lang: html.lang, text: p.textContent }
  }
  for (const c of PICK_CASES) {
    const want = pickLang(c.langs, deployOffered)
    let got = '(threw)'
    try {
      got = splashLang(c.langs).lang
    } catch (e) {
      got = `(threw: ${(e as Error).message})`
    }
    check(`T14 boot-splash.js ${JSON.stringify(c.langs)} → ${want}`, got === want, `got ${got}`)
  }
  check('T14 boot-splash.js Korean text', splashLang(['ko']).text === '불러오고 있어요')
  check('T14 boot-splash.js English text', splashLang(['en']).text === 'Loading')
}

// ---------------------------------------------------------------- T15 Japanese values (warnings)

{
  const jaValues: { key: string; ko: string; ja: string }[] = []
  for (const [ns, d] of listDictionaries()) {
    for (const [key, ja] of Object.entries(d.ja ?? {})) {
      if (typeof ja === 'string') jaValues.push({ key: `${ns}.${key}`, ko: d.ko[key] ?? '', ja })
    }
  }
  if (COPY.ja) {
    for (const k of ['title', 'body', 'reload'] as const) jaValues.push({ key: `crash.${k}`, ko: COPY.ko[k], ja: COPY.ja[k] })
  }
  const KO_NEG = /않|말|마세요|없/
  const JA_NEG = /ない|ません|ず|な$|な。/
  for (const v of jaValues) {
    if (v.ja.replace(/\{\w+\}/g, '').includes('·')) warn(`T15 ${v.key}`, "uses '·' (U+00B7); Japanese uses '・' (U+30FB)")
    if (KO_NEG.test(v.ko) && !JA_NEG.test(v.ja)) warn(`T15 ${v.key}`, `Korean has a negation, Japanese has none: ${v.ja}`)
  }
  console.log(`T15 Japanese values seen: ${jaValues.length}`)
}

// ---------------------------------------------------------------- T16 full-width digits

{
  // T16; also the guard's text cleaning (１００００ → 10000).
  const cases: [string, string, string][] = [
    ['KRW １２，３４５', sanitizeAmount('１２，３４５', 'KRW'), '12,345'],
    ['JPY １２，３４５', sanitizeAmount('１２，３４５', 'JPY'), '12,345'],
    ['JPY pasted １２，３４５', sanitizeAmount('１２，３４５', 'JPY', 'paste'), '12,345'],
    ['JPY pasted １２３４５', sanitizeAmount('１２３４５', 'JPY', 'paste'), '12,345'],
    ['USD １２．５', sanitizeAmount('１２．５', 'USD'), '12.5'],
    ['KRW １００００', sanitizeAmount('１００００', 'KRW'), '10,000'],
    ['fee －１．５', sanitizeFee('－１．５'), '-1.5'],
    ['fee ー1.5 (long-vowel mark)', sanitizeFee('ー1.5'), '-1.5'],
    ['fee ｰ1.5 (halfwidth long-vowel mark)', sanitizeFee('ｰ1.5'), '-1.5'],
    ['fee １．２５', sanitizeFee('１．２５'), '1.25'],
    ['fee 1ー5: ー not at the front is not a sign', sanitizeFee('1ー5'), '15'],
    // Only fullwidth digits, ． and ， convert; NFKC-only digits (½ ① ²) are dropped like letters.
    ['JPY 1½', sanitizeAmount('1½', 'JPY'), '1'],
    ['KRW ①⓪⓪', sanitizeAmount('①⓪⓪', 'KRW'), ''],
    ['JPY ²', sanitizeAmount('²', 'JPY'), ''],
    ['KRW 100m²', sanitizeAmount('100m²', 'KRW'), '100'],
    ['USD pasted 100m²', sanitizeAmount('100m²', 'USD', 'paste'), '100'],
    ['fee 1½', sanitizeFee('1½'), '1'],
    ['fee ²', sanitizeFee('²'), ''],
    ['fee ①⓪', sanitizeFee('①⓪'), ''],
    // ASCII input gives what it gave before.
    ['KRW 12,345 unchanged', sanitizeAmount('12,345', 'KRW'), '12,345'],
    ['JPY pasted 12.75円 unchanged', sanitizeAmount('12.75円', 'JPY', 'paste'), '12'],
    ['USD 1234.567 unchanged', sanitizeAmount('1234.567', 'USD'), '1,234.56'],
    ['fee −0.5 unchanged', sanitizeFee('−0.5'), '-0.5'],
    ['fee 1,5 unchanged', sanitizeFee('1,5'), '1.5'],
  ]
  for (const [name, got, want] of cases) check(`T16 ${name} → ${want}`, got === want, `got ${got}`)
  const caret: [string, number, number, number][] = [
    // [raw, pos, want, got]
    ['１２，３', 4, 3, significantBefore('１２，３', 4)],
    ['１２，３', 2, 2, significantBefore('１２，３', 2)],
    ['1,23', 4, 3, significantBefore('1,23', 4)],
    ['１２．５ (USD counts the point)', 4, 4, significantBefore('１２．５', 4, 'USD')],
    ['１２．５ (JPY does not)', 4, 3, significantBefore('１２．５', 4, 'JPY')],
    ['1½2 (½ is not a digit)', 3, 2, significantBefore('1½2', 3)],
    ['①②', 2, 0, significantBefore('①②', 2)],
  ]
  for (const [raw, pos, want, got] of caret) check(`T16 significantBefore('${raw}', ${pos}) → ${want}`, got === want, `got ${got}`)
}

// ---------------------------------------------------------------- T17 no stored language

{
  const KEY = 'ilchon' + ':lang'
  const files = [...walk(join(ROOT, 'src'), ['.ts', '.tsx', '.css']), ...walk(join(ROOT, 'public'), ['.js', '.css', '.html', '.json', '.webmanifest']), join(ROOT, 'index.html')]
  // One exception: src/engine/browser.ts deletes a value an old
  // build left behind, on a line that removes it and nowhere else.
  const deletesOnly = (f: string) =>
    rel(f) === 'src/engine/browser.ts' &&
    readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => l.includes(KEY))
      .every((l) => l.includes('localStorage.removeItem(') && !l.includes('setItem'))
  const keyHits = files.filter((f) => readFileSync(f, 'utf8').includes(KEY) && !deletesOnly(f)).map(rel)
  check(`T17 '${KEY}' appears nowhere in src, public, index.html`, keyHits.length === 0, keyHits.join(', '))
  const langFiles = [...walk(join(ROOT, 'src/i18n'), ['.ts', '.tsx']), join(ROOT, 'src/screens/shell/crash-copy.ts'), join(ROOT, 'src/screens/shell/CrashBoundary.tsx')]
  try {
    langFiles.push(...walk(join(ROOT, 'src/lib/support-log'), ['fallback.ts']))
  } catch {
    // Not there in every checkout.
  }
  const storageHits = langFiles.filter((f) => readFileSync(f, 'utf8').includes('localStorage')).map(rel)
  check('T17 no localStorage in the language code', storageHits.length === 0, storageHits.join(', '))
}

// ---------------------------------------------------------------- T18 11px floor in every language

{
  // 10px tab labels and captions were too small on a phone. The floor used to be
  // raised for Japanese only; it holds for every language now.
  const files = [...walk(join(ROOT, 'src'), ['.css', '.tsx']), ...walk(join(ROOT, 'public'), ['.css']), join(ROOT, 'index.html')]
  const tokens = readFileSync(join(ROOT, 'src/ui/tokens.css'), 'utf8')
  const defined = new Set([...tokens.matchAll(/(--fs-[\w-]+)\s*:/g)].map((m) => m[1]!))
  const small: string[] = []
  for (const m of tokens.matchAll(/(--fs-[\w-]+)\s*:\s*([0-9.]+)px/g)) if (Number(m[2]) < 11) small.push(`tokens.css ${m[1]}: ${m[2]}px`)
  const unknown: string[] = []
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const m of text.matchAll(/font-size\s*:\s*([0-9.]+)px|fontSize\s*:\s*['"]?([0-9.]+)(?:px)?['"]?/g)) {
      const px = Number(m[1] ?? m[2])
      if (px < 11) small.push(`${rel(f)}: ${m[0]}`)
    }
    for (const m of text.matchAll(/var\((--fs-[\w-]+)\)/g)) if (!defined.has(m[1]!)) unknown.push(`${rel(f)}: ${m[1]}`)
  }
  check(`T18 no font size below 11px (${defined.size} size tokens)`, small.length === 0, small.join(', '))
  check('T18 every var(--fs-*) is a defined token', unknown.length === 0, unknown.join(', '))
  // The avatar initial is computed from the circle (it was 10px at 24px).
  const tinyAvatars = [16, 20, 24, 26, 28, 32, 40, 44, 48].filter((n) => avatarFontSize(n) < 11)
  check('T18 the avatar initial is 11px or more at every size (24px -> 11px)', tinyAvatars.length === 0 && avatarFontSize(24) === 11, tinyAvatars.join(', '))
}

// ---------------------------------------------------------------- T19 camera messages
{
  const dom = (name: string) => Object.assign(new Error(name), { name })
  const ok: CameraContext = { secure: true }
  const cases: [string, unknown, CameraContext, string][] = [
    ['prompt dismissed (library catch-all, camera exists, state prompt)', LIBRARY_NO_CAMERA, { ...ok, permission: 'prompt', hasCamera: true }, 'Camera permission dismissed'],
    // With the state unknown we cannot tell a dismissal; say nothing about the person.
    ['permission state unknown, camera listed (no camera permission name)', LIBRARY_NO_CAMERA, { ...ok, hasCamera: true }, 'Camera failed'],
    ['blocked for the site (library catch-all, state denied)', LIBRARY_NO_CAMERA, { ...ok, permission: 'denied', hasCamera: true }, 'Camera permission denied'],
    ['no camera at all (library catch-all, no videoinput)', LIBRARY_NO_CAMERA, { ...ok, permission: 'prompt', hasCamera: false }, 'No camera found'],
    ['granted but failed (library catch-all)', LIBRARY_NO_CAMERA, { ...ok, permission: 'granted', hasCamera: true }, 'Camera unavailable'],
    ['library catch-all, browser tells nothing (as before)', LIBRARY_NO_CAMERA, ok, 'No camera found'],
    ['NotAllowedError, state prompt (dismissed)', dom('NotAllowedError'), { ...ok, permission: 'prompt' }, 'Camera permission dismissed'],
    ['NotAllowedError, state denied', dom('NotAllowedError'), { ...ok, permission: 'denied' }, 'Camera permission denied'],
    ['NotFoundError', dom('NotFoundError'), { ...ok, permission: 'prompt', hasCamera: false }, 'No camera found'],
    ['NotReadableError', dom('NotReadableError'), ok, 'Camera is in use'],
    ['not https', LIBRARY_NO_CAMERA, { secure: false, hasCamera: true }, 'Camera needs https'],
  ]
  for (const [name, err, ctx, want] of cases) {
    const got = cameraReason(err, ctx)
    check(`T19 ${name} -> ${want}`, got === want, `got ${got}`)
  }
  const connect = listDictionaries().get('connect')
  const screen = readFileSync(join(ROOT, 'src/screens/connect/ConnectScreen.tsx'), 'utf8')
  const map = screen.match(/const CAMERA_ERRORS[^{]*\{([^}]*)\}/)?.[1] ?? ''
  const keys = [...map.matchAll(/:\s*'(cam\w+)'/g)].map((m) => m[1]!)
  const missing = keys.filter((k) => !connect?.ko[k] || !connect?.en[k])
  // fail() awaits the browser, so every branch of the scanner's effect hands back
  // the cleanup that marks it disposed (no onError after the scanner was switched off).
  const scanner = readFileSync(join(ROOT, 'src/ui/qr/QrScanner.tsx'), 'utf8')
  const effect = scanner.slice(scanner.indexOf('const fail = '), scanner.indexOf('}, [active])') + 1)
  const cleanupBody = scanner.slice(scanner.indexOf('const cleanup = '), scanner.indexOf('const fail = '))
  check(
    'T19 the scanner effect returns its cleanup in every branch (no camera API, and started)',
    /fail\(null\)\s*return cleanup\b/.test(effect) && /return cleanup\s*\}$/.test(effect) && /disposed = true/.test(cleanupBody),
    'a branch of the QrScanner effect leaves disposed unset',
  )
  check(
    `T19 every camera reason has its key in ko and en (${keys.join(', ')})`,
    keys.length >= 7 && keys.includes('camDismissed') && keys.includes('camFailed') && missing.length === 0,
    `missing ${missing.join(', ')}; found ${keys.length}`,
  )
}

// ---------------------------------------------------------------- T20 no relay word outside settings
{
  const RELAY_WORD = /중계|relay/i
  // Privacy statements that must name who sees what, and the link into the settings screen.
  // shell.intro3 (first-run intro) is kept on purpose for now.
  const RELAY_WORD_OK = new Set(['shell.intro3', 'shell.connStrict', 'shell.connRelaySettings', 'contacts.nostrPrivacy'])
  const hits: string[] = []
  let seen = 0
  for (const [ns, d] of listDictionaries()) {
    if (ns === 'settings') continue
    for (const lang of ['ko', 'en'] as const) {
      for (const [key, v] of Object.entries(d[lang] ?? {})) {
        if (typeof v !== 'string') continue
        seen++
        if (RELAY_WORD.test(v) && !RELAY_WORD_OK.has(`${ns}.${key}`)) hits.push(`${lang}:${ns}.${key}`)
      }
    }
  }
  check(`T20 no relay word outside the settings screen (${seen} values)`, hits.length === 0, hits.join(', '))
}

console.log(failed ? `\n${failed} FAILED${warned ? `, ${warned} warnings` : ''}` : `\nALL PASS${warned ? ` (${warned} warnings)` : ''}`)
if (failed) process.exit(1)
