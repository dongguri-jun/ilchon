/**
 * Storage namespace for this tab. `?p=alice` selects an independent profile so
 * one browser can run several users side by side.
 */
export function getProfileNamespace(): string {
  if (typeof location === 'undefined') return 'ilchon:default'
  try {
    const p = new URLSearchParams(location.search).get('p')
    if (p && p.length <= 24 && /^[A-Za-z0-9_-]+$/.test(p)) return 'ilchon:' + p
  } catch {
    // fall through
  }
  return 'ilchon:default'
}
