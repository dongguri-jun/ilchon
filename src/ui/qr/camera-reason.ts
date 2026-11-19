/**
 * Why the camera could not start, in the short English reasons QrScanner hands to its
 * onError (the connect screen maps them to its strings). No DOM here except in
 * cameraContext, so Node checks can run cameraReason (check-i18n T19).
 *
 * After the person dismissed Chrome's camera prompt, the
 * connect screen said no camera was found. qr-scanner 1.4.2 tries six getUserMedia
 * constraint sets, swallows every error, and throws the one string 'Camera not found.'
 * (LIBRARY_NO_CAMERA), so the NotAllowedError of the dismissal never reached us. For that
 * string we ask the browser what it knows: the camera permission state and whether any
 * video input exists (enumerateDevices lists one even before permission, without a label).
 * When a camera is listed but the permission state cannot be read (Firefox has no 'camera'
 * permission name), we do not know whether the person dismissed the prompt, so the message
 * stays neutral ('Camera failed': try again or paste) instead of saying they did.
 */

export type CameraReason = 'Camera needs https' | 'Camera permission denied' | 'Camera permission dismissed' | 'No camera found' | 'Camera is in use' | 'Camera unavailable' | 'Camera failed'

/** What the browser says after the failure. Undefined: the browser could not tell. */
export interface CameraContext {
  secure: boolean
  /** navigator.permissions.query({ name: 'camera' }).state */
  permission?: 'granted' | 'denied' | 'prompt'
  /** enumerateDevices() has a 'videoinput' */
  hasCamera?: boolean
}

/** The catch-all qr-scanner 1.4.2 throws for any getUserMedia failure. */
export const LIBRARY_NO_CAMERA = 'Camera not found.'

export function cameraReason(err: unknown, ctx: CameraContext): CameraReason {
  if (!ctx.secure) return 'Camera needs https'
  const name = err instanceof Error ? err.name : ''
  const text = typeof err === 'string' ? err : err instanceof Error ? err.message : ''
  // A denied permission (blocked for the site) needs the settings; anything else that was
  // not allowed (the prompt closed or dismissed, or a state we cannot read) is "not allowed".
  const notAllowed = (): CameraReason => (ctx.permission === 'denied' ? 'Camera permission denied' : 'Camera permission dismissed')
  if (name === 'NotAllowedError' || name === 'SecurityError' || /permission|denied|not allowed/i.test(text)) return notAllowed()
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found'
  if (text === LIBRARY_NO_CAMERA) {
    if (ctx.permission === 'denied') return 'Camera permission denied'
    if (ctx.hasCamera === false) return 'No camera found'
    if (ctx.hasCamera === true) {
      if (ctx.permission === 'granted') return 'Camera unavailable'
      return ctx.permission === 'prompt' ? 'Camera permission dismissed' : 'Camera failed'
    }
    return 'No camera found'
  }
  if (/not found/i.test(text)) return 'No camera found'
  if (name === 'NotReadableError' || name === 'AbortError') return 'Camera is in use'
  return 'Camera unavailable'
}

/** Ask the browser after a failure. Never throws; unknown parts stay undefined. */
export async function cameraContext(): Promise<CameraContext> {
  const ctx: CameraContext = { secure: typeof window !== 'undefined' && window.isSecureContext }
  try {
    const state = (await navigator.permissions.query({ name: 'camera' as PermissionName })).state
    if (state === 'granted' || state === 'denied' || state === 'prompt') ctx.permission = state
  } catch {
    // Firefox has no 'camera' permission name; leave it unknown.
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    ctx.hasCamera = devices.some((d) => d.kind === 'videoinput')
  } catch {
    // unknown
  }
  return ctx
}
