/**
 * The engine check conventions (scripts/check-engine.ts): every scenario runs through
 * scenario() and prints one line, PASS or FAIL. KNOWN-BUG is a failure the scenario is
 * marked for (it does not count); a FAIL "UNEXPECTED PASS" when such a scenario passes, so
 * the change that fixed it removes the mark. The run exits 1 on any failure.
 */

// ---------------------------------------------------------------- assertions

export class Fail extends Error {}
/** The failure of the one assertion a knownBug scenario is marked for. */
class KnownBugFail extends Fail {}

export function expect(ok: boolean, what: string): void {
  if (!ok) throw new Fail(what)
}

/** Set when a knownBug scenario reaches its marked assertion. */
let knownReached = false

/**
 * The assertion that shows the known bug. Only a failure here counts as KNOWN-BUG;
 * every other failure of the scenario (its setup, the invariants, the harness) is a
 * plain FAIL. It must be the scenario's last assertion.
 */
export function expectKnownBug(ok: boolean, what: string): void {
  knownReached = true
  if (!ok) throw new KnownBugFail(what)
}

// ---------------------------------------------------------------- reporting

let failures = 0
/** The names of the failed scenarios, printed again at the end so a rare failure is never lost in the output. */
const failedNames: string[] = []
let unhandled: unknown[] = []

process.on('unhandledRejection', (e) => {
  unhandled.push(e)
})

export function errText(e: unknown): string {
  return e instanceof Fail ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)
}

/**
 * Parts of scenario names: only the scenarios whose name holds one of them run (a local aid;
 * CI runs all). Empty: every scenario. Set by the entry from its arguments and CHECK_ONLY.
 */
let only: string[] = []
/** How many scenarios ran (not skipped by `only`). */
let ran = 0

export function runOnly(parts: string[]): void {
  only = parts
}

export async function scenario(name: string, fn: () => Promise<void>, opts: { knownBug?: string } = {}): Promise<void> {
  if (only.length > 0 && !only.some((o) => name.includes(o))) return
  ran++
  unhandled = []
  knownReached = false
  let err: unknown = null
  try {
    await fn()
  } catch (e) {
    err = e
  }
  // Let a stray rejection of this scenario surface before judging it.
  await new Promise<void>((r) => setImmediate(r))
  if (!err && unhandled.length > 0) err = new Fail(`unhandled rejection: ${errText(unhandled[0])}`)
  if (opts.knownBug) {
    if (err instanceof KnownBugFail) {
      console.log(`KNOWN-BUG  ${name}  (${opts.knownBug}): ${errText(err)}`)
    } else if (err) {
      failures++
      failedNames.push(name)
      console.log(`FAIL  ${name}  (before its known-bug assertion): ${errText(err)}`)
    } else if (!knownReached) {
      failures++
      failedNames.push(name)
      console.log(`FAIL  ${name}: the known-bug assertion was never reached`)
    } else {
      failures++
      failedNames.push(name)
      console.log(`FAIL  ${name}  UNEXPECTED PASS: the known bug '${opts.knownBug}' no longer shows; remove the mark`)
    }
    return
  }
  if (err instanceof KnownBugFail) {
    failures++
    failedNames.push(name)
    console.log(`FAIL  ${name}: expectKnownBug in a scenario without a knownBug mark: ${errText(err)}`)
    return
  }
  if (err) {
    failures++
    failedNames.push(name)
    console.log(`FAIL  ${name}: ${errText(err)}`)
  } else {
    console.log(`PASS  ${name}`)
  }
}

/** The run itself failed outside any scenario. */
export function crashed(e: unknown): void {
  failures++
  console.log(`FAIL  check-engine crashed: ${errText(e)}`)
}

/**
 * The end of the run: the total and the failed names again. A selection that picked no
 * scenario fails, so a mistyped name never passes as "ALL PASS".
 */
export function summary(t0: number): void {
  if (only.length > 0 && ran === 0) {
    failures++
    console.log(`FAIL  no scenario name holds ${only.map((o) => `'${o}'`).join(' or ')}`)
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (${Date.now() - t0} ms)`)
  for (const n of failedNames) console.log(`  FAILED: ${n}`)
}

export function exitCode(): number {
  return failures === 0 ? 0 : 1
}
