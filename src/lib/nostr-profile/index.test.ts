import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bech32 } from '@scure/base'
import { finalizeEvent } from 'applesauce-core/helpers/event'
import type { Memo } from '../../contracts'
import { STORED_PROFILE_KEYS, fetchProfile, parseNpubOrHex, readLinkedProfile, saveLinkedProfile, verifyNip05 } from './index'

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

test('queries three relays, verifies signatures, selects latest and sanitizes metadata', async () => {
  const original = globalThis.WebSocket
  const older = finalizeEvent({ kind: 0, created_at: 1, tags: [], content: '{"name":"old"}' }, bytes)
  const newer = finalizeEvent(
    { kind: 0, created_at: 2, tags: [], content: JSON.stringify({ display_name: 'A'.repeat(200), name: 'new\u0000name', picture: 'http://bad.test/a', about: 'hello', nip05: 123 }) },
    bytes,
  )
  let count = 0
  let closed = 0
  class Socket {
    static OPEN = 1
    readyState = 1
    onopen: (() => void) | null = null
    onmessage: ((message: { data: string }) => void) | null = null
    onerror = null
    onclose = null
    constructor() {
      count++
      queueMicrotask(() => this.onopen?.())
    }
    send(data: string) {
      if (JSON.parse(data)[0] !== 'REQ') return
      for (const event of [older, newer, { ...newer, created_at: 999 }]) this.onmessage?.({ data: JSON.stringify(['EVENT', 'profile', event]) })
      this.onmessage?.({ data: JSON.stringify(['EOSE', 'profile']) })
    }
    close() {
      closed++
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket
  try {
    const profile = await fetchProfile(newer.pubkey, { timeoutMs: 100 })
    assert.equal(count, 3)
    assert.equal(closed, 3)
    assert.equal(profile?.name, 'new name')
    assert.equal(profile?.display_name.length, 100)
    // No remote picture is kept, whatever the profile says.
    assert.equal(profile && 'picture' in profile, false)
    assert.equal(profile?.nip05, '')
  } finally {
    globalThis.WebSocket = original
  }
})

test('relay timeout closes every socket and returns null', async () => {
  const original = globalThis.WebSocket
  let closed = 0
  class Socket {
    static OPEN = 1
    readyState = 1
    send() {}
    close() {
      closed++
    }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket
  try {
    assert.equal(await fetchProfile(hex, { timeoutMs: 5 }), null)
    assert.equal(closed, 3)
  } finally {
    globalThis.WebSocket = original
  }
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
    globalThis.fetch = async () => {
      throw new Error('offline')
    }
    assert.equal(await verifyNip05('alice@example.com', hex), false)
  } finally {
    globalThis.fetch = original
  }
})

test('the linked profile lives in memo under nostr:<contactId>, only the README keys', () => {
  const values = new Map<string, unknown>()
  let locked = false
  const memo: Memo = {
    get: <T>(key: string) => (locked ? undefined : (values.get(key) as T | undefined)),
    set: (key, value) => {
      if (locked) return false
      values.set(key, value)
      return true
    },
    del: (key) => {
      if (locked) return false
      values.delete(key)
      return true
    },
  }
  const extra = { pubkey: hex, name: 'Alice', display_name: '', about: '', nip05: '', lud16: 'a@example.com', picture: 'https://example.com/a.png' }
  assert.equal(saveLinkedProfile(memo, 'contact', extra), true)
  // The key ends with :<contactId>, so removing the contact removes it (Memo).
  assert.deepEqual([...values.keys()], ['nostr:contact'])
  // Exactly the keys README names, whatever the caller passes.
  assert.deepEqual(Object.keys(values.get('nostr:contact') as object).sort(), [...STORED_PROFILE_KEYS].sort())
  assert.deepEqual([...STORED_PROFILE_KEYS].sort(), ['about', 'display_name', 'name', 'nip05', 'pubkey'])
  assert.equal(readLinkedProfile(memo, 'contact')?.name, 'Alice')
  // A record with more fields loses its picture and any stored NIP-05 badge on reading.
  values.set('nostr:contact', { pubkey: hex, name: 'Old', picture: 'https://example.com/a.png', nip05: 'a@example.com', nip05Verified: true })
  const old = readLinkedProfile(memo, 'contact')
  assert.equal(old?.name, 'Old')
  assert.equal(old && 'picture' in old, false)
  assert.equal(old && 'nip05Verified' in old, false)
  assert.equal(saveLinkedProfile(memo, 'contact', null), true)
  assert.equal(readLinkedProfile(memo, 'contact'), null)
  for (const bad of ['{broken', null, 7, { pubkey: 'zz' }]) {
    values.set('nostr:contact', bad)
    assert.equal(readLinkedProfile(memo, 'contact'), null)
  }
  // Locked: nothing is read and a save reports that it did not take.
  values.set('nostr:contact', { pubkey: hex, name: 'Alice' })
  locked = true
  assert.equal(readLinkedProfile(memo, 'contact'), null)
  assert.equal(saveLinkedProfile(memo, 'other', extra), false)
  assert.equal(values.has('nostr:other'), false)
  // Unlinking while locked removes nothing, and says so (a locked memo reads nothing,
  // so reading back after the removal would have claimed it worked).
  assert.equal(saveLinkedProfile(memo, 'contact', null), false)
  assert.equal(values.has('nostr:contact'), true)
})
