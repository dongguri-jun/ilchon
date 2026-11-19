import { useEffect, useState } from 'react'
import { toAsciiDigits } from '../../lib/money'
import { normalizeWords, wordProblems } from '../../lib/seed'

/**
 * Error code from an engine action -> i18n key in the 'lock' namespace. The codes
 * are the identity and lock list in src/contracts.ts (IlchonActions); keep the two equal.
 * `ctx` 'unlock' picks texts that make sense on the unlock screen, where the
 * user cannot switch lock.
 */
export function errorKey(e: unknown, ctx?: 'unlock'): string {
  const code = e instanceof Error ? e.message : String(e)
  switch (code) {
    case 'wrong-pin':
      return 'errWrongPin'
    case 'pin-wait':
      return 'errPinWait'
    case 'weak-pin':
      return 'errWeakPin'
    case 'storage-damaged':
      return 'errStorageDamaged'
    case 'storage-unavailable':
      return 'errStorageUnavailable'
    case 'passkey-cancelled':
      return 'errCancelled'
    case 'passkey-confirm':
      return 'errPasskeyConfirm'
    case 'prf-unsupported':
      return ctx === 'unlock' ? 'errPrfUnlock' : 'errPrf'
    case 'invalid-mnemonic':
      return 'errMnemonic'
    case 'network':
      return 'errNetwork'
    case 'not-allowed':
    case 'not-prepared':
    case 'not-checked':
      return 'errNotAllowed'
    case 'identity-exists':
      return 'errIdentityExists'
    case 'reauth-required':
      return 'errReauth'
    case 'busy':
      return 'errBusy'
    case 'reset-failed':
      return 'errResetFailed'
    case 'invalid-choice':
      return 'errGeneric'
    case 'corrupt':
      return ctx === 'unlock' ? 'errPasskeyMismatch' : 'errCorrupt'
    default:
      return 'errGeneric'
  }
}

/** What a PIN field keeps of its input: ASCII digits (full-width ones turned into them), at most 6. */
export function pinDigits(raw: string): string {
  return toAsciiDigits(raw).replace(/[^0-9]/g, '').slice(0, 6)
}

/** Time left before the next PIN try, as m:ss. */
export function waitText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Error code of a rejected engine action. */
export function errorCode(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Clipboard write that also works where the async API is missing. Never used for a key or the 12 words. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.setAttribute('aria-hidden', 'true')
    el.style.position = 'fixed'
    el.style.top = '-1000px'
    el.style.opacity = '0'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    el.remove()
    return ok
  } catch {
    return false
  }
}

/**
 * Milliseconds left until `until`, redrawn every second while it is in the future.
 * 0 once it has passed (the wait after wrong PINs).
 */
export function useWaitLeft(until: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (until <= Date.now()) return
    const timer = setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= until) clearInterval(timer)
    }, 1000)
    setNow(Date.now())
    return () => clearInterval(timer)
  }, [until])
  return Math.max(0, until - now)
}

/**
 * The words typed so far that are not in the English list, by position: only finished words, so the one being typed is not flagged
 * before its last letter.
 */
export function typedUnknown(text: string): number[] {
  const words = normalizeWords(text).split(' ').filter(Boolean)
  const finished = /\s$/.test(text) ? words.length : words.length - 1
  return wordProblems(text).unknown.filter((n) => n <= finished)
}
