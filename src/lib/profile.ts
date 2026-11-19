/**
 * Storage namespace for this tab. `?p=alice` selects an independent profile so one
 * browser can run several users side by side. Only development builds and branch
 * previews (`*.pages.dev`) take `?p=`; the real address ignores it and always opens
 * the default profile.
 */
export function getProfileNamespace(loc: { search: string; hostname: string } | undefined = typeof location === 'undefined' ? undefined : location, dev: boolean = isDevBuild()): string {
  if (!loc) return 'ilchon:default'
  if (!dev && !loc.hostname.endsWith('.pages.dev')) return 'ilchon:default'
  try {
    const p = new URLSearchParams(loc.search).get('p')
    if (p && p.length <= 24 && /^[A-Za-z0-9_-]+$/.test(p)) return 'ilchon:' + p
  } catch {
    // fall through
  }
  return 'ilchon:default'
}

/** Vite's development flag; false in a shipped build and in Node (no import.meta.env). */
function isDevBuild(): boolean {
  return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true
}
