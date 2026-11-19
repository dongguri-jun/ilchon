/**
 * Shared code of the translation table scripts:
 * pnpm i18n:table (export), pnpm i18n:import (import), check-i18n T1 to T10 and
 * check-i18n-table. No network, no secrets, no packages beyond Node: node:fs,
 * node:path, node:crypto, and git rev-parse / git status --porcelain.
 *
 * The source of every Korean and English string stays the hand-written strings.ts.
 * Japanese lives in generated files next to them (ja-strings.ts, install-ja-strings.ts)
 * that only the import script writes, in the one shape renderJaFile gives.
 * Review state is in 번역/ja-status.json (import only), context in 번역/context.json.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listDictionaries } from '../../src/i18n'
import { AVOID, TERMS, TONE } from '../i18n-glossary'
import { SAFETY_CATEGORIES, safetyCategory, type SafetyCategory } from '../i18n-safety'

export const ROOT = resolve(import.meta.dirname, '../..')
export const STATUS_PATH = '번역/ja-status.json'
export const CONTEXT_PATH = '번역/context.json'
export const OUT_DIR = '번역/out'
/** Cross-check records must live here, relative to the repository root. I18N_RECORD_DIR moves the folder. */
export const RECORD_DIR = process.env.I18N_RECORD_DIR || 'i18n-records'
/** Namespace order of the table. Unknown namespaces follow, then _outside. */
export const NS_ORDER = ['shell', 'install', 'ui', 'contacts', 'connect', 'board', 'room', 'lock', 'settings'] as const
export const OUTSIDE_NS = '_outside'

export const HANGUL = /[ᄀ-ᇿㄱ-ㆎꥠ-꥿가-힣ힰ-퟿]/
export const KANA_KANJI = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u
const FULLWIDTH_BRACE = /[｛｝]/
/** Same pattern as translate() in src/i18n/index.ts. */
const PLACEHOLDER = /\{(\w+)\}/g

export const rel = (p: string, root = ROOT) => relative(root, p).split(sep).join('/')

// ------------------------------------------------------------------ small helpers

export function hash12(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12)
}

/** Placeholder names, sorted and unique. */
export function placeholders(s: string): string[] {
  return [...new Set([...s.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort()
}

export function samePlaceholders(a: string, b: string): boolean {
  return placeholders(a).join(' ') === placeholders(b).join(' ')
}

export function hasFullwidthBrace(s: string): boolean {
  return FULLWIDTH_BRACE.test(s)
}

/** A newline inside a value is written as the two characters \n in the table. */
export const escapeNl = (s: string) => s.replace(/\n/g, '\\n')
export const unescapeNl = (s: string) => s.replace(/\\n/g, '\n')

export function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function commit7(root = ROOT): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return 'nogit00'
  }
}

function walk(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p, accept))
    else if (accept(name)) out.push(p)
  }
  return out.sort()
}

// ------------------------------------------------------------------ context and status files

export type LangFiles = { ko: string | string[]; en: string | string[]; ja: string | string[] }
export type OutsideEntry = {
  key: string
  files: LangFiles
  ko: string
  en: string
  ja: string | null
  where?: string
  max?: number | 'button'
  note?: string
}
export type Context = {
  screens: Record<string, { ko: string; ja: string }>
  keys: Record<string, { where?: string; max?: number | 'button'; note?: string }>
  outside: OutsideEntry[]
  /**
   * The file as written (people write it by hand, in any layout). The import changes
   * only `outside[].ja` values inside this text and keeps every other byte.
   */
  text?: string
}

export function readContext(root = ROOT): Context {
  const text = readFileSync(join(root, CONTEXT_PATH), 'utf8')
  const ctx = JSON.parse(text) as Partial<Context>
  return { screens: ctx.screens ?? {}, keys: ctx.keys ?? {}, outside: ctx.outside ?? [], text }
}

/** Only for a context with no file text (tests): two-space JSON. */
export function renderContext(ctx: Context): string {
  const { text: _text, ...rest } = ctx
  return JSON.stringify(rest, null, 2) + '\n'
}

type Span = { start: number; end: number }
type JNode = Span & ({ t: 'obj'; props: { key: string; value: JNode }[] } | { t: 'arr'; items: JNode[] } | { t: 'val' })

/** A JSON reader that keeps where each value starts and ends in the text. */
function parseSpans(text: string): JNode {
  let i = 0
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++
  }
  const str = (): string => {
    const start = i
    i++
    while (text[i] !== '"') {
      if (i >= text.length) throw new Error('unterminated string')
      i += text[i] === '\\' ? 2 : 1
    }
    i++
    return JSON.parse(text.slice(start, i)) as string
  }
  const value = (): JNode => {
    ws()
    const start = i
    const c = text[i]
    if (c === '{') {
      i++
      const props: { key: string; value: JNode }[] = []
      ws()
      if (text[i] === '}') i++
      else
        for (;;) {
          ws()
          const key = str()
          ws()
          if (text[i++] !== ':') throw new Error('expected :')
          props.push({ key, value: value() })
          ws()
          const d = text[i++]
          if (d === '}') break
          if (d !== ',') throw new Error('expected , or }')
        }
      return { t: 'obj', props, start, end: i }
    }
    if (c === '[') {
      i++
      const items: JNode[] = []
      ws()
      if (text[i] === ']') i++
      else
        for (;;) {
          items.push(value())
          ws()
          const d = text[i++]
          if (d === ']') break
          if (d !== ',') throw new Error('expected , or ]')
        }
      return { t: 'arr', items, start, end: i }
    }
    if (c === '"') str()
    else while (i < text.length && !',]} \t\n\r'.includes(text[i])) i++
    return { t: 'val', start, end: i }
  }
  return value()
}

/**
 * context.json after the import: the hand-written text with only the changed
 * `outside[].ja` values replaced. Undefined when nothing changes. Falls back to
 * two-space JSON only when there is no file text or an entry has no `ja` to replace.
 */
export function renderContextAfter(ctx: Context, ja: ReadonlyMap<string, string | null>): string | undefined {
  const changes = ctx.outside.filter((o) => ja.has(o.key) && (ja.get(o.key) ?? null) !== (o.ja ?? null))
  if (!changes.length) return undefined
  const next: Context = { ...ctx, outside: ctx.outside.map((o) => (ja.has(o.key) ? { ...o, ja: ja.get(o.key) ?? null } : o)) }
  if (ctx.text === undefined) return renderContext(next)
  const root = parseSpans(ctx.text)
  const outside = root.t === 'obj' ? root.props.find((p) => p.key === 'outside')?.value : undefined
  const edits: (Span & { with: string })[] = []
  if (outside?.t === 'arr')
    for (const item of outside.items) {
      if (item.t !== 'obj') continue
      const keyNode = item.props.find((p) => p.key === 'key')?.value
      const key = keyNode ? (JSON.parse(ctx.text.slice(keyNode.start, keyNode.end)) as unknown) : undefined
      const change = changes.find((o) => o.key === key)
      const jaNode = item.props.find((p) => p.key === 'ja')?.value
      if (change && jaNode) edits.push({ start: jaNode.start, end: jaNode.end, with: JSON.stringify(ja.get(change.key) ?? null) })
    }
  if (edits.length !== changes.length) return renderContext(next)
  let out = ctx.text
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.with + out.slice(e.end)
  return out
}

/** `record` names the cross-check table the result came from, when the import was given one. */
export type AiCheck = { date: string; ko: string; ja: string; record?: string }
export type Human = { status: 'human-ok' | 'needs-fix'; date: string; ko: string; ja: string }
export type Rec = { aiCheck?: AiCheck; human?: Human; comment?: string }
export type StatusFile = Record<string, Rec>

export function readStatus(root = ROOT): StatusFile {
  const p = join(root, STATUS_PATH)
  if (!existsSync(p)) return {}
  return JSON.parse(readFileSync(p, 'utf8')) as StatusFile
}

/** Keys sorted, fields in one order, empty comments left out. */
export function renderStatus(status: StatusFile): string {
  const out: Record<string, unknown> = {}
  for (const id of Object.keys(status).sort()) {
    const r = status[id]
    const o: Record<string, unknown> = {}
    if (r.aiCheck) o.aiCheck = { date: r.aiCheck.date, ko: r.aiCheck.ko, ja: r.aiCheck.ja, ...(r.aiCheck.record ? { record: r.aiCheck.record } : {}) }
    if (r.human) o.human = { status: r.human.status, date: r.human.date, ko: r.human.ko, ja: r.human.ja }
    if (r.comment) o.comment = r.comment
    if (Object.keys(o).length) out[id] = o
  }
  return JSON.stringify(out, null, 2) + '\n'
}

// ------------------------------------------------------------------ the catalog (every string)

export type Entry = {
  /** `ns.key`, or `_outside.…` for text outside the string tables. */
  id: string
  ns: string
  key: string
  ko: string
  en: string
  ja?: string
  outside: boolean
  safety?: SafetyCategory
}
export type NsInfo = {
  ns: string
  /** Repo-relative paths. */
  stringsFile: string
  jaFile: string
  /** Keys in the order of the Korean block. */
  keys: string[]
  /** The registration passes the generated table as `ja`. */
  connected: boolean
  /** The generated table as imported. */
  ja: Record<string, string>
}
export type Catalog = { entries: Entry[]; byId: Map<string, Entry>; namespaces: NsInfo[] }

/** Registration files: under src, name ends in strings.ts, generated ja files excluded. */
export function registrationFiles(root = ROOT): string[] {
  return walk(join(root, 'src'), (n) => n.endsWith('strings.ts') && !n.endsWith('ja-strings.ts'))
}

/** The namespace a registration file registers: registerStrings('lit', …) or registerStrings(CONST, …). */
export function namespaceOf(source: string): string | undefined {
  const m = /registerStrings\(\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*,/.exec(source)
  if (!m) return undefined
  if (m[1] ?? m[2]) return m[1] ?? m[2]
  const c = new RegExp(`const\\s+${m[3]}\\s*=\\s*['"]([^'"]+)['"]`).exec(source)
  return c?.[1]
}

export const jaFileFor = (stringsFile: string) => stringsFile.replace(/strings\.ts$/, 'ja-strings.ts')

export async function loadCatalog(ctx: Context): Promise<Catalog> {
  const infos: NsInfo[] = []
  for (const abs of registrationFiles()) {
    const source = readFileSync(abs, 'utf8')
    const ns = namespaceOf(source)
    if (!ns) throw new Error(`${rel(abs)}: cannot tell which namespace it registers`)
    await import(pathToFileURL(abs).href)
    const jaAbs = jaFileFor(abs)
    let ja: Record<string, string> = {}
    if (existsSync(jaAbs)) ja = ((await import(pathToFileURL(jaAbs).href)) as { ja: Record<string, string> }).ja
    infos.push({ ns, stringsFile: rel(abs), jaFile: rel(jaAbs), keys: [], connected: false, ja })
  }
  const dicts = listDictionaries()
  for (const info of infos) {
    const d = dicts.get(info.ns)
    if (!d) throw new Error(`${info.stringsFile}: namespace '${info.ns}' was not registered`)
    info.keys = Object.keys(d.ko)
    info.connected = d.ja !== undefined && d.ja === info.ja
  }
  const rank = (ns: string) => {
    const i = (NS_ORDER as readonly string[]).indexOf(ns)
    return i < 0 ? NS_ORDER.length : i
  }
  infos.sort((a, b) => rank(a.ns) - rank(b.ns) || a.ns.localeCompare(b.ns))

  const entries: Entry[] = []
  for (const info of infos) {
    const d = dicts.get(info.ns)!
    for (const key of info.keys) {
      const id = `${info.ns}.${key}`
      const ja = d.ja?.[key]
      entries.push({ id, ns: info.ns, key, ko: d.ko[key], en: d.en[key], ja: typeof ja === 'string' ? ja : undefined, outside: false, safety: safetyCategory(id) })
    }
  }
  for (const o of ctx.outside) {
    const key = o.key.startsWith(`${OUTSIDE_NS}.`) ? o.key.slice(OUTSIDE_NS.length + 1) : o.key
    entries.push({ id: o.key, ns: OUTSIDE_NS, key, ko: o.ko, en: o.en, ja: o.ja ?? undefined, outside: true, safety: safetyCategory(o.key) })
  }
  return { entries, byId: new Map(entries.map((e) => [e.id, e])), namespaces: infos }
}

// ------------------------------------------------------------------ the generated Japanese file

const JA_HEADER = [
  '// Written by scripts/i18n-import.ts (pnpm i18n:import). Do not edit by hand:',
  '// check-i18n T7 compares this file with what the import script writes.',
  '// Review state (AI draft, cross-check, human review) is in 번역/ja-status.json.',
].join('\n')

/** U+2028 and U+2029, built from code points so this file holds no raw separator. */
const LS = new RegExp(String.fromCharCode(0x2028), 'g')
const PS = new RegExp(String.fromCharCode(0x2029), 'g')

function quoteTs(s: string): string {
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(LS, '\\u2028').replace(PS, '\\u2029') + "'"
}

/** The one shape of ja-strings.ts: keys in Korean-block order, keys without Japanese left out. */
export function renderJaFile(keyOrder: readonly string[], ja: Record<string, string | undefined>): string {
  const lines: string[] = []
  for (const k of keyOrder) {
    const v = ja[k]
    if (typeof v !== 'string') continue
    const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : quoteTs(k)
    lines.push(`  ${key}: ${quoteTs(v)},`)
  }
  if (lines.length === 0) return `${JA_HEADER}\nexport const ja: Record<string, string> = {}\n`
  return `${JA_HEADER}\nexport const ja: Record<string, string> = {\n${lines.join('\n')}\n}\n`
}

// ------------------------------------------------------------------ review state

export type State = 'none' | 'needs-fix' | 'human-ok' | 'ai-checked' | 'ai-draft'
/** Shown in column 11. The reviewer writes OK or NG instead. */
export const STATE_LABEL: Record<State, string> = {
  none: '일본어 없음 / 未翻訳',
  'needs-fix': '수정 필요 / 要修正',
  'human-ok': '사람 검수 완료 / 確認済み',
  'ai-checked': 'AI 교차검사 통과 / AIチェック済み',
  'ai-draft': 'AI 초안 / AI下書き',
}

export function aiCheckValid(e: Pick<Entry, 'ko' | 'ja'>, rec: Rec | undefined): boolean {
  const a = rec?.aiCheck
  return !!a && e.ja !== undefined && a.ko === hash12(e.ko) && a.ja === hash12(e.ja)
}

export function humanValid(e: Pick<Entry, 'ko' | 'ja'>, rec: Rec | undefined): boolean {
  const h = rec?.human
  return !!h && e.ja !== undefined && h.ko === hash12(e.ko) && h.ja === hash12(e.ja)
}

/** Computed from the records, never stored. */
export function stateOf(e: Pick<Entry, 'ko' | 'ja' | 'safety'>, rec: Rec | undefined): State {
  if (e.ja === undefined) return 'none'
  if (humanValid(e, rec)) return rec!.human!.status
  if (e.safety && aiCheckValid(e, rec)) return 'ai-checked'
  return 'ai-draft'
}

/** check-i18n T8: Japanese safety strings need a valid cross-check unless JA_STAGE is 'off'. */
export function t8(stage: 'off' | 'beta' | 'reviewed', entries: readonly Entry[], status: StatusFile): { fails: string[]; warns: string[] } {
  const bad: string[] = []
  for (const e of entries) {
    if (!e.safety || e.ja === undefined) continue
    if (!aiCheckValid(e, status[e.id])) bad.push(status[e.id]?.aiCheck ? `${e.id} (기록이 지금 값과 어긋남)` : `${e.id} (교차검사 기록 없음)`)
  }
  return stage === 'off' ? { fails: [], warns: bad } : { fails: bad, warns: [] }
}

/** pnpm check:i18n --review-gate: every key with Japanese is human-ok (so none needs-fix). */
export function reviewGate(entries: readonly Entry[], status: StatusFile): string[] {
  return entries.filter((e) => e.ja !== undefined && stateOf(e, status[e.id]) !== 'human-ok').map((e) => `${e.id} (${stateOf(e, status[e.id])})`)
}

// ------------------------------------------------------------------ CSV

/** Characters a spreadsheet may read as the start of a formula. */
const FORMULA_START = new Set(['=', '+', '-', '@', '\t', '\r'])

/** Formula guard: a leading ' keeps the cell text. */
export function guardCell(v: string): string {
  return v.length > 0 && FORMULA_START.has(v[0]) ? `'${v}` : v
}

/** UTF-8 BOM, every cell quoted, CRLF (RFC 4180). */
export function writeCsv(rows: readonly (readonly string[])[]): string {
  const line = (r: readonly string[]) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')
  return '﻿' + rows.map(line).join('\r\n') + '\r\n'
}

/** RFC 4180: quoted cells may hold commas, line breaks and "". Accepts CRLF, LF, CR. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let i = 0
  const endCell = () => {
    row.push(cell)
    cell = ''
  }
  const endRow = () => {
    endCell()
    rows.push(row)
    row = []
  }
  while (i < text.length) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      cell += c
      i++
      continue
    }
    if (c === '"' && cell === '') {
      quoted = true
      i++
    } else if (c === ',') {
      endCell()
      i++
    } else if (c === '\r') {
      endRow()
      i += text[i + 1] === '\n' ? 2 : 1
    } else if (c === '\n') {
      endRow()
      i++
    } else {
      cell += c
      i++
    }
  }
  if (cell !== '' || row.length > 0) endRow()
  return rows
}

/** Strict UTF-8; throws on anything else (a Shift_JIS save from Excel, say). */
export function decodeUtf8(bytes: Uint8Array): { text: string; bom: boolean } {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const bom = text.startsWith('﻿')
  return { text: bom ? text.slice(1) : text, bom }
}

/**
 * The same tidy-up for every cell read: drop the formula guard ', line breaks to \n, NFC.
 * Japanese cells (and comments) also turn the two characters \n into a line break;
 * Japanese cells are trimmed.
 */
export function cleanCell(raw: string, kind: 'plain' | 'ja' | 'comment' = 'plain'): { value: string; trimmed: boolean } {
  let v = raw
  if (v.length > 1 && v[0] === "'" && FORMULA_START.has(v[1])) v = v.slice(1)
  v = v.replace(/\r\n?/g, '\n').normalize('NFC')
  if (kind === 'plain') return { value: v, trimmed: false }
  v = unescapeNl(v)
  if (kind === 'comment') return { value: v, trimmed: false }
  const t = v.trim()
  return { value: t, trimmed: t !== v }
}

export const SHEET_ERROR = /^#(NAME\?|ERROR!|VALUE!|REF!|DIV\/0!|N\/A|NUM!|NULL!)$/

// ------------------------------------------------------------------ the table

export const COLUMNS = [
  ['key', 'key 키/キー'],
  ['screen', 'screen 화면/画面'],
  ['where', 'where 위치/表示場所'],
  ['ko', 'ko'],
  ['en', 'en'],
  ['ja', 'ja 일본어(AI 초안)/日本語(AI下書き)'],
  ['ja_fix', 'ja_fix 수정 제안/修正案'],
  ['placeholders', 'placeholders 자리표시자/プレースホルダー'],
  ['max', 'max 길이/文字数'],
  ['safety', 'safety 안전/重要'],
  ['status', 'status 상태/状態'],
  ['comment', 'comment 의견/コメント'],
] as const
export type ColumnName = (typeof COLUMNS)[number][0]
export type TableRow = Record<ColumnName, string>

/** Length limits by kind of text, guessed from the key name. Context max wins. */
export function kindOf(e: Pick<Entry, 'ns' | 'key'>): { kind: string; max: number | '' } {
  if (/^chip[A-Z]/.test(e.key)) return { kind: 'chip', max: 8 }
  if (e.ns === 'shell' && /^tab[A-Z]/.test(e.key)) return { kind: 'tab', max: 5 }
  if (/^opt[A-Z]/.test(e.key)) return { kind: 'select', max: 6 }
  if (/Badge$/.test(e.key)) return { kind: 'badge', max: 4 }
  return { kind: '', max: '' }
}

export const COMPUTED_WHERE = '(코드가 계산하는 키)'

/**
 * Where a key shows, when the context file says nothing: the first `file:line` that
 * quotes the key in a file calling useT for its namespace (useT('lock') or useT(NS) with
 * NS imported from that namespace's strings.ts).
 */
export function autoWhere(cat: Catalog, root = ROOT): Map<string, string> {
  const nsByFile = new Map(cat.namespaces.map((n) => [n.stringsFile, n.ns]))
  const files = walk(join(root, 'src'), (n) => /\.tsx?$/.test(n) && !n.endsWith('strings.ts'))
  const usage: { path: string; lines: string[]; ns: Set<string> }[] = []
  for (const abs of files) {
    const src = readFileSync(abs, 'utf8')
    const ns = new Set<string>()
    for (const m of src.matchAll(/useT\(\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*\)/g)) {
      if (m[1] ?? m[2]) ns.add((m[1] ?? m[2])!)
      else {
        for (const im of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
          const names = im[1].split(',').map((s) =>
            s
              .trim()
              .split(/\s+as\s+/)
              .pop(),
          )
          if (!names.includes(m[3])) continue
          const target = rel(resolve(dirname(abs), im[2]) + '.ts', root)
          const found = nsByFile.get(target)
          if (found) ns.add(found)
        }
      }
    }
    if (ns.size) usage.push({ path: rel(abs, root), lines: src.split('\n'), ns })
  }
  const out = new Map<string, string>()
  for (const e of cat.entries) {
    if (e.outside) continue
    let hit: string | undefined
    for (const u of usage) {
      if (!u.ns.has(e.ns)) continue
      const i = u.lines.findIndex((l) => l.includes(`'${e.key}'`) || l.includes(`"${e.key}"`))
      if (i >= 0) {
        hit = `${u.path}:${i + 1}`
        break
      }
    }
    out.set(e.id, hit ?? COMPUTED_WHERE)
  }
  return out
}

export function buildRows(cat: Catalog, ctx: Context, status: StatusFile, opts: { onlySafety?: boolean; ns?: string } = {}): TableRow[] {
  const where = autoWhere(cat)
  const pick = cat.entries.filter((e) => (!opts.onlySafety || e.safety) && (!opts.ns || e.ns === opts.ns))
  // Safety keys first; the catalog order (namespace, then Korean key order) inside each group.
  const ordered = [...pick.filter((e) => e.safety), ...pick.filter((e) => !e.safety)]
  return ordered.map((e) => {
    const c = e.outside ? ctx.outside.find((o) => o.key === e.id) : undefined
    const k = ctx.keys[e.id]
    const screen = ctx.screens[e.ns]
    const max = k?.max ?? c?.max ?? kindOf(e).max
    return {
      key: e.id,
      screen: screen ? `${screen.ko} / ${screen.ja}` : e.ns,
      where: k?.where ?? c?.where ?? where.get(e.id) ?? '',
      ko: e.ko,
      en: e.en,
      ja: e.ja ?? '',
      ja_fix: '',
      placeholders: placeholders(e.ko).join(' '),
      max: String(max),
      safety: e.safety ? `YES ${e.safety}` : '',
      status: STATE_LABEL[stateOf(e, status[e.id])],
      comment: status[e.id]?.comment ?? '',
    }
  })
}

/** The table as CSV: header, then every value guarded against formulas, line breaks as \n. */
export function tableCsv(rows: readonly TableRow[]): string {
  const header = COLUMNS.map(([, h]) => h)
  return writeCsv([header, ...rows.map((r) => COLUMNS.map(([name]) => guardCell(escapeNl(r[name]))))])
}

/** For AI drafts: the per-key rows. */
export function jsonRows(cat: Catalog, ctx: Context, status: StatusFile, opts: { onlySafety?: boolean; ns?: string } = {}) {
  return buildRows(cat, ctx, status, opts).map((r) => {
    const e = cat.byId.get(r.key)!
    return {
      key: r.key,
      screen: r.screen,
      where: r.where,
      note: ctx.keys[r.key]?.note ?? ctx.outside.find((o) => o.key === r.key)?.note,
      ko: r.ko,
      en: r.en,
      ja: r.ja || null,
      placeholders: placeholders(e.ko),
      kind: r.max === 'button' ? 'button' : kindOf(e).kind || undefined,
      max: r.max === '' ? undefined : r.max === 'button' ? 'button' : Number(r.max),
      safety: e.safety ? { category: e.safety, ...SAFETY_CATEGORIES[e.safety] } : null,
      status: stateOf(e, status[e.id]),
    }
  })
}

/**
 * pnpm i18n:table --json: what the model gets for a draft: the glossary
 * of scripts/i18n-glossary.ts (TONE, TERMS, AVOID) and the per-key rows. The rules
 * themselves (tone, app summary, length limits, placeholders) are given by the
 * person with this; the result goes back through pnpm i18n:import <file.json> --by ai-draft.
 */
export function aiInput(cat: Catalog, ctx: Context, status: StatusFile, opts: { onlySafety?: boolean; ns?: string } = {}) {
  return {
    rules: 'given separately: tone, app summary, length limits, placeholders',
    result: '{ "ja": { "ns.key": "…" }, "notes": [ … ] }',
    glossary: { tone: TONE, terms: TERMS, avoid: AVOID },
    keys: jsonRows(cat, ctx, status, opts),
  }
}

// ------------------------------------------------------------------ reading a returned table

export type By = 'ai-draft' | 'ai-check' | 'human'
export type ImportRow = {
  line: number
  key: string
  /** Undefined for JSON input (no Korean or English to compare). */
  ko?: string
  en?: string
  ja: string
  ja_fix: string
  status: string
  comment?: string
}
export type ReadResult = { rows: ImportRow[]; stops: string[]; notes: string[]; info: string }

const REQUIRED: ColumnName[] = ['key', 'ko', 'en', 'ja', 'ja_fix', 'status']
const STATUS_WORDS = new Set([...Object.values(STATE_LABEL), 'OK', 'NG', ''])

export function readTable(bytes: Uint8Array): ReadResult {
  const stops: string[] = []
  const notes: string[] = []
  let decoded: { text: string; bom: boolean }
  try {
    decoded = decodeUtf8(bytes)
  } catch {
    return { rows: [], stops: ["UTF-8이 아니에요. 엑셀에서 'CSV UTF-8'로 다시 저장해 주세요."], notes, info: 'UTF-8 아님' }
  }
  const crlf = decoded.text.includes('\r\n')
  const table = parseCsv(decoded.text)
  const info = `UTF-8, BOM ${decoded.bom ? '있음' : '없음'}, ${crlf ? 'CRLF' : 'LF'}, ${table.length}줄`
  if (table.length === 0) return { rows: [], stops: ['빈 파일이에요.'], notes, info }
  const header = table[0].map((h) => cleanCell(h).value.trim().split(/\s+/)[0]?.toLowerCase() ?? '')
  const col = new Map<string, number>()
  header.forEach((h, i) => {
    if (h && !col.has(h)) col.set(h, i)
  })
  const missing = REQUIRED.filter((c) => !col.has(c))
  if (missing.length) return { rows: [], stops: [`필수 열이 없어요: ${missing.join(', ')}`], notes, info }

  const rows: ImportRow[] = []
  const seen = new Map<string, number>()
  for (let r = 1; r < table.length; r++) {
    const cells = table[r]
    const line = r + 1
    const raw = (name: string) => {
      const i = col.get(name)
      return i === undefined ? undefined : (cells[i] ?? '')
    }
    const key = cleanCell(raw('key') ?? '').value.trim()
    if (!key) continue
    cells.forEach((c, i) => {
      if (SHEET_ERROR.test(cleanCell(c).value.trim())) stops.push(`${line}줄 ${header[i] || `${i + 1}열`}: ${c} — 시트가 수식으로 읽었어요. 칸 앞에 '를 붙여 다시 적어 주세요.`)
    })
    const ja = cleanCell(raw('ja') ?? '', 'ja')
    const fix = cleanCell(raw('ja_fix') ?? '', 'ja')
    if (ja.trimmed || fix.trimmed) notes.push(`${key}: 일본어 앞뒤 공백을 지웠어요`)
    const status = cleanCell(raw('status') ?? '').value.trim()
    const norm = status.toUpperCase() === 'OK' || status.toUpperCase() === 'NG' ? status.toUpperCase() : status
    if (!STATUS_WORDS.has(norm)) stops.push(`${line}줄 ${key}: 모르는 상태 '${status}' (OK, NG, 빈칸, 또는 내보낸 표시 이름)`)
    if (seen.has(key)) stops.push(`${key}: 같은 키가 ${seen.get(key)}줄과 ${line}줄에 있어요`)
    else seen.set(key, line)
    const comment = raw('comment')
    rows.push({
      line,
      key,
      ko: cleanCell(raw('ko') ?? '').value,
      en: cleanCell(raw('en') ?? '').value,
      ja: ja.value,
      ja_fix: fix.value,
      status: norm,
      comment: comment === undefined ? undefined : cleanCell(comment, 'comment').value,
    })
  }
  return { rows, stops, notes, info }
}

/** AI draft result: { "ja": { "ns.key": "…" }, "notes": [...] }. */
export function readJsonDraft(text: string): ReadResult & { aiNotes: unknown[] } {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch (e) {
    return { rows: [], stops: [`JSON을 읽지 못했어요: ${(e as Error).message}`], notes: [], info: 'JSON', aiNotes: [] }
  }
  const ja = (data as { ja?: unknown }).ja
  if (!ja || typeof ja !== 'object' || Array.isArray(ja)) return { rows: [], stops: ['JSON에 "ja" 객체가 없어요.'], notes: [], info: 'JSON', aiNotes: [] }
  const stops: string[] = []
  const notes: string[] = []
  const rows: ImportRow[] = []
  for (const [key, v] of Object.entries(ja as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      stops.push(`${key}: 값이 글자가 아니에요`)
      continue
    }
    const fix = cleanCell(v, 'ja')
    if (fix.trimmed) notes.push(`${key}: 일본어 앞뒤 공백을 지웠어요`)
    rows.push({ line: 0, key, ja: '', ja_fix: fix.value, status: '' })
  }
  const aiNotes = (data as { notes?: unknown }).notes
  return { rows, stops, notes, info: `JSON, ${rows.length}키`, aiNotes: Array.isArray(aiNotes) ? aiNotes : [] }
}

// ------------------------------------------------------------------ the import decision

/** Skip reason for an OK or NG row whose column 6 is empty or not the repo's Japanese now. */
export const STALE_TABLE = '표가 낡았어요. 다시 내보내 주세요(6열 일본어가 저장소의 지금 일본어와 달라 기록하지 않았어요)'

export type ImportState = { entries: ReadonlyMap<string, Entry>; status: StatusFile; today: string }
export type Plan = {
  /** id → new Japanese, or null to drop it. */
  ja: Map<string, string | null>
  status: StatusFile
  textChanged: { key: string; from: string; to: string; how: string }[]
  statusOnly: { key: string; how: string }[]
  unchanged: number
  skips: { key: string; reason: string }[]
  stops: string[]
  notes: string[]
  /** Text outside the string tables: the import writes context.json; a person moves it into these files. */
  manual: { key: string; files: string }[]
  /** Keys of the catalog the table did not have (CSV only). */
  notInTable: string[]
}

function cloneStatus(s: StatusFile): StatusFile {
  return JSON.parse(JSON.stringify(s)) as StatusFile
}

function outsideFiles(e: Entry, ctxOutside: readonly OutsideEntry[] | undefined): string {
  const f = ctxOutside?.find((o) => o.key === e.id)?.files.ja
  return f === undefined ? '번역/context.json' : ([] as string[]).concat(f).join(', ')
}

/**
 * Where a person moves an outside value by hand: `file:line` for each Japanese file of the
 * entry. The line is the first one holding a piece (cut at the placeholders) of the old
 * Japanese, else of the English, else of the Korean; just the file when none is found.
 */
export function outsideLocations(e: Pick<Entry, 'id' | 'ko' | 'en' | 'ja'>, ctxOutside: readonly OutsideEntry[] | undefined, root = ROOT): string {
  const f = ctxOutside?.find((o) => o.key === e.id)?.files.ja
  if (f === undefined) return '번역/context.json'
  const pieces = (s: string | undefined) =>
    (s ?? '')
      .split(/\{\w+\}/)
      .map((p) => p.split('\n')[0])
      .filter((p) => p.trim().length > 0)
  return ([] as string[])
    .concat(f)
    .map((file) => {
      const abs = join(root, file)
      if (!existsSync(abs)) return file
      const lines = readFileSync(abs, 'utf8').split('\n')
      for (const v of [e.ja, e.en, e.ko]) {
        for (const p of pieces(v)) {
          const i = lines.findIndex((l) => l.includes(p))
          if (i >= 0) return `${file}:${i + 1}`
        }
      }
      return file
    })
    .join(', ')
}

/** Problems that stop the whole import when a new Japanese sentence has them. */
export function sentenceProblems(e: Pick<Entry, 'id' | 'ko'>, ja: string): string[] {
  const p: string[] = []
  if (!samePlaceholders(e.ko, ja)) {
    p.push(`${e.id}: 자리표시자가 한국어와 달라요 (한국어: ${placeholders(e.ko).join(' ') || '없음'}, 일본어: ${placeholders(ja).join(' ') || '없음'})`)
  }
  if (hasFullwidthBrace(ja)) p.push(`${e.id}: 전각 괄호 ｛｝가 있어요. 자리표시자는 반각 {이름}이에요`)
  if (HANGUL.test(ja)) p.push(`${e.id}: 일본어에 한글이 있어요`)
  if (ja.includes('\\')) p.push(`${e.id}: 역슬래시가 있어요(줄바꿈은 \\n 두 글자만)`)
  if (e.ko.startsWith('+') && !ja.startsWith('+')) p.push(`${e.id}: 한국어는 +로 시작하는데 일본어는 아니에요(시트가 +를 먹었을 수 있어요)`)
  return p
}

/**
 * Pure: what importing these rows would do (every cell of the status table).
 * Nothing is written here.
 */
export function planImport(state: ImportState, rows: readonly ImportRow[], by: By, record?: string, ctxOutside?: readonly OutsideEntry[]): Plan {
  const plan: Plan = { ja: new Map(), status: cloneStatus(state.status), textChanged: [], statusOnly: [], unchanged: 0, skips: [], stops: [], notes: [], manual: [], notInTable: [] }
  if (by === 'ai-check' && !record) plan.stops.push('--by ai-check에는 --record <교차검사 표.md>가 필요해요')
  const inTable = new Set<string>()
  const fromJson = rows.length > 0 && rows.every((r) => r.ko === undefined)
  for (const row of rows) {
    inTable.add(row.key)
    const e = state.entries.get(row.key)
    if (!e) {
      plan.skips.push({ key: row.key, reason: '없어진 키' })
      continue
    }
    if (row.ko !== undefined && (row.ko !== escapeNl(e.ko.normalize('NFC')) || row.en !== escapeNl(e.en.normalize('NFC')))) {
      plan.skips.push({ key: row.key, reason: '원문이 바뀜, 다시 내보내 검수' })
      continue
    }
    const cur = e.ja
    const mark = row.status === 'OK' ? 'ok' : row.status === 'NG' ? 'ng' : 'same'
    // An OK or NG judges the Japanese the row showed (column 6). It is recorded only when
    // that is exactly the Japanese in the repo now; an empty or older column 6 means the
    // reviewer did not see the current sentence, so nothing is recorded for that row. With no
    // Japanese in the repo (e.g. dropped after export), a non-empty column 6 is equally stale.
    if (row.ko !== undefined && mark !== 'same' && !row.ja_fix && row.ja !== (cur ?? '').normalize('NFC')) {
      plan.skips.push({ key: row.key, reason: `${row.status}: ${STALE_TABLE}` })
      continue
    }
    let next: string | undefined
    if (row.ja_fix) next = row.ja_fix
    else if (row.ko !== undefined && row.ja && row.ja !== (cur ?? '')) {
      next = row.ja
      plan.notes.push(`${e.id}: 6열(ja)을 고친 값을 새 문장으로 받았어요`)
    } else if (row.ko !== undefined && !row.ja && cur !== undefined) {
      plan.notes.push(`${e.id}: 6열(ja)이 비어 있어 무시했어요(지우려면 --drop)`)
    }
    if (next !== undefined && next === cur) next = undefined

    const rec: Rec = plan.status[e.id] ?? {}
    const before = stateOf(e, rec)
    const saveComment = () => {
      if (row.comment === undefined || row.comment === (rec.comment ?? '')) return false
      rec.comment = row.comment
      return true
    }
    const put = () => {
      if (Object.keys(rec).length) plan.status[e.id] = rec
    }

    if (next !== undefined) {
      const problems = sentenceProblems(e, next)
      if (problems.length) {
        plan.stops.push(...problems)
        continue
      }
      if (before === 'human-ok' && by !== 'human') {
        plan.skips.push({ key: e.id, reason: '사람 검수 완료 문장은 AI가 덮지 않아요' })
        continue
      }
      if (mark === 'ok') plan.notes.push(`${e.id}: 새 문장과 OK가 같은 줄에 있어 OK는 버렸어요(바뀌기 전 문장에 대한 판정)`)
      plan.ja.set(e.id, next)
      // Text outside the string tables: context.json gets the value, a person moves it into the file.
      if (e.outside) plan.manual.push({ key: e.id, files: outsideFiles(e, ctxOutside) })
      if (by === 'human') {
        rec.human = { status: 'human-ok', date: state.today, ko: hash12(e.ko), ja: hash12(next) }
        saveComment()
      }
      if (e.safety && by !== 'ai-draft') plan.notes.push(`${e.id}: 안전 키의 문장이 바뀌어 교차검사를 다시 해야 해요`)
      put()
      const after = stateOf({ ...e, ja: next }, rec)
      plan.textChanged.push({ key: e.id, from: cur ?? '', to: next, how: `${STATE_LABEL[before]} → ${STATE_LABEL[after]}` })
      continue
    }

    if (mark !== 'same' && before === 'none') {
      plan.notes.push(`${e.id}: ${row.status}인데 일본어가 없어 무시했어요`)
      plan.unchanged++
      continue
    }
    if (mark === 'ok') {
      if (by === 'ai-draft') plan.unchanged++
      else if (by === 'ai-check') {
        if (!e.safety) {
          plan.notes.push(`${e.id}: 안전 키가 아니라 교차검사 OK는 기록하지 않아요`)
          plan.unchanged++
        } else {
          rec.aiCheck = { date: state.today, ko: hash12(e.ko), ja: hash12(cur!), record: record ?? '' }
          put()
          plan.statusOnly.push({ key: e.id, how: `교차검사 기록 (${record})` })
        }
      } else {
        const commented = saveComment()
        if (before === 'human-ok') {
          if (commented) plan.statusOnly.push({ key: e.id, how: '의견' })
          else plan.unchanged++
        } else {
          rec.human = { status: 'human-ok', date: state.today, ko: hash12(e.ko), ja: hash12(cur!) }
          plan.statusOnly.push({ key: e.id, how: `${STATE_LABEL[before]} → ${STATE_LABEL['human-ok']}${rec.aiCheck ? ' (교차검사 기록 그대로)' : ''}` })
        }
        put()
      }
      continue
    }
    if (mark === 'ng') {
      if (by === 'ai-draft') plan.unchanged++
      else if (by === 'ai-check') {
        if (!e.safety) {
          plan.notes.push(`${e.id}: 안전 키가 아니라 교차검사 NG는 무시했어요`)
          plan.unchanged++
        } else {
          delete rec.aiCheck
          saveComment()
          plan.status[e.id] = rec
          plan.statusOnly.push({ key: e.id, how: '교차검사 NG: 기록 지움' })
        }
      } else {
        rec.human = { status: 'needs-fix', date: state.today, ko: hash12(e.ko), ja: hash12(cur!) }
        saveComment()
        put()
        plan.statusOnly.push({ key: e.id, how: `${STATE_LABEL[before]} → ${STATE_LABEL['needs-fix']}` })
      }
      continue
    }
    // Status cell as exported, no new sentence.
    if (by === 'human' && saveComment()) {
      put()
      plan.statusOnly.push({ key: e.id, how: '의견' })
    } else plan.unchanged++
  }
  if (!fromJson) plan.notInTable = [...state.entries.keys()].filter((k) => !inTable.has(k))
  return plan
}

/** --drop: the key's Japanese and its records go; the comment stays. */
export function planDrop(state: ImportState, keys: readonly string[], ctxOutside?: readonly OutsideEntry[]): Plan {
  const plan: Plan = { ja: new Map(), status: cloneStatus(state.status), textChanged: [], statusOnly: [], unchanged: 0, skips: [], stops: [], notes: [], manual: [], notInTable: [] }
  for (const k of keys) {
    const e = state.entries.get(k)
    if (!e) {
      plan.stops.push(`${k}: 없는 키예요`)
      continue
    }
    if (e.ja === undefined) {
      plan.notes.push(`${k}: 일본어가 이미 없어요`)
      continue
    }
    plan.ja.set(k, null)
    const rec = plan.status[k]
    if (rec) {
      delete rec.aiCheck
      delete rec.human
    }
    if (e.outside) plan.manual.push({ key: k, files: outsideFiles(e, ctxOutside) })
    plan.textChanged.push({ key: k, from: e.ja, to: '', how: '일본어 지움(영어로 보임)' })
  }
  return plan
}

// ------------------------------------------------------------------ applying and writing

/** Every file the import owns, rendered after the plan. Invalid records are dropped here. */
export function renderAfter(cat: Catalog, ctx: Context, plan: Plan): { files: Map<string, string>; dropped: string[] } {
  const files = new Map<string, string>()
  const nextJa = (e: Entry) => (plan.ja.has(e.id) ? (plan.ja.get(e.id) ?? undefined) : e.ja)
  for (const info of cat.namespaces) {
    const ja: Record<string, string | undefined> = {}
    for (const key of info.keys) ja[key] = nextJa(cat.byId.get(`${info.ns}.${key}`)!)
    // Keys the generated file has but Korean does not (typos) are dropped by rendering in Korean order.
    files.set(info.jaFile, renderJaFile(info.keys, ja))
  }
  // context.json is hand-written: it is in the output only when an outside `ja` changes, and then only that value.
  const nextCtx = renderContextAfter(ctx, plan.ja)
  if (nextCtx !== undefined) files.set(CONTEXT_PATH, nextCtx)

  const dropped: string[] = []
  const status = cloneStatus(plan.status)
  for (const id of Object.keys(status)) {
    const e = cat.byId.get(id)
    if (!e) {
      dropped.push(`${id}: 사전에 없는 키의 기록`)
      delete status[id]
      continue
    }
    const now = { ko: e.ko, ja: nextJa(e) }
    const rec = status[id]
    if (rec.aiCheck && !aiCheckValid(now, rec)) {
      dropped.push(`${id}: 교차검사 기록이 지금 값과 어긋나 지움`)
      delete rec.aiCheck
    }
    if (rec.human && !humanValid(now, rec)) {
      dropped.push(`${id}: 검수 기록이 지금 값과 어긋나 지움`)
      delete rec.human
    }
    if (!rec.aiCheck && !rec.human && !rec.comment) delete status[id]
  }
  files.set(STATUS_PATH, renderStatus(status))
  return { files, dropped }
}

/** Files whose content differs from what is under root. */
export function changedFiles(root: string, files: ReadonlyMap<string, string>): string[] {
  return [...files].filter(([p, c]) => !existsSync(join(root, p)) || readFileSync(join(root, p), 'utf8') !== c).map(([p]) => p)
}

/** Writes through a temporary file and a rename. */
export function writeAll(root: string, files: ReadonlyMap<string, string>, paths: readonly string[]): void {
  for (const p of paths) {
    const target = join(root, p)
    mkdirSync(dirname(target), { recursive: true })
    const tmp = `${target}.tmp-${process.pid}`
    writeFileSync(tmp, files.get(p)!)
    renameSync(tmp, target)
  }
}

/** Uncommitted changes in these repo files (a notice, never a block). */
export function dirtyFiles(paths: readonly string[], root = ROOT): string[] {
  if (!paths.length) return []
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--', ...paths], { cwd: root, encoding: 'utf8' })
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3))
  } catch {
    return []
  }
}

// ------------------------------------------------------------------ the whole import (CLI and tests)

export type ImportOptions = {
  by?: By
  record?: string
  write: boolean
  drop?: string[]
  normalize?: boolean
  input?: { name: string; bytes: Uint8Array }
  /** Where files are written (tests point it at a temporary folder). */
  root?: string
  /** Where the --record file is looked up. */
  repoRoot?: string
  today?: string
}
export type ImportResult = { code: 0 | 1; lines: string[]; written: string[] }

export function runImport(cat: Catalog, ctx: Context, status: StatusFile, o: ImportOptions): ImportResult {
  const root = o.root ?? ROOT
  const repoRoot = o.repoRoot ?? ROOT
  const lines: string[] = []
  const state: ImportState = { entries: cat.byId, status, today: o.today ?? today() }
  let plan: Plan
  let head: string
  const preStops: string[] = []
  const preNotes: string[] = []
  let aiNotes: unknown[] = []

  if (o.normalize) {
    plan = planDrop(state, [])
    head = 'i18n-import: --normalize'
  } else if (o.drop?.length) {
    plan = planDrop(state, o.drop, ctx.outside)
    head = `i18n-import: --drop ${o.drop.join(' ')}`
  } else if (o.input) {
    const input = o.input
    const by = o.by
    if (!by) return { code: 1, lines: ['i18n-import: --by ai-draft|ai-check|human 이 필요해요'], written: [] }
    const isJson = o.input.name.toLowerCase().endsWith('.json')
    let read: ReadResult
    if (isJson) {
      if (by !== 'ai-draft') preStops.push('JSON 입력은 --by ai-draft만 받아요')
      let text = ''
      try {
        text = decodeUtf8(o.input.bytes).text
      } catch {
        preStops.push('UTF-8이 아니에요')
      }
      const r = readJsonDraft(text)
      aiNotes = r.aiNotes
      read = r
    } else read = readTable(o.input.bytes)
    preStops.push(...read.stops)
    preNotes.push(...read.notes)
    if (by === 'ai-check' && o.record) {
      const recPath = o.record.split(sep).join('/')
      const abs = resolve(repoRoot, recPath)
      const relRec = rel(abs, repoRoot)
      if (!relRec.startsWith(`${RECORD_DIR}/`)) preStops.push(`--record는 ${RECORD_DIR}/ 아래 파일이어야 해요: ${o.record}`)
      else if (!existsSync(abs)) preStops.push(`--record 파일이 없어요: ${relRec}`)
      else {
        const text = readFileSync(abs, 'utf8')
        const missing = read.rows.filter((r) => r.status === 'OK' && !r.ja_fix && !text.includes(r.key)).map((r) => r.key)
        if (missing.length) preStops.push(`교차검사 표에 없는 키가 OK로 적혀 있어요: ${missing.join(', ')}`)
      }
      o = { ...o, record: relRec }
    }
    plan = planImport(state, read.rows, by, o.record, ctx.outside)
    head = `i18n-import: ${input.name}  (${read.info}, --by ${by})`
  } else {
    return { code: 1, lines: ['i18n-import: 파일, --drop <키>, --normalize 가운데 하나가 필요해요'], written: [] }
  }

  const stops = [...preStops, ...plan.stops]
  const notes = [...preNotes, ...plan.notes]
  const { files, dropped } = renderAfter(cat, ctx, plan)
  const changed = changedFiles(root, files)

  lines.push(head)
  lines.push(`  문장 바뀜 ${plan.textChanged.length}   상태만 바뀜 ${plan.statusOnly.length}   그대로 ${plan.unchanged}   건너뜀 ${plan.skips.length}   멈춤 ${stops.length}`)
  const section = (title: string, items: string[]) => {
    if (!items.length) return
    lines.push(title)
    for (const s of items) lines.push(`  ${s}`)
  }
  section(
    '문장 바뀜',
    plan.textChanged.map((c) => `${c.key}  ${c.from || '(없음)'} → ${c.to || '(없음)'}  ${c.how}`),
  )
  section(
    '상태만 바뀜',
    plan.statusOnly.map((c) => `${c.key}  ${c.how}`),
  )
  section(
    '건너뜀',
    plan.skips.map((s) => `${s.key}  ${s.reason}`),
  )
  if (plan.notInTable.length) {
    const shown = plan.notInTable.slice(0, 20)
    section(`표에 없는 키 ${plan.notInTable.length}`, [shown.join(', ') + (plan.notInTable.length > shown.length ? ' …' : '')])
  }
  section('알림', notes)
  section('지울 기록', dropped)
  section(
    '손으로 옮길 곳',
    plan.manual.map((m) => {
      const e = cat.byId.get(m.key)
      return `${m.key}  ${e ? outsideLocations(e, ctx.outside, repoRoot) : m.files}`
    }),
  )
  if (aiNotes.length)
    section(
      'AI notes (PR 본문에 붙이세요)',
      aiNotes.map((n) => (typeof n === 'string' ? n : JSON.stringify(n))),
    )
  section('바뀔 파일', changed)

  if (stops.length) {
    section('멈춤', stops)
    lines.push('아무것도 쓰지 않았습니다.')
    return { code: 1, lines, written: [] }
  }
  if (!o.write) {
    lines.push('쓰지 않았습니다. 반영하려면 --write를 붙이세요.')
    return { code: 0, lines, written: [] }
  }
  if (root === ROOT) {
    const dirty = dirtyFiles(changed)
    if (dirty.length) lines.push(`알림: 커밋하지 않은 변경이 있는 파일을 다시 씁니다: ${dirty.join(', ')}`)
  }
  writeAll(root, files, changed)
  lines.push(changed.length ? `썼습니다: ${changed.join(', ')}` : '바뀐 파일이 없어 쓰지 않았습니다.')
  lines.push('pnpm check를 돌리세요.')
  return { code: 0, lines, written: changed }
}
