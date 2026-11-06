/**
 * Error code from an engine action -> i18n key in the 'lock' namespace.
 * `ctx` 'unlock' picks texts that make sense on the unlock screen, where the
 * user cannot switch to a password and may have no backup.
 */
export function errorKey(e: unknown, ctx?: 'unlock'): string {
  const code = e instanceof Error ? e.message : String(e)
  switch (code) {
    case 'wrong-password':
      return 'errWrongPassword'
    case 'passkey-cancelled':
      return 'errCancelled'
    case 'passkey-confirm':
      return 'errPasskeyConfirm'
    case 'prf-unsupported':
      return ctx === 'unlock' ? 'errPrfUnlock' : 'errPrf'
    case 'invalid-ncryptsec':
      return 'errInvalid'
    case 'unsupported-log-n':
      return 'errLogN'
    case 'weak-password':
      return 'errWeak'
    case 'not-allowed':
      return 'errNotAllowed'
    case 'identity-exists':
      return 'errIdentityExists'
    case 'reauth-required':
      return 'errReauth'
    case 'busy':
      return 'errBusy'
    case 'corrupt':
      return ctx === 'unlock' ? 'errPasskeyMismatch' : 'errCorrupt'
    default:
      return 'errGeneric'
  }
}

/** Error code of a rejected engine action. */
export function errorCode(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const MIN_PASSWORD = 8

/**
 * Clipboard write that also works where the async API is missing.
 * `legacy: false` never puts the text in the DOM (use it for the raw secret key).
 */
export async function copyText(text: string, { legacy = true }: { legacy?: boolean } = {}): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  if (!legacy) return false
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
