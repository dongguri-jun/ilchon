import { useCallback, useSyncExternalStore } from 'react'
import type { Lang } from '../contracts'

type Dict = Record<string, string>
type Vars = Record<string, string | number>

const dicts = new Map<string, Record<Lang, Dict>>()
const listeners = new Set<() => void>()

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('ilchon:lang')
    if (saved === 'ko' || saved === 'en') return saved
  } catch {
    // Storage may be unavailable; fall back to the browser language.
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ko')) return 'ko'
  } catch {
    // ignore
  }
  return typeof navigator === 'undefined' ? 'ko' : 'en'
}

let current: Lang = initialLang()
if (typeof document !== 'undefined') document.documentElement.lang = current
// Bumped on every registration so useT re-renders when strings arrive late.
let version = 0

function emit() {
  version++
  listeners.forEach((l) => l())
}

export function registerStrings(ns: string, strings: { ko: Dict; en: Dict }): void {
  dicts.set(ns, strings)
  emit()
}

export function getLang(): Lang {
  return current
}

export function setLang(lang: Lang): void {
  try {
    localStorage.setItem('ilchon:lang', lang)
  } catch {
    // Switching still works when storage is unavailable.
  }
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
  const snap = useSyncExternalStore(subscribe, () => version * 2 + (current === 'ko' ? 0 : 1))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback((key, vars) => translate(ns, current, key, vars), [ns, snap])
}
