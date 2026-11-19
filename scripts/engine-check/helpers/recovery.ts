/**
 * Shared engine check helpers of the recovery scenarios (12 words, contact list).
 */
import { Fail, expect } from '../report'
import { type Peer, type World, until } from '../world'

// ---------------------------------------------------------------- 12 words

export async function rejectsWith(p: Promise<unknown> | (() => unknown), code: string, what: string): Promise<void> {
  try {
    await (typeof p === 'function' ? p() : p)
    expect(false, `${what}: did not reject`)
  } catch (e) {
    if (e instanceof Fail) throw e
    const msg = e instanceof Error ? e.message : String(e)
    expect(msg === code, `${what}: rejects '${code}' (${msg})`)
  }
}

// ---------------------------------------------------------------- recovery: S-REC

/** The list relays of every S-REC peer (the list has relays of its own, in the hub). */
export const LIST_AB = ['fake://a', 'fake://b']

/** Lets virtual time run until `call` ends (at most maxMs), then gives its result or throws its error. */
export async function onTime<T>(w: World, call: Promise<T>, maxMs = 60_000): Promise<T> {
  let done = false
  let failed = false
  let value: T | undefined
  let err: unknown
  call.then(
    (v) => {
      value = v
      done = true
    },
    (e: unknown) => {
      err = e
      failed = true
      done = true
    },
  )
  await until(w, () => done, maxMs, 'the call ends')
  if (failed) throw err
  return value as T
}

/** "c:<pubkeys>|d:<pubkeys>" of a list view or a copy, for comparing who is where. */
export function who(view: { c: [string, ...unknown[]][]; d: [string, ...unknown[]][] } | null | undefined): string {
  if (!view) return 'none'
  return `c:${view.c
    .map((e) => e[0].slice(0, 6))
    .sort()
    .join(',')}|d:${view.d
    .map((e) => e[0].slice(0, 6))
    .sort()
    .join(',')}`
}

/**
 * A peer in boot 'setup' types its 12 words: checkMnemonic, then (found or `anyway`)
 * restoreIdentity with lock 'none'. Returns what checkMnemonic said.
 */
export async function restoreWords(p: Peer, opts: { anyway?: boolean } = {}): Promise<{ found: boolean }> {
  const w = p.world
  expect(p.state().boot === 'setup', `${p.name} waits in setup (${p.state().boot})`)
  const r = await onTime(w, p.a.checkMnemonic(p.words), 30_000)
  if (!r.found && !opts.anyway) return r
  await onTime(w, p.a.restoreIdentity(p.words, { method: 'none' }), 60_000)
  expect(p.state().boot === 'ready', `${p.name} is ready after the restore (${p.state().boot})`)
  return r
}
