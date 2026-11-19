/**
 * Shared by scripts/check-csp.ts (public/_headers and src/) and scripts/check-dist.ts
 * (the build).
 */

export interface Rule {
  pattern: string
  line: number
  headers: { name: string; value: string; line: number }[]
}

export function parseHeaders(text: string): { rules: Rule[]; problems: string[] } {
  const rules: Rule[] = []
  const problems: string[] = []
  const lines = text.split('\n')
  lines.forEach((raw, i) => {
    const n = i + 1
    const line = raw.replace(/\r$/, '')
    if (line.length > 2000) problems.push(`line ${n}: ${line.length} characters (limit 2,000)`)
    if (!line.trim() || line.trimStart().startsWith('#')) return
    if (!/^\s/.test(line)) {
      const pattern = line.trim()
      if (!pattern.startsWith('/') && !pattern.startsWith('https://')) {
        problems.push(`line ${n}: a rule must start with / or https:// (${pattern})`)
      }
      if ((pattern.match(/\*/g) ?? []).length > 1) problems.push(`line ${n}: more than one splat`)
      if (/^https:\/\/[^/]*:\d/.test(pattern)) problems.push(`line ${n}: ports are not supported`)
      rules.push({ pattern, line: n, headers: [] })
      return
    }
    const rule = rules[rules.length - 1]
    if (!rule) {
      problems.push(`line ${n}: header before any rule`)
      return
    }
    const m = /^\s+(!\s)?([A-Za-z0-9-]+):?\s*(.*)$/.exec(line)
    if (!m || (!m[1] && !line.includes(':'))) {
      problems.push(`line ${n}: not "Name: value" (${line.trim()})`)
      return
    }
    if (m[1]) return // "! Name" detaches an earlier header
    const name = m[2]
    const value = m[3].trim()
    if (!value) problems.push(`line ${n}: ${name} has no value`)
    if (rule.headers.some((h) => h.name.toLowerCase() === name.toLowerCase())) {
      problems.push(`line ${n}: ${name} appears twice in ${rule.pattern} (Pages would join them with a comma)`)
    }
    rule.headers.push({ name, value, line: n })
  })
  if (rules.length > 100) problems.push(`${rules.length} rules (limit 100)`)
  for (const r of rules) if (!r.headers.length) problems.push(`line ${r.line}: rule ${r.pattern} has no header`)
  return { rules, problems }
}

export function parseCsp(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of text.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/)
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), values)
  }
  return out
}
/** Does a CSP source list allow this URL from https://ilchon.org? (CSP3 matching, simplified.) */
export function allows(list: string[], url: string): boolean {
  if (url.startsWith('/') && !url.startsWith('//')) return list.includes("'self'")
  const m = /^([a-z][a-z0-9+.-]*):(\/\/([^/?#]*))?/i.exec(url)
  if (!m) return false
  const scheme = m[1].toLowerCase()
  const host = (m[3] ?? '').toLowerCase().replace(/:\d+$/, '')
  for (const src of list) {
    const s = src.toLowerCase()
    if (s === '*') {
      if (['http', 'https', 'ws', 'wss'].includes(scheme)) return true
      continue
    }
    const schemeOnly = /^([a-z][a-z0-9+.-]*):$/.exec(s)
    if (schemeOnly) {
      const want = schemeOnly[1]
      if (want === scheme) return true
      // CSP3: https: also matches wss:, http: also matches ws: and the secure schemes.
      if (want === 'https' && scheme === 'wss') return true
      if (want === 'http' && ['ws', 'wss', 'https'].includes(scheme)) return true
      continue
    }
    const hostSrc = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?(\/.*)?$/.exec(s)
    if (hostSrc && !s.startsWith("'")) {
      const [, sch, wild, h] = hostSrc
      if (sch && sch !== scheme && !(sch === 'https' && scheme === 'wss') && !(sch === 'http' && ['ws', 'wss', 'https'].includes(scheme))) continue
      if (!sch && !['https', 'wss'].includes(scheme)) continue // from an https page
      if (wild ? host.endsWith(`.${h}`) : host === h) return true
    }
  }
  return false
}

/** Problems that would need 'unsafe-inline' or break under script-src 'self'. Also used by check-dist. */
export function inlineProblems(name: string, html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1]
    const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]
    if (!src) out.push(`${name}: inline <script>`)
    else if (!src.startsWith('/') || src.startsWith('//')) out.push(`${name}: <script src="${src}"> is not same-origin`)
    else if (m[2].trim()) out.push(`${name}: <script src> with a body`)
  }
  for (const m of html.matchAll(/<[a-z][^>]*\s(on[a-z]+)\s*=/gi)) out.push(`${name}: inline event handler ${m[1]}`)
  if (/(href|src|action)\s*=\s*["']\s*javascript:/i.test(html)) out.push(`${name}: javascript: URL`)
  return out
}

/**
 * Script text that a CSP without 'unsafe-eval' would block: a global eval call (bare, or
 * through globalThis/window/self), new Function, string timers, and WebAssembly compiling.
 * `eval` on any other object (`p.eval(1)`) is someone's own method and is skipped.
 */
export function evalProblems(name: string, js: string): string[] {
  const out: string[] = []
  for (const m of js.matchAll(/(?:(?<![\w$.])(?:globalThis|window|self)\s*\.\s*|(?<![\w$.]))eval\s*\(/g)) {
    // `eval(a, b) {` is a method definition (noble's polynomial helpers), not a call.
    let depth = 0
    let i = m.index! + m[0].length - 1
    for (; i < js.length; i++) {
      if (js[i] === '(') depth++
      else if (js[i] === ')' && --depth === 0) break
    }
    if (/^\s*\{/.test(js.slice(i + 1, i + 20))) continue
    out.push(`${name}: eval( at ${m.index}`)
  }
  for (const m of js.matchAll(/new\s+Function\s*\(|(?<![\w$.])Function\s*\(\s*['"`]/g)) out.push(`${name}: Function constructor at ${m.index}`)
  for (const m of js.matchAll(/(?<![\w$])(?:setTimeout|setInterval)\s*\(\s*['"`]/g)) out.push(`${name}: string timer at ${m.index}`)
  if (/\bWebAssembly\s*\.\s*(?:instantiate|instantiateStreaming|compile|compileStreaming|Module)\b/.test(js)) out.push(`${name}: WebAssembly needs 'wasm-unsafe-eval'`)
  return out
}
