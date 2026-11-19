/**
 * Engine check scenarios: the support log (S-LOG-*, S-REC-LOG).
 * Run from scripts/check-engine.ts, which lists every scenario in its order.
 */
import { npubOf } from '../../../src/lib/marmot/keys'
import { hasText } from '../helpers/channel'
import { leakRun } from '../helpers/leak'
import { ADDR_TR, ADDR_WPKH, LN_ADDRESS } from '../helpers/payment'
import { type TwinScript, twin } from '../helpers/twin'
import { AMOUNT, DONE_NUMBERS, FEE, holdsNumber } from '../markers'
import { expect } from '../report'
import { BOTH, MIN, START_MS, type World, allWorlds, finish, sent } from '../world'

// ---------------------------------------------------------------- support log

/** Everything that points at a peer or a trade in this world: what no support log may hold. */
function secretsOf(w: World, extra: { offerIds?: string[] } = {}): { what: string; value: string }[] {
  const out: { what: string; value: string }[] = []
  for (const p of w.peers) {
    out.push({ what: `${p.name} pubkey`, value: p.pk }, { what: `${p.name} pubkey head`, value: p.pk.slice(0, 8) }, { what: `${p.name} npub`, value: npubOf(p.pk) })
    out.push({ what: `${p.name} npub body`, value: npubOf(p.pk).slice(5, 20) })
    // The secret key and the 12 words (two words in a row: one word alone is plain English).
    const ws = p.words.split(' ')
    out.push({ what: `${p.name} secret key`, value: p.sk }, { what: `${p.name} secret key head`, value: p.sk.slice(0, 16) })
    for (let i = 0; i + 1 < ws.length; i++) out.push({ what: `${p.name} words ${i + 1}-${i + 2}`, value: `${ws[i]} ${ws[i + 1]}` })
  }
  for (const id of extra.offerIds ?? []) out.push({ what: 'offer id', value: id })
  for (const payload of w.payloads) {
    out.push({ what: 'connection code', value: payload })
    if (payload.length > 30) out.push({ what: 'connection code part', value: payload.slice(10, 30) })
  }
  for (const e of w.hub.log) {
    out.push({ what: 'group id', value: e.groupId }, { what: 'group id head', value: e.groupId.slice(0, 8) }, { what: 'message id', value: e.id })
    try {
      const m = JSON.parse(e.json) as { sid?: unknown; code?: unknown; text?: unknown }
      if (typeof m.sid === 'string') out.push({ what: 'round sid', value: m.sid })
      if (typeof m.code === 'string' && m.code.length >= 6) out.push({ what: 'link code', value: m.code })
      if (typeof m.text === 'string' && m.text.length >= 4) out.push({ what: 'chat text', value: m.text })
    } catch {
      // not readable: nothing to look for
    }
  }
  // The key package references the QRs carried and the tags of rooms made from a scan.
  for (const r of w.hub.invites) {
    if (r.kpRef) out.push({ what: 'key package reference', value: r.kpRef })
    const tag = w.hub.tagOf(r.groupId)
    if (tag) out.push({ what: 'room tag', value: tag })
  }
  for (const name of namesOf(w)) out.push({ what: 'contact name', value: name })
  out.push({ what: 'chat marker', value: 'secret-chat-7f3a' }, { what: 'leak marker', value: 'ZQ-LEAK' })
  out.push({ what: 'draft account number', value: '110-123' })
  // Where a buyer receives: the Lightning address never travels,
  // and the addresses travel only as chat texts (searched above).
  out.push({ what: 'lightning address', value: LN_ADDRESS }, { what: 'on-chain address', value: ADDR_WPKH }, { what: 'on-chain address', value: ADDR_TR })
  return out
}

/**
 * The contact names of a world (given by renameContact, and held now) that a search can
 * tell from log text: three characters or more, or any non-ASCII name ('씨').
 */
function namesOf(w: World): string[] {
  const all = new Set(w.names)
  for (const p of w.peers) for (const c of p.state().contacts) if (c.name) all.add(c.name)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the range is the point, it matches any non-ASCII character
  return [...all].filter((n) => n.length >= 3 || /[^\x00-\x7f]/.test(n))
}

/** The amounts and fees the scenarios use, searched bare. */
const LOG_NUMBERS = [AMOUNT, FEE, 90000, 50000, ...DONE_NUMBERS]
/** Words of the trade and contact side that no log line has. */
const LOG_WORDS = ['match', 'contact', 'round', 'rx', 'peer=', 'from=', 'offer', 'verified']
/**
 * The fixed contact list lines say "contact list" by design: they
 * are taken out before LOG_WORDS is looked for, so the word still catches anything else.
 */
const LIST_LINE_TEXTS = [
  'contact list sync failed: no relay answered or accepted',
  'contact list sync incomplete',
  'contact list too big to save',
  'contact list copy could not be read',
  'damaged: contact-list',
]

function leaksIn(raw: string, secrets: { what: string; value: string }[]): string[] {
  const dump = LIST_LINE_TEXTS.reduce((d, text) => d.split(text).join(''), raw)
  const found: string[] = []
  for (const s of secrets) if (s.value && dump.includes(s.value)) found.push(`${s.what} (${s.value.slice(0, 12)})`)
  for (const n of LOG_NUMBERS) if (holdsNumber(dump, n)) found.push(`number ${n}`)
  for (const word of LOG_WORDS) if (dump.toLowerCase().includes(word)) found.push(`'${word}'`)
  return found
}

export async function sLogRedact(): Promise<void> {
  const r = await leakRun(true)
  // A relay-level warning as the transport passes it (setLogSink): relay and library
  // text with keys and addresses in it.
  for (const p of [r.A, r.B, r.C]) {
    p.log.marmot('relay refused a subscription, retrying in', [
      4000,
      'ms:',
      `wss://relay.example/?auth=${p.pk}`,
      `restricted: ${npubOf(p.pk)} pays ${AMOUNT}, see https://wallet.example/u/${p.pk.slice(0, 8)}`,
    ])
    p.log.marmot('relay rejected authentication', [`wss://u:${p.pk}@relay.example:4430/x?k=1`])
  }
  const secrets = secretsOf(r.w, { offerIds: r.offerIds })
  for (const p of [r.A, r.B, r.C]) {
    const dump = p.dumpLog()
    const found = leaksIn(dump, secrets)
    expect(found.length === 0, `${p.name}'s log holds ${found.join(', ')}\n${dump}`)
    const server = dump.split('\n').filter((l) => l.includes('  marmot  relay'))
    expect(server.length === 2, `${p.name}: two relay-level lines (${server.length})`)
    for (const l of server) {
      expect(
        !/[0-9a-f]{8,}/.test(l) && !l.includes('npub') && !l.includes('https') && !l.includes('wallet') && !l.includes('restricted') && !l.includes('auth=') && !l.includes('u:'),
        `${p.name}: no hex, npub, address or relay text in ${l}`,
      )
      expect(/\((refused|timeout|closed|auth)\)$/.test(l), `${p.name}: the relay text became a code in ${l}`)
    }
  }
  const a = r.A.dumpLog()
  expect(a.includes('engine  send failing (other), retrying'), `the refused round 1 left a line\n${a}`)
  expect(a.includes('link  started'), `the scan left a line\n${a}`)
  expect(a.includes('relay  fake://relay disconnected'), `the network going down left a line\n${a}`)
  const all = [r.A, r.B, r.C].map((p) => p.dumpLog()).join('\n')
  expect(all.includes('link  invite retry'), `the failed invite left a line\n${all}`)
  await finish(r.w)
}

/** A's chat to B waits behind refused sends; in world 2 A deletes B, so it goes stale there. */
export async function sLogTwinStale(aLow: boolean): Promise<void> {
  const script: TwinScript = {
    b: [
      { atMs: 0, act: (p) => p.a.postOffer({ side: 'sell', currency: 'KRW', amountMinor: 90000, feePct: 3, methods: BOTH }) },
      { atMs: 3 * MIN + 60 * MIN, act: async () => {} },
    ],
    a: [
      {
        atMs: 3 * MIN,
        act: async (p) => {
          p.world.hub.failSend = () => false
        },
      },
    ],
  }
  const r = await twin(script, {
    aLow,
    beforeSplit: async (w, A, B) => {
      w.hub.failSend = (from) => (from === A.pk ? 'reject' : false)
      await A.a.sendChat(B.pk, 'held back').catch(() => {})
      await w.clock.settle()
    },
  })
  const logs = r.logs
  expect(logs[0].includes('engine  send failing (other), retrying'), `the refused chat left a line\n${logs[0]}`)
  for (const w of r.worlds) await finish(w)
}

/** A posts while offline: world 1 has two contacts to ask, world 2 one. */
export async function sLogTwinOffline(aLow: boolean): Promise<void> {
  const script: TwinScript = {
    b: [{ atMs: 31 * MIN, act: async () => {} }],
    a: [
      {
        atMs: 0,
        act: async (p) => {
          p.world.hub.setNetwork(p.pk, 'down')
          await p.world.clock.settle()
          await p.a.postOffer({ side: 'buy', currency: 'KRW', amountMinor: AMOUNT, feePct: FEE, methods: BOTH })
        },
      },
      {
        atMs: MIN,
        act: async (p) => {
          p.world.hub.setNetwork(p.pk, 'up')
        },
      },
    ],
  }
  const r = await twin(script, { aLow, withC: true })
  const logs = r.logs
  expect(logs[0].includes('relay  fake://relay disconnected'), `the network went down\n${logs[0]}`)
  expect(logs[0].includes('engine  send failing (other), retrying'), `the round 1 sends failed\n${logs[0]}`)
  for (const w of r.worlds) await finish(w)
}

/**
 * Ten minutes after the split A and B meet and scan each other again. World 1: two
 * contacts, both 'already', nothing on the wire. World 2: A deleted B, so A links from
 * scratch and ends 'done' with an empty name and chat; B still says
 * 'already' and keeps everything. A's support log is the same in both worlds (twin()).
 */
export async function sLogTwinRescan(aLow: boolean): Promise<void> {
  const script: TwinScript = {
    b: [{ atMs: 15 * MIN, act: async () => {} }],
    a: [
      {
        atMs: 10 * MIN,
        act: async (A) => {
          const B = A.world.peers[1]
          A.a.startConnect()
          B.a.startConnect()
          const pa = A.state().connect.myPayload ?? ''
          const pb = B.state().connect.myPayload ?? ''
          A.world.payloads.push(pa, pb)
          void A.a.submitScan(pb).catch(() => {})
          void B.a.submitScan(pa).catch(() => {})
          await A.world.clock.settle()
        },
      },
    ],
  }
  const r = await twin(script, { aLow, relink: true })
  const logs = r.logs
  const lines = logs[0].split('\n')
  const startedAt = (l: string) => / {2}link {2}started( \(x(\d+)\))?$/.exec(l)
  const started = lines.reduce((n, l) => n + (startedAt(l) ? Number(startedAt(l)?.[2] ?? 1) : 0), 0)
  expect(started === 2, `the first link and the scan again each left 'link  started' (${started})\n${logs[0]}`)
  let last = -1
  lines.forEach((l, i) => {
    if (startedAt(l)) last = i
  })
  // No 'already' line in world 1 and no success line in world 2; twin()
  // found the two logs the same.
  expect(!lines.slice(last + 1).some((l) => l.includes('  link  ')), `no link line after the scan\n${logs[0]}`)
  const splitAt = START_MS + 10 * MIN
  for (let i = 0; i < 2; i++) {
    const [A, B] = [r.a[i], r.b[i]]
    const cb = B.state().contacts.find((c) => c.pubkey === A.pk)
    expect(B.state().connect.phase === 'already' && !!cb, `world ${i + 1}: B's scan ends in 'already' and B keeps A`)
    expect(hasText(B, A, 'hi'), `world ${i + 1}: B's chat with A stays`)
    if (i === 0) {
      expect(A.state().connect.phase === 'already', "world 1: A's scan of a contact ends in 'already'")
      const after = [...sent(r.worlds[0], A, B), ...sent(r.worlds[0], B, A)].filter((e) => e.atMs >= splitAt)
      expect(after.every((e) => e.t === 'hello') && r.worlds[0].hub.invites.every((x) => x.atMs < splitAt), "world 1: only the holders' proofs and echoes after the scans, no invite")
    } else {
      const ca = A.state().contacts.find((c) => c.pubkey === B.pk)
      expect(A.state().connect.phase === 'done' && !!ca, `world 2: A re-adds B by scanning (${A.state().connect.phase})`)
      expect(ca?.name === '' && (A.state().rooms[B.pk] ?? []).length === 0, 'world 2: from scratch, an empty name and chat')
      expect(!(B.pk in (A.kv.peek<Record<string, unknown>>('tombstones') ?? {})), 'world 2: no tombstone of B is left')
      expect(!!ca?.groupId && ca.groupId === cb?.groupId, 'world 2: A and B share one room')
    }
  }
  for (const w of r.worlds) await finish(w)
}

/** S-REC-LOG: the list and restore lines across the S-REC worlds: fixed words, no keys, no names, no words. */
export async function sRecLog(): Promise<void> {
  const bad: string[] = []
  let named = 0
  for (const w of allWorlds) {
    const names = namesOf(w)
    for (const p of w.peers) {
      const dump = p.dumpLog()
      for (const line of dump.split('\n')) {
        if (!/contact list|restore check|list changed|list future|list single|key used/.test(line)) continue
        if (/[0-9a-f]{64}/.test(line) || /\bfound\b|not-found/.test(line)) bad.push(`${p.name}: ${line}`)
        // A contact's name (and every rename) never reaches a list or restore line.
        for (const n of names) if (line.includes(n)) bad.push(`${p.name} (contact name '${n}'): ${line}`)
        if (names.length) named++
        if (/list (changed|future|single)|key used/.test(line) && /\d+\s*(-|$)/.test(line.replace(/^.*?(list|key used)/, ''))) bad.push(`${p.name} (number): ${line}`)
      }
      if (
        p.words &&
        p.words
          .split(' ')
          .slice(0, 2)
          .every((x) => dump.includes(x)) &&
        dump.includes(p.words.split(' ').slice(0, 3).join(' '))
      )
        bad.push(`${p.name}: its words`)
    }
  }
  expect(named > 0, `list and restore lines of worlds with named contacts were searched (${named})`)
  expect(bad.length === 0, `support log lines hold values:\n  ${bad.slice(0, 5).join('\n  ')}`)
}

/** The last scenario: every support log of every world of this run, searched wide. */
export async function sLogSweep(): Promise<void> {
  const problems: string[] = []
  let logs = 0
  for (const w of allWorlds) {
    const secrets = secretsOf(w)
    for (const p of w.peers) {
      logs++
      const found = leaksIn(p.dumpLog(), secrets)
      if (found.length) problems.push(`${p.name}: ${found.join(', ')}`)
    }
  }
  expect(logs > 50, `the sweep saw the logs of the run (${logs})`)
  expect(problems.length === 0, `support logs hold trade or peer values:\n  ${problems.slice(0, 10).join('\n  ')}`)
}
