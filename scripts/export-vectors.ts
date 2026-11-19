/**
 * Writes the reference vectors for the payment and amount rules to spec/vectors/*.json, produced by the
 * implementations in src/. Another implementation of the same rules (the Dart port) must reproduce every case.
 *
 *   pnpm vectors          write the files
 *   pnpm check:vectors    fail when the committed files differ from a fresh export
 *
 * The file format and the tagged values are described in spec/vectors/README.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { bolt11Vectors } from './vectors/bolt11'
import { countCases, render, type VectorFile } from './vectors/kit'
import { moneyVectors } from './vectors/money'
import { onchainVectors } from './vectors/onchain'
import { payVectors } from './vectors/pay'

const DIR = new URL('../spec/vectors/', import.meta.url)

const files: VectorFile[] = [moneyVectors(), onchainVectors(), bolt11Vectors(), payVectors()]

const check = process.argv.includes('--check')
let stale = 0
let total = 0
for (const file of files) {
  const text = render(file)
  const target = new URL(`${file.module}.json`, DIR)
  const cases = countCases(file)
  total += cases
  if (check) {
    const committed = existsSync(target) ? readFileSync(target, 'utf8') : null
    if (committed !== text) {
      stale++
      console.log(`FAIL spec/vectors/${file.module}.json differs from a fresh export`)
    } else console.log(`PASS spec/vectors/${file.module}.json (${cases} cases)`)
  } else {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(target, text)
    console.log(`wrote spec/vectors/${file.module}.json (${cases} cases in ${Object.keys(file.functions).length} functions)`)
  }
}
if (check && stale > 0) {
  console.log(`\n${stale} file(s) out of date: run pnpm vectors and commit the result`)
  process.exitCode = 1
} else console.log(`\n${total} cases`)
