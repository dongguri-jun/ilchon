/**
 * The only way Japanese gets into the repo.
 * Writes the generated ja-strings.ts files, 번역/ja-status.json, and the `ja` of
 * 번역/context.json outside entries; never the hand-written Korean and English.
 * No network, no secrets. Without --write it only shows what would change.
 *
 *   pnpm i18n:import <file.csv|file.json> --by ai-draft|ai-check|human [--record <table.md>] [--write]
 *   pnpm i18n:import --drop room.invNotPayer [--drop …] [--write]
 *   pnpm i18n:import --normalize [--write]
 *
 * --root <folder> writes there instead of the repo (used by check-i18n-table).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadCatalog, readContext, readStatus, runImport, type By } from './i18n/lib'

const argv = process.argv.slice(2)
const flags = new Map<string, string[]>()
const positional: string[] = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--write' || a === '--normalize') flags.set(a, [])
  else if (a.startsWith('--')) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) {
      console.error(`i18n-import: ${a} needs a value`)
      process.exit(1)
    }
    flags.set(a, [...(flags.get(a) ?? []), v])
    i++
  } else positional.push(a)
}
const known = new Set(['--write', '--normalize', '--by', '--record', '--drop', '--root'])
const unknown = [...flags.keys()].filter((f) => !known.has(f))
if (unknown.length) {
  console.error(`i18n-import: unknown option ${unknown.join(', ')}`)
  process.exit(1)
}
const by = flags.get('--by')?.[0]
if (by !== undefined && by !== 'ai-draft' && by !== 'ai-check' && by !== 'human') {
  console.error(`i18n-import: --by is ai-draft, ai-check or human, not '${by}'`)
  process.exit(1)
}
if (positional.length > 1) {
  console.error('i18n-import: one file at a time')
  process.exit(1)
}

const ctx = readContext()
const status = readStatus()
const cat = await loadCatalog(ctx)
const file = positional[0]
const result = runImport(cat, ctx, status, {
  by: by as By | undefined,
  record: flags.get('--record')?.[0],
  write: flags.has('--write'),
  drop: flags.get('--drop'),
  normalize: flags.has('--normalize'),
  input: file ? { name: file, bytes: readFileSync(resolve(file)) } : undefined,
  root: flags.get('--root')?.[0] ? resolve(flags.get('--root')![0]) : undefined,
})
for (const l of result.lines) console.log(l)
process.exit(result.code)
