/**
 * The shipped build holds no development shortcut:
 * neither the lock-free module (src/lib/vault/no-lock.ts) nor the plain test storage
 * (src/lib/store/plain.ts). Looks for their markers in every .js and .html under dist/.
 * Also: no inline script, inline event handler or
 * javascript: URL in the HTML, no eval, Function constructor, string timer or WebAssembly in
 * the scripts (script-src 'self' without 'unsafe-inline' or 'unsafe-eval' must not break the
 * app), and dist/_headers is public/_headers.
 * Runs at the end of `pnpm build`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { evalProblems, inlineProblems } from './csp-lib'

const MARKERS = ['ilchon-no-lock-dev-only', 'ilchon-plain-storage-test-only']
const root = process.argv[2] ?? 'dist'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? files(p) : /\.(js|mjs|html)$/.test(name) ? [p] : []
  })
}

let all: string[]
try {
  all = files(root)
} catch {
  console.log(`FAIL  check-dist: no ${root}/ (run vite build first)`)
  process.exit(1)
}
const found: string[] = []
for (const f of all) {
  const text = readFileSync(f, 'utf8')
  for (const m of MARKERS) if (text.includes(m)) found.push(`${f}: ${m}`)
}
if (all.length === 0) {
  console.log(`FAIL  check-dist: ${root}/ has no .js or .html file`)
  process.exit(1)
}
if (found.length) {
  console.log(`FAIL  check-dist: development shortcuts in the build\n  ${found.join('\n  ')}`)
  process.exit(1)
}
console.log(`PASS  check-dist: ${all.length} files, no development shortcut (${MARKERS.join(', ')})`)

const csp: string[] = []
for (const f of all) {
  const text = readFileSync(f, 'utf8')
  csp.push(...(f.endsWith('.html') ? inlineProblems(f, text) : evalProblems(f, text)))
}
const headers = join(root, '_headers')
if (!existsSync(headers)) csp.push(`${headers} is missing`)
else if (readFileSync(headers, 'utf8') !== readFileSync('public/_headers', 'utf8')) csp.push(`${headers} differs from public/_headers`)
if (csp.length) {
  console.log(`FAIL  check-dist: the build would break under the CSP\n  ${csp.join('\n  ')}`)
  process.exit(1)
}
console.log(`PASS  check-dist: no inline script or handler, no eval or Function constructor, _headers copied`)
