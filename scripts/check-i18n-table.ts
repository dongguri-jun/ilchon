/**
 * Table checks 1 to 9 for the translation table scripts.
 * No network. Writes only into a fs.mkdtemp folder. Run: pnpm check:i18n-table
 *
 *   1 CSV round trip, bytes (BOM, CRLF, every cell quoted)
 *   2 shapes other programs write (no BOM, LF, unquoted, '+), Shift_JIS, #ERROR!, a lost +
 *   3 export then import with no edits: nothing changes, and a full write is byte-equal;
 *     context.json is written only when an outside ja changes, and only that value
 *   4 renderJaFile output imports back to the same values
 *   5 stops: exit code 1 and nothing written
 *   6 skips: missing key, changed Korean, AI over a human-reviewed sentence
 *   7 every cell of the status table through planImport
 *   8 fingerprints and the T8 rule; --drop clears it
 *   9 the AI input carries the glossary; outside rows name file:line to move by hand
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  aiCheckValid,
  aiInput,
  buildRows,
  cleanCell,
  COLUMNS,
  CONTEXT_PATH,
  decodeUtf8,
  escapeNl,
  guardCell,
  hash12,
  loadCatalog,
  outsideLocations,
  parseCsv,
  planDrop,
  planImport,
  readContext,
  readStatus,
  readTable,
  RECORD_DIR,
  renderContextAfter,
  renderJaFile,
  ROOT,
  runImport,
  stateOf,
  STATUS_PATH,
  t8,
  tableCsv,
  writeCsv,
  type By,
  type ColumnName,
  type Context,
  type Entry,
  type ImportRow,
  type ImportState,
  type Plan,
  type StatusFile,
} from './i18n/lib'
import { AVOID, TERMS, TONE } from './i18n-glossary'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS ${name}`)
  else {
    failed++
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const enc = new TextEncoder()
const tmp = mkdtempSync(join(tmpdir(), 'ilchon-i18n-table-'))
const ctx = readContext()
const status = readStatus()
const cat = await loadCatalog(ctx)

/** A CSV the way a person might return it: the given columns only, real ko/en unless set. */
function sheet(rows: (Partial<Record<ColumnName, string>> & { key: string })[]): Uint8Array {
  const cols = COLUMNS.map(([c]) => c)
  const body = rows.map((r) => {
    const e = cat.byId.get(r.key)
    const full: Record<string, string> = { ko: e ? escapeNl(e.ko) : '', en: e ? escapeNl(e.en) : '', ja: e?.ja ? escapeNl(e.ja) : '', ...r }
    return cols.map((c) => guardCell(full[c] ?? ''))
  })
  return enc.encode(writeCsv([COLUMNS.map(([, h]) => h), ...body]))
}

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else out.set(p, readFileSync(p, 'utf8'))
    }
  }
  walk(dir)
  return out
}
const sameSnapshot = (a: Map<string, string>, b: Map<string, string>) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)

try {
  // ------------------------------------------------------------ 1 CSV round trip
  {
    const values = ['He said "hi"', 'a,b', '+1万', '+1만', '=SUM(A1)', '-5%', '@name', 'one\ntwo\nthree', '', '’', '｛amount｝', '🙂🇯🇵 ok']
    const text = writeCsv([['ko', 'ja', 'comment'], ...values.map((v) => [guardCell(escapeNl(v)), guardCell(escapeNl(v)), guardCell(escapeNl(v))])])
    const bytes = enc.encode(text)
    check('1 CSV starts with the UTF-8 BOM', bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    const body = text.slice(1)
    const lines = body.split('\r\n')
    check('1 CSV lines end in CRLF, no bare LF', body.endsWith('\r\n') && !body.replace(/\r\n/g, '').includes('\n'))
    check(
      '1 CSV every cell quoted',
      lines.slice(0, -1).every((l) => /^"(?:[^"]|"")*"(?:,"(?:[^"]|"")*")*$/.test(l)),
    )
    check('1 CSV formula starts get a leading quote', body.includes(`"'+1万"`) && body.includes(`"'=SUM(A1)"`) && body.includes(`"'-5%"`) && body.includes(`"'@name"`))
    const parsed = parseCsv(decodeUtf8(bytes).text)
    const bad: string[] = []
    values.forEach((v, i) => {
      const [ko, ja, comment] = parsed[i + 1] ?? []
      if (cleanCell(ko ?? '').value !== escapeNl(v)) bad.push(`ko ${JSON.stringify(v)} → ${JSON.stringify(ko)}`)
      if (cleanCell(ja ?? '', 'ja').value !== v) bad.push(`ja ${JSON.stringify(v)}`)
      if (cleanCell(comment ?? '', 'comment').value !== v) bad.push(`comment ${JSON.stringify(v)}`)
    })
    check(`1 CSV round trip of ${values.length} values`, bad.length === 0 && parsed.length === values.length + 1, bad.join('; '))
  }

  // ------------------------------------------------------------ 2 other programs' shapes
  {
    const e = cat.byId.get('board.addJPY0')!
    const text = `key,ko,en,ja,ja_fix,status,comment\nboard.addJPY0,'+1만,'+10K,,'+1万,,"line\r\nbreak"\n`
    const r = readTable(enc.encode(text))
    const row = r.rows[0]
    check('2 no BOM, LF, unquoted cells read', r.stops.length === 0 && r.rows.length === 1 && r.info.includes('BOM 없음'), r.stops.join('; '))
    check("2 '+1만 and '+10K read as the Korean and English values", row?.ko === e.ko && row?.en === e.en)
    check("2 '+1万 reads as +1万", row?.ja_fix === '+1万')
    check('2 CRLF inside a quoted cell becomes a line break', row?.comment === 'line\nbreak')
    // As before any Japanese is in (the repo may already hold +1万 for this key).
    const noJa = new Map([[e.id, { ...e, ja: undefined }]])
    const plan = planImport({ entries: noJa, status: {}, today: '2026-11-13' }, r.rows, 'ai-draft')
    check('2 that row is a new sentence, no stop, no skip', plan.textChanged.length === 1 && plan.stops.length === 0 && plan.skips.length === 0)

    const exported = readTable(enc.encode(tableCsv(buildRows(cat, ctx, status))))
    // i18n-table 5.4 counted 16 lines in board/strings.ts (8 Korean + 8 English); with yen there are 12 keys.
    const plusKeys = cat.entries.filter((x) => x.ko.startsWith('+') || x.en.startsWith('+')).length
    const plusRows = exported.rows.filter((x) => x.ko?.startsWith('+') || x.en?.startsWith('+'))
    const p2 = planImport({ entries: cat.byId, status, today: '2026-11-13' }, exported.rows, 'human')
    const plusSkipped = p2.skips.filter((s) => cat.byId.get(s.key)?.ko.startsWith('+'))
    check(`2 the ${plusRows.length} rows whose Korean or English starts with + survive the round trip`, plusKeys >= 8 && plusRows.length === plusKeys && plusSkipped.length === 0)

    // 日本 in Shift_JIS.
    const sjis = new Uint8Array([...enc.encode('key,ko,en,ja,ja_fix,status\nboard.addJPY0,a,b,'), 0x93, 0xfa, 0x96, 0x7b, 0x0a])
    const rs = readTable(sjis)
    check('2 Shift_JIS stops with the save-as-UTF-8 message', rs.stops.length === 1 && rs.stops[0].includes('CSV UTF-8'))
    for (const err of ['#NAME?', '#ERROR!']) {
      const res = runImport(cat, ctx, status, { by: 'ai-draft', write: false, input: { name: 'x.csv', bytes: sheet([{ key: 'board.addJPY0', ja_fix: err }]) } })
      check(`2 ja_fix ${err} stops`, res.code === 1 && res.lines.some((l) => l.includes('수식')))
    }
    const lost = runImport(cat, ctx, status, { by: 'ai-draft', write: false, input: { name: 'x.csv', bytes: sheet([{ key: 'board.addJPY0', ja_fix: '1万' }]) } })
    check('2 ko +1만 with new ja 1万 stops', lost.code === 1 && lost.lines.some((l) => l.includes('+로 시작')))
  }

  // ------------------------------------------------------------ 3 round trip without edits
  const full = join(tmp, 'full')
  {
    const csv = enc.encode(tableCsv(buildRows(cat, ctx, status)))
    const dry = runImport(cat, ctx, status, { by: 'human', write: false, input: { name: 'roundtrip.csv', bytes: csv } })
    const counts = dry.lines[1] ?? ''
    check('3 export → import --by human: nothing changes, nothing stops', dry.code === 0 && /문장 바뀜 0\s+상태만 바뀜 0\s+그대로 \d+\s+건너뜀 0\s+멈춤 0/.test(counts), counts)
    const wrote = runImport(cat, ctx, status, { by: 'human', write: true, root: full, input: { name: 'roundtrip.csv', bytes: csv } })
    // context.json is hand-written and the import touches it only when an outside `ja` changes (5.2, 지키는 약속).
    check('3 a round trip without edits leaves 번역/context.json out of the files to write', !wrote.written.includes(CONTEXT_PATH))
    const expected = [...cat.namespaces.map((n) => n.jaFile), STATUS_PATH]
    const differ = expected.filter((p) => {
      try {
        return readFileSync(join(full, p), 'utf8') !== readFileSync(join(ROOT, p), 'utf8')
      } catch {
        return true
      }
    })
    check(
      `3 a full write into a temporary folder is byte-equal to the repo (${expected.length} files)`,
      wrote.code === 0 && wrote.written.length === expected.length && differ.length === 0,
      differ.join(', '),
    )
    const again = runImport(cat, ctx, status, { by: 'human', write: true, root: full, input: { name: 'roundtrip.csv', bytes: csv } })
    check('3 importing the same table twice writes nothing the second time', again.code === 0 && again.written.length === 0)
    const norm = runImport(cat, ctx, status, { write: false, normalize: true })
    check('3 --normalize finds nothing to change in the repo', norm.code === 0 && !norm.lines.includes('바뀔 파일'))
  }

  // ------------------------------------------------------------ 3 context.json keeps its hand-written layout
  {
    const o = ctx.outside[0]
    // A layout other than JSON.stringify: one line per entry, an extra top-level field, no final newline.
    const entry = (x: typeof o) => JSON.stringify({ ...x, ja: x.ja })
    const text =
      `{ "_memo": "손으로 쓴 메모",\n  "screens": ${JSON.stringify(ctx.screens)},\n  "keys": ${JSON.stringify(ctx.keys)},\n` +
      `  "outside": [\n${ctx.outside.map((x) => `    ${entry(x)}`).join(',\n')}\n  ] }`
    const hand: Context = { ...ctx, text }
    const quiet = renderContextAfter(hand, new Map([[o.key, o.ja]]))
    check('3 context.json: an unchanged outside value gives no file to write', quiet === undefined)
    const next = renderContextAfter(hand, new Map([[o.key, '新しい "文"']]))
    const want = text.replace(entry(o), entry({ ...o, ja: '新しい "文"' }))
    check('3 context.json: a changed outside ja replaces only that value, every other byte kept', next === want && next !== text)
    const parsed = next === undefined ? undefined : (JSON.parse(next) as { _memo?: string; outside: { ja: string | null }[] })
    check('3 context.json: unknown top-level fields survive', parsed?._memo === '손으로 쓴 메모' && parsed.outside[0].ja === '新しい "文"')
    const cleared = renderContextAfter(hand, new Map([[o.key, null]]))
    check('3 context.json: --drop writes null into that value only', cleared === text.replace(entry(o), entry({ ...o, ja: null })))
  }

  // ------------------------------------------------------------ 4 renderJaFile
  {
    const LS = String.fromCharCode(0x2028)
    const PS = String.fromCharCode(0x2029)
    const ja: Record<string, string> = { plain: 'かな', 'err.dot': "it’s 'quoted'", back: 'a\\b', nl: '一\n二', ls: `p${LS}q`, ps: `r${PS}s`, $ok: '{amount}円' }
    const order = ['plain', 'missing', 'err.dot', 'back', 'nl', 'ls', 'ps', '$ok']
    const text = renderJaFile(order, ja)
    const file = join(tmp, 'render-ja-strings.ts')
    writeFileSync(file, text)
    const mod = (await import(pathToFileURL(file).href)) as { ja: Record<string, string> }
    check('4 renderJaFile imports back to the same values', JSON.stringify(mod.ja) === JSON.stringify(ja), JSON.stringify(mod.ja))
    check('4 renderJaFile keeps no raw line or paragraph separator', !text.includes(LS) && !text.includes(PS))
    check('4 renderJaFile quotes only keys that are not identifiers', text.includes("  'err.dot': ") && text.includes('  plain: ') && text.includes('  $ok: '))
    check('4 renderJaFile of nothing is the empty object', renderJaFile(order, {}).endsWith('export const ja: Record<string, string> = {}\n'))
  }

  // ------------------------------------------------------------ 5 stops write nothing
  {
    const before = snapshot(full)
    const recRoot = join(tmp, 'repo')
    mkdirSync(join(recRoot, RECORD_DIR), { recursive: true })
    writeFileSync(join(recRoot, RECORD_DIR, 'ja-safety-test.md'), '| room.invNotPayer | … | 같음 |\n')
    const cases: { name: string; by: By; record?: string; bytes: Uint8Array; want: string }[] = [
      { name: 'placeholder removed', by: 'ai-draft', bytes: sheet([{ key: 'room.doneNotice2', ja_fix: '振込名義を確認してください。' }]), want: '자리표시자' },
      { name: 'full-width braces', by: 'ai-draft', bytes: sheet([{ key: 'room.doneNotice2', ja_fix: '｛name｝さんの振込名義を確認してください。' }]), want: '전각 괄호' },
      { name: 'Hangul', by: 'ai-draft', bytes: sheet([{ key: 'ui.confirm', ja_fix: '確認 확인' }]), want: '한글' },
      { name: 'backslash', by: 'ai-draft', bytes: sheet([{ key: 'ui.confirm', ja_fix: '確認\\t' }]), want: '역슬래시' },
      { name: 'same key twice', by: 'human', bytes: sheet([{ key: 'ui.confirm' }, { key: 'ui.confirm' }]), want: '같은 키' },
      { name: 'unknown status', by: 'human', bytes: sheet([{ key: 'ui.confirm', status: 'maybe' }]), want: '모르는 상태' },
      { name: 'ai-check without --record', by: 'ai-check', bytes: sheet([{ key: 'room.invNotPayer', status: 'OK' }]), want: '--record' },
      { name: 'record outside the record folder', by: 'ai-check', record: 'README.md', bytes: sheet([{ key: 'room.invNotPayer', status: 'OK' }]), want: '아래 파일' },
      { name: 'key not in the record', by: 'ai-check', record: `${RECORD_DIR}/ja-safety-test.md`, bytes: sheet([{ key: 'room.sellPay', status: 'OK' }]), want: '교차검사 표에 없는 키' },
      { name: 'missing column', by: 'human', bytes: enc.encode('key,ko,en,ja,status\nui.confirm,확인,OK,,\n'), want: '필수 열' },
    ]
    for (const c of cases) {
      const res = runImport(cat, ctx, status, { by: c.by, record: c.record, write: true, root: full, repoRoot: recRoot, input: { name: 'x.csv', bytes: c.bytes } })
      check(
        `5 stop: ${c.name}`,
        res.code === 1 && res.written.length === 0 && res.lines.some((l) => l.includes(c.want)),
        res.lines
          .filter((l) => l.startsWith('  '))
          .slice(-2)
          .join(' | '),
      )
    }
    check('5 the temporary folder is unchanged after every stop', sameSnapshot(before, snapshot(full)))
    const json = runImport(cat, ctx, status, { by: 'human', write: false, input: { name: 'x.json', bytes: enc.encode('{"ja":{"ui.confirm":"確認"}}') } })
    check('5 JSON input with --by other than ai-draft stops', json.code === 1)
    const okJson = runImport(cat, ctx, status, { by: 'ai-draft', write: false, input: { name: 'x.json', bytes: enc.encode('{"ja":{"ui.confirm":"確認（試験）"},"notes":["n1"]}') } })
    check('5 JSON ai-draft input plans one new sentence and prints the notes', okJson.code === 0 && /문장 바뀜 1/.test(okJson.lines[1] ?? '') && okJson.lines.some((l) => l.includes('n1')))
  }

  // ------------------------------------------------------------ synthetic state for 6 to 8
  const KO = '{a} 확인'
  const EN = 'check {a}'
  const mk = (id: string, ja: string | undefined, safe: boolean): Entry => ({ id, ns: 't', key: id.slice(2), ko: KO, en: EN, ja, outside: false, safety: safe ? 'payment-steps' : undefined })
  const entries = new Map<string, Entry>(
    [
      mk('t.none', undefined, false),
      mk('t.noneSafe', undefined, true),
      mk('t.draft', '{a}を確認', false),
      mk('t.safeDraft', '{a}を確認', true),
      mk('t.checked', '{a}を確認', true),
      mk('t.fix', '{a}を確認', false),
      mk('t.ok', '{a}を確認', false),
      mk('t.okSafe', '{a}を確認', true),
    ].map((e) => [e.id, e]),
  )
  const H = { ko: hash12(KO), ja: hash12('{a}を確認') }
  const REC = `${RECORD_DIR}/ja-safety-test.md`
  const baseStatus = (): StatusFile => ({
    't.checked': { aiCheck: { date: '2026-11-01', ...H, record: REC } },
    't.fix': { human: { status: 'needs-fix', date: '2026-11-01', ...H }, comment: 'old' },
    't.ok': { human: { status: 'human-ok', date: '2026-11-01', ...H } },
    't.okSafe': { human: { status: 'human-ok', date: '2026-11-01', ...H } },
  })
  const state = (): ImportState => ({ entries, status: baseStatus(), today: '2026-11-13' })
  const row = (key: string, r: Partial<ImportRow>): ImportRow => ({ line: 2, key, ko: escapeNl(KO), en: EN, ja: entries.get(key)?.ja ?? '', ja_fix: '', status: '', comment: undefined, ...r })
  const plan1 = (key: string, r: Partial<ImportRow>, by: By): Plan => planImport(state(), [row(key, r)], by, by === 'ai-check' ? REC : undefined)
  const NEW = '{a}をご確認ください'

  // ------------------------------------------------------------ 6 skips
  {
    const p = planImport(state(), [row('t.gone', {})], 'human')
    check('6 a key no longer in the tables is skipped', p.skips.length === 1 && p.skips[0].reason === '없어진 키')
    const q = planImport(state(), [row('t.draft', { ko: '{a} 다른 문장', ja_fix: NEW })], 'human')
    check('6 a row whose Korean changed is skipped', q.skips.length === 1 && q.skips[0].reason.startsWith('원문이 바뀜') && q.ja.size === 0)
    for (const by of ['ai-draft', 'ai-check'] as By[]) {
      const s = plan1('t.ok', { ja_fix: NEW }, by)
      check(`6 --by ${by} does not overwrite a human-ok sentence`, s.skips.length === 1 && s.ja.size === 0)
    }
    const full = planImport(state(), [row('t.draft', {})], 'human')
    check('6 keys missing from the table are listed', full.notInTable.length === entries.size - 1)
  }

  // ------------------------------------------------------------ 7 every cell of the status table
  {
    const results: [string, boolean][] = []
    const t = (name: string, ok: boolean) => results.push([name, ok])
    // Row 1: new sentence, state none / ai-draft / ai-checked / needs-fix.
    for (const key of ['t.none', 't.draft', 't.checked', 't.fix']) {
      const d = plan1(key, { ja_fix: NEW }, 'ai-draft')
      t(`new/${key}/ai-draft writes`, d.ja.get(key) === NEW && !d.status[key]?.human?.status?.startsWith('human-ok'))
      const c = plan1(key, { ja_fix: NEW }, 'ai-check')
      t(`new/${key}/ai-check writes${entries.get(key)!.safety ? ', warns' : ''}`, c.ja.get(key) === NEW && (!entries.get(key)!.safety || c.notes.some((n) => n.includes('교차검사'))))
      const h = plan1(key, { ja_fix: NEW }, 'human')
      t(`new/${key}/human writes human-ok`, h.ja.get(key) === NEW && h.status[key]?.human?.status === 'human-ok' && h.status[key]?.human?.ja === hash12(NEW))
    }
    // Row 2: new sentence over human-ok.
    t('new/human-ok/ai-draft skipped', plan1('t.ok', { ja_fix: NEW }, 'ai-draft').skips.length === 1)
    t('new/human-ok/ai-check skipped', plan1('t.ok', { ja_fix: NEW }, 'ai-check').skips.length === 1)
    const h2 = plan1('t.ok', { ja_fix: NEW }, 'human')
    t('new/human-ok/human writes human-ok', h2.ja.get('t.ok') === NEW && h2.status['t.ok']?.human?.ja === hash12(NEW))
    // Row 3: OK, state none.
    for (const by of ['ai-draft', 'ai-check', 'human'] as By[]) {
      const p = plan1('t.noneSafe', { status: 'OK' }, by)
      t(`OK/none/${by} ignored with a notice`, p.ja.size === 0 && !p.status['t.noneSafe'] && p.notes.length === 1)
    }
    // Row 4: OK, other states.
    const a4 = plan1('t.safeDraft', { status: 'OK' }, 'ai-draft')
    t('OK/other/ai-draft ignored', a4.statusOnly.length === 0 && !a4.status['t.safeDraft'])
    const c4 = plan1('t.safeDraft', { status: 'OK' }, 'ai-check')
    t('OK/other/ai-check records aiCheck on a safety key', c4.status['t.safeDraft']?.aiCheck?.record === REC && c4.status['t.safeDraft']?.aiCheck?.ja === H.ja)
    const c4b = plan1('t.draft', { status: 'OK' }, 'ai-check')
    t('OK/other/ai-check ignores a key that is not a safety key, with a notice', !c4b.status['t.draft'] && c4b.notes.length === 1)
    const h4 = plan1('t.checked', { status: 'OK' }, 'human')
    t('OK/other/human makes human-ok and keeps aiCheck', h4.status['t.checked']?.human?.status === 'human-ok' && !!h4.status['t.checked']?.aiCheck)
    // Row 5: NG, state none.
    for (const by of ['ai-draft', 'ai-check', 'human'] as By[]) {
      const p = plan1('t.noneSafe', { status: 'NG' }, by)
      t(`NG/none/${by} ignored with a notice`, !p.status['t.noneSafe'] && p.notes.length === 1)
    }
    // Row 6: NG, other states.
    const a6 = plan1('t.checked', { status: 'NG' }, 'ai-draft')
    t('NG/other/ai-draft ignored', !!a6.status['t.checked']?.aiCheck && a6.statusOnly.length === 0)
    const c6 = plan1('t.checked', { status: 'NG', comment: 'weaker' }, 'ai-check')
    t('NG/other/ai-check drops aiCheck, keeps the comment', !c6.status['t.checked']?.aiCheck && c6.status['t.checked']?.comment === 'weaker')
    const h6 = plan1('t.draft', { status: 'NG', comment: 'odd' }, 'human')
    t('NG/other/human makes needs-fix with the comment', h6.status['t.draft']?.human?.status === 'needs-fix' && h6.status['t.draft']?.comment === 'odd')
    // Row 7: status as exported, no new sentence.
    for (const by of ['ai-draft', 'ai-check', 'human'] as By[]) {
      const p = plan1('t.fix', { status: 'AI 초안 / AI下書き' }, by)
      t(`same/${by} unchanged`, p.unchanged === 1 && p.ja.size === 0 && JSON.stringify(p.status) === JSON.stringify(baseStatus()))
    }
    const c7 = plan1('t.fix', { status: '수정 필요 / 要修正', comment: 'new comment' }, 'human')
    t('same/human saves a changed comment only', c7.status['t.fix']?.comment === 'new comment' && c7.status['t.fix']?.human?.status === 'needs-fix' && c7.ja.size === 0)
    // New sentence and OK on one row: the sentence wins.
    const both = plan1('t.safeDraft', { ja_fix: NEW, status: 'OK' }, 'ai-check')
    t('new sentence + OK: sentence written, OK dropped with a notice', both.ja.get('t.safeDraft') === NEW && !both.status['t.safeDraft']?.aiCheck && both.notes.some((n) => n.includes('OK는 버렸')))
    const bad = results.filter(([, ok]) => !ok).map(([n]) => n)
    check(`7 status table: ${results.length} cases`, bad.length === 0, bad.join('; '))

    // OK and NG judge what column 6 showed. Empty or older column 6: nothing recorded, "표가 낡았어요".
    const OLD = '{a}の確認'
    const stale: [string, boolean][] = []
    const s = (name: string, ok: boolean) => stale.push([name, ok])
    const untouched = (p: Plan, key: string) =>
      p.ja.size === 0 && JSON.stringify(p.status[key]) === JSON.stringify(baseStatus()[key]) && p.skips.length === 1 && p.skips[0].reason.includes('표가 낡았어요')
    for (const [what, ja] of [
      ['older', OLD],
      ['empty', ''],
    ] as const) {
      s(`OK/${what} column 6/human records no human-ok`, untouched(plan1('t.draft', { status: 'OK', ja }, 'human'), 't.draft'))
      s(`NG/${what} column 6/human records no needs-fix`, untouched(plan1('t.draft', { status: 'NG', ja }, 'human'), 't.draft'))
      s(`OK/${what} column 6/ai-check on a safety key records no aiCheck`, untouched(plan1('t.safeDraft', { status: 'OK', ja }, 'ai-check'), 't.safeDraft'))
      s(`NG/${what} column 6/ai-check keeps the old aiCheck`, untouched(plan1('t.checked', { status: 'NG', ja }, 'ai-check'), 't.checked'))
    }
    // No Japanese in the repo (dropped after export) but column 6 still holds the old sentence:
    // the old sentence must not come back, and no record is stamped.
    for (const st of ['OK', 'NG'] as const) {
      for (const by of ['human', 'ai-check'] as By[]) {
        const p = plan1('t.noneSafe', { status: st, ja: OLD }, by)
        s(`${st}/no Japanese, old column 6/${by} imports nothing`, untouched(p, 't.noneSafe') && !p.status['t.noneSafe'] && p.textChanged.length === 0)
      }
    }
    // A stale table for a safety key whose aiCheck is for an older sentence: OK must not refresh it.
    const oldCheck: StatusFile = { 't.safeDraft': { aiCheck: { date: '2026-11-01', ko: H.ko, ja: hash12(OLD), record: REC } } }
    const refreshed = planImport({ entries, status: oldCheck, today: '2026-11-13' }, [row('t.safeDraft', { status: 'OK', ja: OLD })], 'ai-check', REC)
    s(
      'OK/older column 6/ai-check leaves a stale aiCheck stale',
      refreshed.status['t.safeDraft']?.aiCheck?.ja === hash12(OLD) && !aiCheckValid(entries.get('t.safeDraft')!, refreshed.status['t.safeDraft']),
    )
    const fresh = plan1('t.safeDraft', { status: 'OK', ja: '{a}を確認' }, 'ai-check')
    s('OK/current column 6/ai-check still records', fresh.status['t.safeDraft']?.aiCheck?.ja === H.ja && fresh.skips.length === 0)
    // Through the whole import, on a repo key that has Japanese (none before the first draft).
    const withJa = cat.entries.find((x) => x.ja !== undefined && !x.outside)
    if (withJa) {
      const viaRun = runImport(cat, ctx, status, { by: 'human', write: false, input: { name: 'x.csv', bytes: sheet([{ key: withJa.id, status: 'OK', ja: `${withJa.ja}（古い）` }]) } })
      s('OK/stale row via runImport prints the re-export line', viaRun.lines.some((l) => l.includes(withJa.id) && l.includes('표가 낡았어요')) && /상태만 바뀜 0/.test(viaRun.lines[1] ?? ''))
    }
    const badStale = stale.filter(([, ok]) => !ok).map(([n]) => n)
    check(`7 stale table rows record nothing: ${stale.length} cases`, badStale.length === 0, badStale.join('; '))
  }

  // ------------------------------------------------------------ 8 fingerprints and T8
  {
    const st = baseStatus()
    const checked = entries.get('t.checked')!
    check('8 a matching aiCheck is valid', aiCheckValid(checked, st['t.checked']) && stateOf(checked, st['t.checked']) === 'ai-checked')
    check('8 changed Korean makes aiCheck invalid', !aiCheckValid({ ...checked, ko: '{a} 바뀐 원문' }, st['t.checked']))
    check('8 changed Japanese makes aiCheck invalid', !aiCheckValid({ ...checked, ja: '{a}を確認する' }, st['t.checked']))
    const list = [...entries.values()]
    const off = t8('off', list, st)
    check('8 T8 off: only warnings', off.fails.length === 0 && off.warns.length === 2, off.warns.join(', '))
    for (const stage of ['beta', 'reviewed'] as const) {
      const r = t8(stage, list, st)
      check(
        `8 T8 ${stage}: a safety key with Japanese and no aiCheck fails, human-ok alone does not pass`,
        r.fails.length === 2 && r.fails.some((f) => f.startsWith('t.safeDraft')) && r.fails.some((f) => f.startsWith('t.okSafe')),
        r.fails.join(', '),
      )
    }
    const drifted = t8('beta', [{ ...checked, ja: '{a}を確認する' }], st)
    check('8 T8 beta: a drifted aiCheck fails', drifted.fails.length === 1 && drifted.fails[0].includes('어긋남'))
    const drop = planDrop({ entries, status: st, today: '2026-11-13' }, ['t.safeDraft', 't.okSafe'])
    const after = list.map((e) => (drop.ja.has(e.id) ? { ...e, ja: drop.ja.get(e.id) ?? undefined } : e))
    check('8 after --drop the T8 beta rule passes', t8('beta', after, drop.status).fails.length === 0 && !drop.status['t.okSafe']?.human)
  }

  // ------------------------------------------------------------ 9 AI input and hand-moved outside text
  {
    const input = aiInput(cat, ctx, status, { ns: 'ui' })
    check(
      '9 --json carries TONE, TERMS and AVOID of scripts/i18n-glossary.ts',
      input.glossary.tone === TONE && input.glossary.terms === TERMS && input.glossary.avoid === AVOID && TERMS.some((t) => t.ja === 'イルチョン'),
    )
    check('9 --json --ns ui has only ui keys', input.keys.length > 0 && input.keys.every((k) => k.key.startsWith('ui.')))
    const bad: string[] = []
    for (const o of ctx.outside) {
      const e = cat.byId.get(o.key)!
      const loc = outsideLocations(e, ctx.outside)
      const files = ([] as string[]).concat(o.files.ja)
      if (!files.every((f) => new RegExp(`${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+`).test(loc))) bad.push(`${o.key} → ${loc}`)
    }
    check(`9 every outside entry (${ctx.outside.length}) gets file:line to move by hand`, bad.length === 0, bad.join('; '))
    // Each hand-moved outside entry: the line named for it holds its Japanese (the system
    // lines moved into the room table, so the crash title stands in for them).
    const first = ctx.outside.find((o) => o.key === '_outside.crash.title')
    if (first) {
      const e = cat.byId.get(first.key)!
      const loc = outsideLocations(e, ctx.outside)
      const m = /^(.*):(\d+)$/.exec(loc)
      const text = m ? (readFileSync(join(ROOT, m[1]), 'utf8').split('\n')[Number(m[2]) - 1] ?? '') : ''
      check('9 the line named for _outside.crash.title holds its Japanese', !!e.ja && text.includes(e.ja), loc)
    } else check('9 the outside entry _outside.crash.title exists', false)
    const res = runImport(cat, ctx, status, { by: 'ai-draft', write: false, input: { name: 'x.json', bytes: enc.encode(JSON.stringify({ ja: { '_outside.crash.reload': '再読込' } })) } })
    check(
      '9 an outside row in the import prints 손으로 옮길 곳 with file:line',
      res.lines.some((l) => l.includes('_outside.crash.reload') && /crash-copy\.ts:\d+/.test(l)),
    )
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
if (failed) process.exit(1)
