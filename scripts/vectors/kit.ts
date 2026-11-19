/**
 * Shared pieces of the reference vector export (scripts/export-vectors.ts).
 *
 * A vector file lists, per function, the input of each case and what the real implementation in src/
 * returned or threw. Values JSON cannot carry are written as one-key tagged objects:
 *   {"$":"NaN"} {"$":"Infinity"} {"$":"-Infinity"} {"$":"-0"} {"$":"undefined"}
 *   {"$":"int","value":"<decimal>"}      a whole number outside the safe integer range, exact
 *   {"$":"bigint","value":"<decimal>"}   a BigInt
 * Every other number is a plain JSON number, and a plain integer is always a safe integer.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export function encode(v: unknown): Json {
  if (v === undefined) return { $: 'undefined' }
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v
  if (typeof v === 'bigint') return { $: 'bigint', value: v.toString() }
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $: 'NaN' }
    if (v === Infinity) return { $: 'Infinity' }
    if (v === -Infinity) return { $: '-Infinity' }
    if (Object.is(v, -0)) return { $: '-0' }
    if (Number.isInteger(v) && !Number.isSafeInteger(v)) return { $: 'int', value: BigInt(v).toString() }
    return v
  }
  if (Array.isArray(v)) return v.map(encode)
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]))
  throw new Error(`cannot encode ${typeof v}`)
}

export interface Case {
  name: string
  input: Record<string, Json>
  /** What the function returned. Absent when it threw. */
  expected?: Json
  /** The class name of what it threw. */
  error?: string
  /**
   * The input is outside what the callers pass (not an integer where whole amounts are
   * meant, a non-string where text is meant). The result is still what src/ does today.
   */
  outOfDomain?: true
}

export interface FunctionVectors {
  args: string[]
  cases: Case[]
}

export interface VectorFile {
  module: string
  constants: Record<string, Json>
  functions: Record<string, FunctionVectors>
}

export interface CaseOptions {
  outOfDomain?: boolean
}

/** One case: a name, the arguments in call order (fewer than `args` means the rest were not passed), options. */
export type CaseSpec = [name: string, args: unknown[]] | [name: string, args: unknown[], options: CaseOptions]

export function defineFunction(argNames: string[], impl: (...args: never[]) => unknown, specs: CaseSpec[]): FunctionVectors {
  const seen = new Set<string>()
  const cases = specs.map(([name, args, options]) => {
    if (seen.has(name)) throw new Error(`duplicate case name: ${name}`)
    seen.add(name)
    if (args.length > argNames.length) throw new Error(`too many arguments: ${name}`)
    const input: Record<string, Json> = {}
    args.forEach((a, i) => {
      input[argNames[i]] = encode(a)
    })
    const c: Case = { name, input }
    try {
      c.expected = encode((impl as (...a: unknown[]) => unknown)(...args))
    } catch (e) {
      c.error = e instanceof Error ? e.constructor.name : typeof e
    }
    if (options?.outOfDomain) c.outOfDomain = true
    return c
  })
  return { args: argNames, cases }
}

/** One case per line, so a changed case is one changed line. */
export function render(file: VectorFile): string {
  const lines: string[] = ['{', `  "module": ${JSON.stringify(file.module)},`, `  "constants": ${JSON.stringify(file.constants)},`, '  "functions": {']
  const names = Object.keys(file.functions)
  names.forEach((fnName, i) => {
    const f = file.functions[fnName]
    lines.push(`    ${JSON.stringify(fnName)}: {`, `      "args": ${JSON.stringify(f.args)},`, '      "cases": [')
    for (const [j, c] of f.cases.entries()) lines.push(`        ${JSON.stringify(c)}${j < f.cases.length - 1 ? ',' : ''}`)
    lines.push('      ]', `    }${i < names.length - 1 ? ',' : ''}`)
  })
  lines.push('  }', '}', '')
  return lines.join('\n')
}

/** The number of cases per function, for the export's summary line. */
export function countCases(file: VectorFile): number {
  return Object.values(file.functions).reduce((n, f) => n + f.cases.length, 0)
}

/** Characters whose treatment by `trim()` differs between text libraries; each is put around a token. */
export const EDGE_CHARS: Array<[string, string]> = [
  ['tab', '\t'],
  ['line feed', '\n'],
  ['vertical tab', '\u000b'],
  ['form feed', '\f'],
  ['carriage return', '\r'],
  ['space', ' '],
  ['U+001C', '\u001c'],
  ['U+001F', '\u001f'],
  ['NUL', '\u0000'],
  ['U+0085 next line', '\u0085'],
  ['U+00A0 no-break space', '\u00a0'],
  ['U+1680 ogham space', '\u1680'],
  ['U+180E mongolian vowel separator', '\u180e'],
  ['U+2000 en quad', '\u2000'],
  ['U+200B zero-width space', '\u200b'],
  ['U+2028 line separator', '\u2028'],
  ['U+2029 paragraph separator', '\u2029'],
  ['U+202F narrow no-break space', '\u202f'],
  ['U+205F medium mathematical space', '\u205f'],
  ['U+2060 word joiner', '\u2060'],
  ['U+3000 ideographic space', '\u3000'],
  ['U+FEFF byte order mark', '\ufeff'],
]

/** One case per edge character: `token` with that character on both sides. */
export function aroundEdges(token: string): CaseSpec[] {
  return EDGE_CHARS.map(([label, ch]): CaseSpec => [`${label} around the token`, [`${ch}${token}${ch}`]])
}
