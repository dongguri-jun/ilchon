/**
 * Exports every string as a review table.
 * No network, no secrets.
 *
 *   pnpm i18n:table                       CSV into 번역/out/
 *   pnpm i18n:table --only safety         safety keys only
 *   pnpm i18n:table --json [--ns room]    for AI drafts: JSON on stdout, no file. Carries the
 *                                         glossary (TONE, TERMS, AVOID) and the per-key rows
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { aiInput, buildRows, commit7, loadCatalog, OUT_DIR, readContext, readStatus, ROOT, tableCsv } from './i18n/lib'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const json = process.argv.includes('--json')
const only = arg('--only')
const ns = arg('--ns')
if (only !== undefined && only !== 'safety') {
  console.error(`i18n-table: --only takes 'safety', not '${only}'`)
  process.exit(1)
}

const ctx = readContext()
const status = readStatus()
const cat = await loadCatalog(ctx)
if (ns && !cat.entries.some((e) => e.ns === ns)) {
  console.error(`i18n-table: no namespace '${ns}' (${[...new Set(cat.entries.map((e) => e.ns))].join(', ')})`)
  process.exit(1)
}
const opts = { onlySafety: only === 'safety', ns }

if (json) {
  process.stdout.write(JSON.stringify(aiInput(cat, ctx, status, opts), null, 2) + '\n')
} else {
  const rows = buildRows(cat, ctx, status, opts)
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const suffix = `${only ? `-${only}` : ''}${ns ? `-${ns}` : ''}`
  const name = `ilchon-ja-${commit7()}-${ymd}${suffix}.csv`
  mkdirSync(join(ROOT, OUT_DIR), { recursive: true })
  writeFileSync(join(ROOT, OUT_DIR, name), tableCsv(rows))
  const safety = rows.filter((r) => r.safety).length
  const withJa = rows.filter((r) => r.ja).length
  console.log(`i18n-table: ${OUT_DIR}/${name}`)
  console.log(`  ${rows.length}줄 (안전 키 ${safety}, 일본어 있음 ${withJa}, 없음 ${rows.length - withJa})`)
  console.log('  HTML 검수 페이지는 아직 없습니다.')
}
