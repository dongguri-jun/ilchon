import { useCallback, useSyncExternalStore } from 'react'
import type { Lang } from '../contracts'
import { detectLang } from './detect'

type Dict = Record<string, string>
type Vars = Record<string, string | number>
/** Korean and English are complete; Japanese may miss keys, which then show in English. */
type Dicts = { ko: Dict; en: Dict; ja?: Partial<Dict> }

const dicts = new Map<string, Dicts>()
const listeners = new Set<() => void>()

/** The browser language only: nothing about the language is stored before unlock. */
function initialLang(): Lang {
  return detectLang()
}

let current: Lang = initialLang()
if (typeof document !== 'undefined') document.documentElement.lang = current
// Bumped on every registration and language change, so useT re-renders when strings arrive late.
let version = 0

function emit() {
  version++
  listeners.forEach((l) => {
    l()
  })
}

/**
 * Keys come from the Korean table: a key missing from or extra in English fails
 * to compile. Japanese is optional per key (missing keys show in English).
 */
export function registerStrings<K extends string>(ns: string, strings: { ko: Record<K, string>; en: Record<NoInfer<K>, string>; ja?: Partial<Record<NoInfer<K>, string>> }): void {
  dicts.set(ns, strings)
  emit()
}

/** Read-only view of every registered table, for Node checks. */
export function listDictionaries(): ReadonlyMap<string, Readonly<Dicts>> {
  return dicts
}

export function getLang(): Lang {
  return current
}

/** Changes the screen language in memory only; the engine's settings keep the choice after unlock. */
export function setLang(lang: Lang): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lang
  if (lang === current) return
  current = lang
  emit()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export type TFn = (key: string, vars?: Vars) => string

function translate(ns: string, lang: Lang, key: string, vars?: Vars): string {
  const d = dicts.get(ns)
  const s = d?.[lang]?.[key] ?? d?.en?.[key] ?? key
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
}

export function useT(ns: string): TFn {
  // setLang and registerStrings both bump version, so it alone tells when to re-render.
  const snap = useSyncExternalStore(subscribe, () => version)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((key, vars) => translate(ns, current, key, vars), [ns, snap])
}

/** The current screen language, re-rendering when it changes. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, () => current)
}
