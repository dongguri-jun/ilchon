/**
 * The first screen language, from the browser alone. Nothing is read from or
 * written to storage: before unlock, screens follow the phone's language, so nothing
 * readable before unlock hints at the user. After unlock the engine's saved settings.lang wins.
 * No React, so Node checks can call it with a fake navigator.
 */
import type { Lang } from '../contracts'
import { offeredLangs } from './lang'

type NavLike = { languages?: readonly string[]; language?: string }

/** navigator.languages, or [navigator.language] when it is empty. Never throws. */
export function browserLanguages(nav?: NavLike): string[] {
  try {
    const n: NavLike | undefined = nav ?? (typeof navigator === 'undefined' ? undefined : navigator)
    if (!n) return []
    const list = n.languages
    if (list && list.length > 0) return list.map(String)
    return n.language ? [String(n.language)] : []
  } catch {
    return []
  }
}

/** First browser language whose primary subtag is offered; otherwise 'en'. */
export function pickLang(languages: readonly string[], offered: readonly Lang[]): Lang {
  for (const raw of languages) {
    const base = String(raw).split(/[-_]/)[0].toLowerCase()
    const hit = offered.find((l) => l === base)
    if (hit) return hit
  }
  return 'en'
}

/** pickLang(browserLanguages(), offeredLangs()). */
export function detectLang(): Lang {
  return pickLang(browserLanguages(), offeredLangs())
}
