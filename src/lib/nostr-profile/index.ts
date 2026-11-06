import { bech32 } from '@scure/base'
import { verifyEvent, type NostrEvent } from 'applesauce-core/helpers/event'
import { getProfileNamespace } from '../profile'

export interface NostrProfile {
  name: string
  display_name: string
  picture: string
  about: string
  nip05: string
  lud16: string
}
export interface LinkedProfile extends NostrProfile {
  pubkey: string
  nip05Verified: boolean
}
const HEX = /^[a-f0-9]{64}$/i
const RELAYS = ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']

export function parseNpubOrHex(input: string): string | null {
  try {
    const value = input.trim()
    if (HEX.test(value)) return value.toLowerCase()
    if (value.length > 5000) return null
    const { prefix, words } = bech32.decode(value as `${string}1${string}`, 5000)
    const bytes = bech32.fromWords(words)
    let key: Uint8Array | undefined
    if (prefix === 'npub' && bytes.length === 32) key = bytes
    if (prefix === 'nprofile') {
      for (let i = 0; i < bytes.length;) {
        if (i + 2 > bytes.length) return null
        const type = bytes[i++], length = bytes[i++]
        if (i + length > bytes.length) return null
        if (type === 0) {
          if (length !== 32 || key) return null
          key = bytes.slice(i, i + length)
        }
        i += length
      }
    }
    return key ? Array.from(key, (n) => n.toString(16).padStart(2, '0')).join('') : null
  } catch { return null }
}

function clean(value: unknown, cap: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, cap) : ''
}
function sanitize(data: Record<string, unknown>): NostrProfile {
  let picture = clean(data.picture, 2048)
  try {
    const url = new URL(picture)
    if (url.protocol !== 'https:' || url.username || url.password) picture = ''
  } catch { picture = '' }
  return { name: clean(data.name, 100), display_name: clean(data.display_name, 100), picture,
    about: clean(data.about, 1000), nip05: clean(data.nip05, 320), lud16: clean(data.lud16, 320) }
}

/** Read only: no identity keys, contact events, or publication are involved. */
export async function fetchProfile(pubkeyHex: string, { timeoutMs = 6000 }: { timeoutMs?: number } = {}): Promise<NostrProfile | null> {
  if (!HEX.test(pubkeyHex)) return null
  const pubkey = pubkeyHex.toLowerCase()
  const results = await Promise.all(RELAYS.map((relay) => new Promise<NostrEvent | null>((resolve) => {
    let socket: WebSocket | undefined
    let latest: NostrEvent | null = null
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (socket) {
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
        try {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(['CLOSE', 'profile']))
        } catch { /* A relay may have disconnected before CLOSE. */ }
        try { socket.close() } catch { /* Already closed. */ }
      }
      resolve(latest)
    }
    const timer = setTimeout(finish, Math.max(1, Math.min(timeoutMs, 30000)))
    try {
      socket = new WebSocket(relay)
      socket.onopen = () => socket?.send(JSON.stringify(['REQ', 'profile', { kinds: [0], authors: [pubkey], limit: 1 }]))
      socket.onerror = socket.onclose = finish
      socket.onmessage = ({ data }) => {
        try {
          if (typeof data !== 'string' || data.length > 100000) return
          const message = JSON.parse(data)
          if (!Array.isArray(message) || message[1] !== 'profile') return
          if (message[0] === 'EOSE' || message[0] === 'CLOSED') { finish(); return }
          if (message[0] !== 'EVENT') return
          const event = message[2] as NostrEvent
          if (event.kind !== 0 || event.pubkey !== pubkey || !Number.isSafeInteger(event.created_at) || !verifyEvent(event)) return
          if (!latest || event.created_at > latest.created_at || (event.created_at === latest.created_at && event.id < latest.id)) latest = event
        } catch { /* Ignore malformed or unsigned relay data. */ }
      }
    } catch { finish() }
  })))
  const latest = results.filter((e): e is NostrEvent => !!e).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0]
  try {
    const data = latest ? JSON.parse(latest.content) : null
    return data && typeof data === 'object' && !Array.isArray(data) ? sanitize(data) : null
  } catch { return null }
}

export async function verifyNip05(nip05: string, pubkeyHex: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    if (!HEX.test(pubkeyHex)) return false
    const match = /^([a-z0-9_.-]+)@([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i.exec(nip05)
    if (!match || !match[2].includes('.')) return false
    const response = await fetch(`https://${match[2]}/.well-known/nostr.json?name=${encodeURIComponent(match[1])}`, {
      signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
    })
    if (!response.ok) return false
    const data = await response.json()
    const key = data?.names?.[match[1]]
    return typeof key === 'string' && key.toLowerCase() === pubkeyHex.toLowerCase()
  } catch { return false } finally { clearTimeout(timer) }
}

const storageKey = (contactId: string) => `${getProfileNamespace()}:nostr:${contactId}`
export function readLinkedProfile(contactId: string): LinkedProfile | null {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey(contactId)) || 'null')
    if (!data || typeof data.pubkey !== 'string' || !HEX.test(data.pubkey)) return null
    return { ...sanitize(data), pubkey: data.pubkey.toLowerCase(), nip05Verified: data.nip05Verified === true }
  } catch { return null }
}
export function saveLinkedProfile(contactId: string, profile: LinkedProfile | null): boolean {
  try {
    if (profile) localStorage.setItem(storageKey(contactId), JSON.stringify(profile))
    else localStorage.removeItem(storageKey(contactId))
    return true
  } catch { return false }
}
