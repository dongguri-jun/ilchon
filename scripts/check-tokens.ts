/**
 * Design tokens in CSS (no network, no build): reads every .css under src/ and fails when a
 * declaration writes a bare number where a token exists.
 *
 *  T1  Border and outline widths (border, border-*, border-width, outline, and the spread of a
 *      ring shadow `0 0 0 Npx`) are var(--bw-*).
 *      Border-radius (and the corner longhands) is var(--radius-*), 0, 50%, or inherit.
 *      font-size is var(--fs-*) or inherit.
 *      Transition and animation durations and delays are var(--dur-*) (or 0s), and timing
 *      curves are var(--ease-*) or `linear`. No ease, ease-in, cubic-bezier(...) literals.
 *      No literal fallback inside those var(): the token is always defined, a fallback only
 *      hides drift.
 *  T2  The one allow list is ALLOWED below, with a reason for each entry. An entry that no
 *      declaration uses any more fails, and a run that reads fewer files or declarations than
 *      the floors fails (a broken regex would otherwise pass).
 *  T3  The rules still fail on a known-bad sample and pass on a clean one.
 *
 * Not covered: the `font` shorthand, inline style props in .tsx, and values inside calc().
 *
 * Run: pnpm check:tokens
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** key = `<file>|<property>: <value>` as written (without !important). */
const ALLOWED: Record<string, string> = {
  'src/ui/tokens.css|animation-duration: 0.01ms': 'the global reduced-motion rule: a one-pass 0.01ms is the point, not a design duration',
  'src/ui/tokens.css|transition-duration: 0.01ms': 'same global reduced-motion rule',
  'src/ui/Spinner.css|animation-duration: 1.6s': 'reduced-motion fade period; check-a11y A8 parses this literal to prove it is slow (at least 0.5s)',
  'src/screens/lock/lock.css|border: 5px solid var(--c-accent)': 'selected radio: a 5px border around an 18px circle leaves an 8px dot; a proportion, not a stroke weight',
}

const MIN_FILES = 25
const MIN_DECLS = 150

interface Decl {
  file: string
  line: number
  prop: string
  value: string
}

/** Blank out comments but keep newlines, so line numbers stay true. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

function declarations(file: string, css: string): Decl[] {
  const text = stripComments(css)
  const out: Decl[] = []
  const re = /([a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/g
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    const prop = m[1]
    if (prop.startsWith('--')) continue
    const value = m[2]
      .replace(/!important/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    out.push({ file, line: text.slice(0, m.index).split('\n').length, prop, value })
  }
  return out
}

/** Split on `sep` outside parentheses. */
function split(value: string, sep: RegExp): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of value) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (depth === 0 && sep.test(ch)) {
      if (cur) parts.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) parts.push(cur)
  return parts
}

const LENGTH = /^-?(\d+\.?\d*|\.\d+)(px|rem|em|pt|vh|vw|vmin)$/
const TIME = /^-?(\d+\.?\d*|\.\d+)m?s$/
const isZero = (t: string) => /^-?0+(\.0+)?(px|rem|em|ms|s)?$/.test(t)
const bwVar = /^var\(--bw-[a-z0-9]+\)$/
const radiusVar = /^var\(--radius-[a-z0-9]+\)$/
const fsVar = /^var\(--fs-[a-z0-9]+\)$/
const durVar = /^var\(--dur-[a-z0-9]+\)$/
const easeVar = /^var\(--ease-[a-z0-9-]+\)$/

const BORDER_PROP = /^(border(-(top|right|bottom|left))?|outline)$|^(border(-(top|right|bottom|left))?|outline)-width$/
const RADIUS_PROP = /^border(-(top|bottom)-(left|right)|-(start|end)-(start|end))?-radius$/
const MOTION_PROP = /^(transition|animation)(-duration|-delay|-timing-function)?$/
const WATCHED = (prop: string) => BORDER_PROP.test(prop) || RADIUS_PROP.test(prop) || prop === 'box-shadow' || prop === 'font-size' || MOTION_PROP.test(prop)

function problemsFor(d: Decl): string[] {
  const { prop, value } = d
  const bad: string[] = []
  if (BORDER_PROP.test(prop)) {
    for (const t of split(value, /\s/)) {
      if (LENGTH.test(t) && !isZero(t)) bad.push(`${prop}: ${t} is not var(--bw-*)`)
      else if (/^var\(--bw-/.test(t) && !bwVar.test(t)) bad.push(`${prop}: ${t} has a fallback`)
    }
  } else if (prop === 'box-shadow') {
    for (const shadow of split(value, /,/)) {
      const lens = split(shadow.trim(), /\s/).filter((p) => LENGTH.test(p) || isZero(p) || bwVar.test(p))
      if (lens.length === 4 && lens.slice(0, 3).every(isZero) && !bwVar.test(lens[3]) && !isZero(lens[3])) {
        bad.push(`box-shadow ring spread ${lens[3]} is not var(--bw-*)`)
      }
    }
  } else if (RADIUS_PROP.test(prop)) {
    for (const t of split(value, /[\s/]/)) {
      if (radiusVar.test(t) || isZero(t) || t === '50%' || t === 'inherit') continue
      bad.push(`${prop}: ${t} is not var(--radius-*)`)
    }
  } else if (prop === 'font-size') {
    if (!fsVar.test(value) && value !== 'inherit') bad.push(`font-size: ${value} is not var(--fs-*)`)
  } else if (MOTION_PROP.test(prop)) {
    const durOnly = /duration|delay/.test(prop)
    const easeOnly = /timing/.test(prop)
    for (const group of split(value, /,/)) {
      for (const t of split(group.trim(), /\s/)) {
        if (TIME.test(t)) {
          if (!easeOnly && !isZero(t)) bad.push(`${prop}: ${t} is not var(--dur-*)`)
        } else if (!durOnly && /^(ease|ease-in|ease-out|ease-in-out)$/.test(t)) bad.push(`${prop}: ${t} is not var(--ease-*)`)
        else if (!durOnly && /^cubic-bezier\(/.test(t)) bad.push(`${prop}: literal ${t} is not var(--ease-*)`)
        else if (/^var\(--(dur|ease)-/.test(t) && !(durVar.test(t) || easeVar.test(t))) bad.push(`${prop}: ${t} has a fallback`)
      }
    }
  }
  return bad
}

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? cssFiles(p) : p.endsWith('.css') ? [p] : []
  })
}

let failed = 0
function check(id: string, problems: string[], ok: string) {
  if (problems.length) {
    failed++
    console.log(`FAIL  ${id}  ${problems.join('\n        ')}`)
  } else console.log(`PASS  ${id}  ${ok}`)
}

const files = cssFiles('src')
const checked = files.flatMap((f) => declarations(f, readFileSync(f, 'utf8'))).filter((d) => WATCHED(d.prop))

const used = new Set<string>()
const found: string[] = []
for (const d of checked) {
  const probs = problemsFor(d)
  if (!probs.length) continue
  const key = `${d.file}|${d.prop}: ${d.value}`
  if (key in ALLOWED) used.add(key)
  else found.push(...probs.map((p) => `${d.file}:${d.line}  ${p}`))
}
check('T1', found, `${files.length} CSS files, ${checked.length} border, radius, font-size, transition and animation declarations use tokens`)

check(
  'T2',
  [
    ...Object.keys(ALLOWED)
      .filter((k) => !used.has(k))
      .map((k) => `unused allow-list entry: ${k}`),
    ...(files.length < MIN_FILES ? [`read ${files.length} CSS files, expected at least ${MIN_FILES}`] : []),
    ...(checked.length < MIN_DECLS ? [`checked ${checked.length} declarations, expected at least ${MIN_DECLS}`] : []),
  ],
  `allow list: ${used.size} entries, all in use; floors ${MIN_FILES} files and ${MIN_DECLS} declarations met`,
)

{
  const bad = declarations(
    'sample.css',
    `.a { border: 1px solid red; border-radius: var(--radius-md, 16px); font-size: 15px;
  transition: color 0.15s ease; animation: x 200ms cubic-bezier(0,0,1,1); box-shadow: 0 0 0 2px red; outline: 2px solid red; }`,
  ).flatMap(problemsFor)
  const good = declarations(
    'sample.css',
    `.a { border: var(--bw-1) solid red; border-radius: 50%; font-size: var(--fs-14);
  transition: color var(--dur-press) var(--ease-out); box-shadow: 0 8px 24px red; border-bottom: 0; animation: s var(--dur-spin) linear infinite; }`,
  ).flatMap(problemsFor)
  check(
    'T3',
    [
      ...(bad.length === 9 ? [] : [`the bad sample raised ${bad.length} problems, expected 9: ${bad.join('; ')}`]),
      ...(good.length === 0 ? [] : [`the good sample raised problems: ${good.join('; ')}`]),
    ],
    'the rules fail on a bad sample (9 problems) and pass on a clean one',
  )
}

if (failed) {
  console.log(`\n${failed} FAILED`)
  process.exit(1)
}
console.log('\nALL PASS')
