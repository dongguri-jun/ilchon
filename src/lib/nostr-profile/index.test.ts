import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bech32 } from '@scure/base'
import { finalizeEvent } from 'applesauce-core/helpers/event'
import { fetchProfile, parseNpubOrHex, readLinkedProfile, saveLinkedProfile, verifyNip05 } from './index'

const bytes = new Uint8Array(32).fill(1)
const hex = '01'.repeat(32)
test('parses hex, npub and nprofile; rejects malformed keys and TLV', () => {
  assert.equal(parseNpubOrHex(` ${hex.toUpperCase()} `), hex)
  assert.equal(parseNpubOrHex(bech32.encode('npub', bech32.toWords(bytes))), hex)
  assert.equal(parseNpubOrHex(bech32.encode('nprofile', bech32.toWords(new Uint8Array([0, 32, ...bytes])))), hex)
  for (const value of ['bad', hex.slice(1), bech32.encode('npub', [0]), bech32.encode('nprofile', bech32.toWords(new Uint8Array([0, 32, 1])))]) {
    assert.equal(parseNpubOrHex(value), null)
  }
})

test('queries four relays, verifies signatures, selects latest and sanitizes metadata', async () => {
  const original = globalThis.WebSocket
  const older = finalizeEvent({ kind: 0, created_at: 1, tags: [], content: '{"name":"old"}' }, bytes)
  const newer = finalizeEvent({ kind: 0, created_at: 2, tags: [], content: JSON.stringify({ display_name: 'A'.repeat(200), name: 'new\u0000name', picture: 'http://bad.test/a', about: 'hello', nip05: 123 }) }, bytes)
  let count = 0
  let closed = 0
  class Socket {
    static OPEN = 1
    readyState = 1
    onopen: (() => void) | null = null
    onmessage: ((message: { data: string }) => void) | null = null
    onerror = null
    onclose = null
    constructor() { count++; queueMicrotask(() => this.onopen?.()) }
    send(data: string) {
      if (JSON.parse(data)[0] !== 'REQ') return
      for (const event of [older, newer, { ...newer, created_at: 999 }]) this.onmessage?.({ data: JSON.stringify(['EVENT', 'profile', event]) })
      this.onmessage?.({ data: JSON.stringify(['EOSE', 'profile']) })
    }
    close() { closed++ }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket
  try {
    const profile = await fetchProfile(newer.pubkey, { timeoutMs: 100 })
    assert.equal(count, 4)
    assert.equal(closed, 4)
    assert.equal(profile?.name, 'new name')
    assert.equal(profile?.display_name.length, 100)
    assert.equal(profile?.picture, '')
    assert.equal(profile?.nip05, '')
  } finally { globalThis.WebSocket = original }
})

test('relay timeout closes every socket and returns null', async () => {
  const original = globalThis.WebSocket
  let closed = 0
  class Socket {
    static OPEN = 1
    readyState = 1
    send() {}
    close() { closed++ }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket
  try {
    assert.equal(await fetchProfile(hex, { timeoutMs: 5 }), null)
    assert.equal(closed, 4)
  } finally { globalThis.WebSocket = original }
})

test('NIP-05 checks matching key and handles failures without throwing', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://example.com/.well-known/nostr.json?name=alice')
      assert.equal(options?.credentials, 'omit')
      return new Response(JSON.stringify({ names: { alice: hex } }))
    }
    assert.equal(await verifyNip05('alice@example.com', hex), true)
    assert.equal(await verifyNip05('alice@example.com', '02'.repeat(32)), false)
    assert.equal(await verifyNip05('not-an-address', hex), false)
    globalThis.fetch = async () => { throw new Error('offline') }
    assert.equal(await verifyNip05('alice@example.com', hex), false)
  } finally { globalThis.fetch = original }
})

test('storage is namespaced, removable and resilient to corrupt or denied storage', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } })
  try {
    assert.equal(saveLinkedProfile('contact', { pubkey: hex, name: 'Alice', display_name: '', picture: '', about: '', nip05: '', lud16: '', nip05Verified: false }), true)
    assert.ok(values.has('ilchon:default:nostr:contact'))
    assert.equal(readLinkedProfile('contact')?.name, 'Alice')
    assert.equal(saveLinkedProfile('contact', null), true)
    assert.equal(readLinkedProfile('contact'), null)
    values.set('ilchon:default:nostr:contact', '{broken')
    assert.equal(readLinkedProfile('contact'), null)
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied') } })
    assert.equal(readLinkedProfile('contact'), null)
    assert.equal(saveLinkedProfile('contact', null), false)
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
