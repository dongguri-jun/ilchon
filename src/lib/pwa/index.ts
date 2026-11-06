import { useCallback, useEffect, useState } from 'react'

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const nav = navigator as Navigator & { standalone?: boolean }
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true
}

export function platform(): 'ios' | 'android' | 'other' {
  if (typeof navigator === 'undefined') return 'other'
  const ua = navigator.userAgent
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
  if (/iPhone|iPad|iPod/.test(ua) || iPadOS) return 'ios'
  if (/Android/.test(ua)) return 'android'
  return 'other'
}

export async function requestPersistence(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch {
    return null
  }
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

// beforeinstallprompt can fire before any component mounts; capture it at module load.
let deferred: InstallPromptEvent | null = null
let installedFlag = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e as InstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    installedFlag = true
    notify()
  })
}

export function usePwaInstall(): { canPrompt: boolean; prompt(): Promise<void>; installed: boolean } {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  const prompt = useCallback(async () => {
    const e = deferred
    if (!e) return
    deferred = null
    notify()
    try {
      await e.prompt()
      const r = await e.userChoice
      if (r.outcome === 'accepted') {
        installedFlag = true
        notify()
      }
    } catch {
      /* ignore */
    }
  }, [])
  return { canPrompt: deferred !== null, prompt, installed: installedFlag || isStandalone() }
}
