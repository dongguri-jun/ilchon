/**
 * My contact list event on its own: L-1 to L-5, plus the size and leak checks and the
 * hub's list store; L-6 to L-11 cover the digest and the merge.
 * No network. Run: pnpm check:list
 */
import { verifyEvent, type NostrEvent } from 'applesauce-core/helpers/event'
import { PrivateKeySigner } from 'applesauce-signers'
import { applyPlanTo, decodeList, digest, EMPTY_DIGEST, emptyPlan, encodeList, LIST_BYTES, LIST_FUTURE_MS, mergeInto, type ListBody, type ListView, type MergePlan } from '../src/engine/contact-list'
import { generateSecretKeyHex, npubOf, pubkeyOf } from '../src/lib/marmot/keys'
import { listDOf, listFilter, listPubkeyOf, listSecretOf, openList, sealList } from '../src/lib/marmot/list'
import { createFakeClock, createFakeHub } from './fake-transport'

let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS  ${name}`)
  else {
    failed++
    console.log(`FAIL  ${name}${detail ? `\n  ${detail}` : ''}`)
  }
}
async function rejects(p: Promise<unknown>): Promise<string | null> {
  try {
    await p
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
function throwsMessage(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const utf8 = new TextEncoder()
const bytes = (s: string) => utf8.encode(s).length
const hex = (n: number) => n.toString(16).padStart(64, '0')

// The ilchon key of the NIP-06 test words (account 4242) and its list key.
const ILCHON_SK = '3d1062416e2e14dc6e29d9deabd63c89d41fa4b663bd65597070995499f1503a'
const ILCHON_PK = 'd13ce3936b2f4925c59422feaff22eda09467fe1fe706699bb443f2c893a22fb'
const LIST_SK = 'cb58e56456cfc546ef0cb76f19699212f86eaf1c8a38bbf5cdfd3bc3dd8d91be'
const LIST_PK = '373df4ef2081fc4def0305a0b838c319b3e63b0070608dc951a3934bc8a6af66'
const LIST_D = '3f2bb106b50314a32562be1610b4f4b1'

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)
const KO40 = '가'.repeat(20) + '나'.repeat(20)

/** n contacts with 40-character Korean names (120 UTF-8 bytes each). */
function koreanContacts(n: number, from = 1): [string, string, number][] {
  return Array.from({ length: n }, (_, i) => [hex(from + i), KO40, NOW - 1000 - i] as [string, string, number])
}

/** Any object padded the way encodeList pads, so decodeList sees the right size. */
function padded(obj: Record<string, unknown>): string {
  const head = JSON.stringify({ ...obj, p: '' })
  return `${head.slice(0, -2)}${' '.repeat(Math.max(0, LIST_BYTES - bytes(head)))}"}`
}

const empty: ListBody = { v: 1, c: [], d: [] }
const one: ListBody = { v: 1, c: [[hex(7), 'Mina', NOW - 5000]], d: [] }
const many: ListBody = { v: 1, c: koreanContacts(150), d: [] }

async function main(): Promise<void> {
  // ------------------------------------------------------------ L-1
  check('L-1 list secret from the ilchon key', Buffer.from(listSecretOf(ILCHON_SK)).toString('hex') === LIST_SK)
  check('L-1 list pubkey', listPubkeyOf(ILCHON_SK) === LIST_PK)
  check('L-1 d value', listDOf(ILCHON_SK) === LIST_D)
  check('L-1 the list key is not the account key', listPubkeyOf(ILCHON_SK) !== pubkeyOf(ILCHON_SK) && pubkeyOf(ILCHON_SK) === ILCHON_PK)
  const f = listFilter(ILCHON_SK)
  check('L-1 query: kind 30078, the list key, my d, one event', JSON.stringify(f) === JSON.stringify({ kinds: [30078], authors: [LIST_PK], '#d': [LIST_D], limit: 1 }))

  // ------------------------------------------------------------ L-2
  const encoded = [empty, one, many].map((b) => encodeList(b))
  check(
    'L-2 0, 1 and 150 contacts (40 Korean characters each) are all exactly 32768 bytes',
    encoded.every((p) => bytes(p) === LIST_BYTES),
    encoded.map(bytes).join(','),
  )
  check(
    'L-2 each decodes back to the same lists',
    [empty, one, many].every((b, i) => JSON.stringify(decodeList(encoded[i], ILCHON_PK, NOW)) === JSON.stringify({ v: 1, c: [...b.c].sort(), d: b.d })),
  )
  const unsorted = encodeList({
    v: 1,
    c: [
      [hex(9), 'b', 1],
      [hex(3), 'a', 2],
    ],
    d: [
      [hex(8), 3],
      [hex(2), 4],
    ],
  })
  const parsed = JSON.parse(unsorted) as { c: [string][]; d: [string][] }
  check('L-2 entries are sorted by pubkey', parsed.c[0][0] === hex(3) && parsed.d[0][0] === hex(2))

  // ------------------------------------------------------------ L-3
  check('L-3 170 contacts with 40 Korean characters: list-too-big', throwsMessage(() => encodeList({ v: 1, c: koreanContacts(170), d: [] })) === 'list-too-big')
  const deletions: [string, number][] = Array.from({ length: 300 }, (_, i) => [hex(5000 + i), NOW - i])
  const nameless = koreanContacts(100).map(([pk, , at]) => [pk, '', at] as [string, string, number])
  check('L-3 100 nameless contacts + 300 deletions: list-too-big (deletions are never dropped)', throwsMessage(() => encodeList({ v: 1, c: nameless, d: deletions })) === 'list-too-big')

  // ------------------------------------------------------------ L-4
  const createdAt = Math.floor(NOW / 1000)
  const events: NostrEvent[] = []
  for (const payload of encoded) events.push(await sealList(ILCHON_SK, payload, createdAt))
  const [e0, e1, eMany] = events
  check(
    'L-4 sealed by the list key, kind 30078, created_at as given',
    events.every((e) => e.pubkey === LIST_PK && e.kind === 30078 && e.created_at === createdAt && verifyEvent(e)),
  )
  check(
    'L-4 exactly one tag: [d, listD]',
    events.every((e) => JSON.stringify(e.tags) === JSON.stringify([['d', LIST_D]])),
  )
  check('L-4 openList gives back the same plaintext', (await openList(ILCHON_SK, eMany)) === encoded[2] && (await openList(ILCHON_SK, e0)) === encoded[0])
  const lengths = events.map((e) => e.content.length)
  check(
    'L-4 content length is the same for 0, 1 and 150 contacts',
    lengths.every((n) => n === lengths[0]),
    lengths.join(','),
  )
  check(
    'L-4 whole event size is the same for 0, 1 and 150 contacts',
    events.every((e) => JSON.stringify(e).length === JSON.stringify(e0).length),
  )
  const other = generateSecretKeyHex()
  check('L-4 another key cannot open it', (await openList(other, e1)) === null)
  const forged = await sealList(other, encoded[1], createdAt)
  check('L-4 a copy by another key (other author, other d) is not mine', (await openList(ILCHON_SK, { ...forged })) === null)
  const at = 40
  // A fresh copy, as from a relay: the library caches a verified flag on the event object.
  const flipped = { ...(JSON.parse(JSON.stringify(e1)) as NostrEvent), content: e1.content.slice(0, at) + (e1.content[at] === 'A' ? 'B' : 'A') + e1.content.slice(at + 1) }
  check('L-4 one changed character fails the signature check', !verifyEvent(flipped) && (await openList(ILCHON_SK, flipped)) === null)
  const listSigner = new PrivateKeySigner(listSecretOf(ILCHON_SK))
  const resigned = await listSigner.signEvent({ kind: 30078, created_at: createdAt, tags: [['d', LIST_D]], content: flipped.content })
  check('L-4 changed content signed again by the list key still does not decrypt (NIP-44 MAC)', verifyEvent(resigned) && (await openList(ILCHON_SK, resigned)) === null)
  const otherD = await listSigner.signEvent({ kind: 30078, created_at: createdAt, tags: [['d', '0'.repeat(32)]], content: e1.content })
  check('L-4 a different d is not mine', (await openList(ILCHON_SK, otherD)) === null)
  const twoD = await listSigner.signEvent({
    kind: 30078,
    created_at: createdAt,
    tags: [
      ['d', LIST_D],
      ['d', LIST_D],
    ],
    content: e1.content,
  })
  check('L-4 two d tags are not mine', (await openList(ILCHON_SK, twoD)) === null)
  const otherKind = await listSigner.signEvent({ kind: 30079, created_at: createdAt, tags: [['d', LIST_D]], content: e1.content })
  check('L-4 another kind is not mine', (await openList(ILCHON_SK, otherKind)) === null)
  check('L-4 created_at must be whole seconds', (await rejects(sealList(ILCHON_SK, encoded[0], 1.5))) !== null)

  // Nothing about the contacts is readable from the event: no pubkey, name, npub or app name.
  const leakNames = ['Mina-secret-name', '민아비밀이름']
  const leakBody: ListBody = {
    v: 1,
    c: [
      [hex(11), leakNames[0], NOW - 10],
      [hex(12), leakNames[1], NOW - 9],
    ],
    d: [[hex(13), NOW - 8]],
  }
  const leakEvent = await sealList(ILCHON_SK, encodeList(leakBody), createdAt)
  const wire = JSON.stringify(leakEvent)
  const needles = [hex(11), hex(12), hex(13), npubOf(hex(11)), ...leakNames, JSON.stringify(leakNames[1]).slice(1, -1), ILCHON_PK, npubOf(ILCHON_PK), 'ilchon', 'contact']
  const leaks = needles.filter((n) => wire.toLowerCase().includes(n.toLowerCase()))
  check('L-4 tags and content carry no contact pubkey, name, my pubkey or app name in plain text', leaks.length === 0, `found: ${leaks.join(', ')}`)

  // ------------------------------------------------------------ L-5
  const good = { v: 1, c: [[hex(21), 'Kim', NOW - 1]], d: [[hex(22), NOW - 2]] }
  check('L-5 a well-formed copy is read', decodeList(padded(good), ILCHON_PK, NOW) !== null)
  const reject: [string, string][] = [
    ['v: 2 (unknown version)', padded({ ...good, v: 2 })],
    ['no v', padded({ c: good.c, d: good.d })],
    ['no c', padded({ v: 1, d: good.d })],
    ['d not an array', padded({ v: 1, c: good.c, d: {} })],
    ['upper-case pubkey', padded({ ...good, c: [[hex(21).replace(/0/g, 'A').toUpperCase(), 'Kim', 1]] })],
    ['short pubkey', padded({ ...good, c: [['ab', 'Kim', 1]] })],
    ['my own pubkey in c', padded({ ...good, c: [[ILCHON_PK, 'me', 1]] })],
    ['my own pubkey in d', padded({ ...good, d: [[ILCHON_PK, 1]] })],
    ['41-character name', padded({ ...good, c: [[hex(21), 'x'.repeat(41), 1]] })],
    ['name not a string', padded({ ...good, c: [[hex(21), 5, 1]] })],
    ['negative createdAt', padded({ ...good, c: [[hex(21), 'Kim', -1]] })],
    ['negative deletion time', padded({ ...good, d: [[hex(22), -5]] })],
    ['time not finite (string)', padded({ ...good, d: [[hex(22), 'soon']] })],
    ['entry of the wrong length', padded({ ...good, c: [[hex(21), 'Kim']] })],
    ['contact createdAt at now + 10 min + 1 ms (more than 10 min in the future)', padded({ ...good, c: [[hex(21), 'Kim', NOW + LIST_FUTURE_MS + 1]] })],
    ['deletion at now + 10 min + 1 ms (more than 10 min in the future)', padded({ ...good, d: [[hex(22), NOW + LIST_FUTURE_MS + 1]] })],
    ['pad that is not spaces', padded({ ...good }).replace(/ {3}"}$/, 'xyz"}')],
    ['broken JSON', `{${padded(good).slice(1, -2)}`],
    ['truncated (one byte short)', padded(good).slice(0, -1)],
    ['one byte too long', `${padded(good)} `],
    ['short but valid JSON (not padded)', JSON.stringify(good)],
    ['not an object', padded({ v: 1, c: [], d: [] }).replace(/^\{/, '[').replace(/\}$/, ']')],
  ]
  for (const [what, payload] of reject) check(`L-5 rejected: ${what}`, decodeList(payload, ILCHON_PK, NOW) === null)
  check('L-5 contact createdAt exactly now + 10 min is read', decodeList(padded({ ...good, c: [[hex(21), 'Kim', NOW + LIST_FUTURE_MS]] }), ILCHON_PK, NOW) !== null)
  check('L-5 deletion exactly now + 10 min is read', decodeList(padded({ ...good, d: [[hex(22), NOW + LIST_FUTURE_MS]] }), ILCHON_PK, NOW) !== null)
  check('L-5 a 40-character name is read, a name is trimmed', decodeList(padded({ ...good, c: [[hex(21), `  ${'y'.repeat(40)}  `, 1]] }), ILCHON_PK, NOW)?.c[0][1] === 'y'.repeat(40))
  const twice = decodeList(
    padded({
      v: 1,
      c: [
        [hex(31), 'first', 1],
        [hex(31), 'second', 2],
      ],
      d: [],
    }),
    ILCHON_PK,
    NOW,
  )
  check('L-5 a pubkey twice in one array keeps the first', twice?.c.length === 1 && twice.c[0][1] === 'first')
  const tie = decodeList(
    padded({
      v: 1,
      c: [
        [hex(41), 'a', 100],
        [hex(42), 'b', 300],
      ],
      d: [
        [hex(41), 100],
        [hex(42), 200],
      ],
    }),
    ILCHON_PK,
    NOW,
  )
  check(
    'L-5 a pubkey in c and d keeps one: deletion at or after createdAt wins (tie: deletion), else the contact',
    JSON.stringify(tie) === JSON.stringify({ v: 1, c: [[hex(42), 'b', 300]], d: [[hex(41), 100]] }),
    JSON.stringify(tie),
  )

  // ------------------------------------------------------------ digest and merge
  const v = (c: ListView['c'], d: ListView['d']): ListView => ({ c, d })
  check('L-6 EMPTY_DIGEST is the digest of an empty list', EMPTY_DIGEST === digest([], []))
  const d1 = digest(
    [
      [hex(2), 'b', 2],
      [hex(1), 'a', 1],
    ],
    [
      [hex(4), 9],
      [hex(3), 8],
    ],
  )
  const d2 = digest(
    [
      [hex(1), 'a', 1],
      [hex(2), 'b', 2],
    ],
    [
      [hex(3), 8],
      [hex(4), 9],
    ],
  )
  check('L-6 the same content in another order has the same digest', d1 === d2)
  const viaPad = (() => {
    const b = decodeList(
      encodeList({
        v: 1,
        c: [
          [hex(2), 'b', 2],
          [hex(1), 'a', 1],
        ],
        d: [
          [hex(4), 9],
          [hex(3), 8],
        ],
      }),
      ILCHON_PK,
      NOW,
    )!
    return digest(b.c, b.d)
  })()
  check('L-6 the pad never changes the digest', viaPad === d1)
  check(
    'L-6 one name differs: another digest',
    digest(
      [
        [hex(1), 'a', 1],
        [hex(2), 'B', 2],
      ],
      [
        [hex(3), 8],
        [hex(4), 9],
      ],
    ) !== d1,
  )

  const plan = (p: Partial<MergePlan>): string => JSON.stringify({ add: [], revive: [], remove: [], tombs: [], ...p })
  const X = hex(50)
  // The seven rows of the merge table, and the tie.
  check('L-7 contact / contact: mine is kept (my name)', JSON.stringify(mergeInto(v([[X, 'mine', 10]], []), v([[X, 'theirs', 20]], []))) === plan({}))
  check('L-7 contact c / tombstone d >= c: removed', JSON.stringify(mergeInto(v([[X, 'n', 10]], []), v([], [[X, 20]]))) === plan({ remove: [{ pk: X, at: 20 }] }))
  check('L-7 contact c / tombstone d < c: kept', JSON.stringify(mergeInto(v([[X, 'n', 30]], []), v([], [[X, 20]]))) === plan({}))
  check('L-7 same time: the deletion wins', JSON.stringify(mergeInto(v([[X, 'n', 20]], []), v([], [[X, 20]]))) === plan({ remove: [{ pk: X, at: 20 }] }))
  check(
    "L-7 tombstone d / contact c > d: revived with the copy's name",
    JSON.stringify(mergeInto(v([], [[X, 10]]), v([[X, 'back', 20]], []))) === plan({ revive: [{ pk: X, name: 'back', createdAt: 20 }] }),
  )
  check('L-7 tombstone d / contact c <= d: stays deleted (a tie too)', JSON.stringify(mergeInto(v([], [[X, 20]]), v([[X, 'old', 20]], []))) === plan({}))
  check(
    'L-7 tombstone / tombstone: the later at',
    JSON.stringify(mergeInto(v([], [[X, 10]]), v([], [[X, 20]]))) === plan({ tombs: [{ pk: X, at: 20 }] }) && emptyPlan(mergeInto(v([], [[X, 20]]), v([], [[X, 10]]))),
  )
  check('L-7 none / contact: added', JSON.stringify(mergeInto(v([], []), v([[X, 'new', 5]], []))) === plan({ add: [{ pk: X, name: 'new', createdAt: 5 }] }))
  check('L-7 none / tombstone: a new tombstone', JSON.stringify(mergeInto(v([], []), v([], [[X, 5]]))) === plan({ tombs: [{ pk: X, at: 5 }] }))
  check('L-7 mine / none: kept', emptyPlan(mergeInto(v([[X, 'n', 1]], [[hex(51), 2]]), v([], []))))

  const big = v(
    [
      [hex(1), 'a', 1],
      [hex(2), 'b', 2],
    ],
    [[hex(3), 3]],
  )
  check('L-8 merging a list into itself changes nothing', emptyPlan(mergeInto(big, big)))
  const restored = mergeInto(v([], []), big)
  check('L-9 into an empty list: every contact is add, every tombstone is tombs', restored.add.length === 2 && restored.tombs.length === 1 && !restored.revive.length && !restored.remove.length)

  // L-10: two devices from one start; a adds E, b adds G and deletes X. Each merges the other.
  const E = hex(60),
    G = hex(61),
    Xd = hex(62),
    B0 = hex(63)
  const start = v(
    [
      [B0, 'b', 1],
      [Xd, 'x', 1],
    ],
    [],
  )
  const a = applyPlanTo(start, mergeInto(start, v([...start.c, [E, 'e', 5]], [])))
  const b = applyPlanTo(start, { add: [{ pk: G, name: 'g', createdAt: 6 }], revive: [], remove: [{ pk: Xd, at: 7 }], tombs: [] })
  const a2 = applyPlanTo(a, mergeInto(a, b))
  const b2 = applyPlanTo(b, mergeInto(b, a))
  const keys = (x: ListView) => JSON.stringify([x.c.map((e) => e[0]), x.d.map((e) => e[0])])
  check(
    'L-10 after crossing merges both hold E and G as contacts and X deleted',
    keys(a2) === keys(b2) && a2.c.some((e) => e[0] === E) && a2.c.some((e) => e[0] === G) && a2.d.some((e) => e[0] === Xd),
    `${keys(a2)} ${keys(b2)}`,
  )

  // L-11: old copies do no harm.
  const relinked = v([[X, 'again', 300]], [])
  const afterOld = applyPlanTo(applyPlanTo(relinked, mergeInto(relinked, v([[X, 'old', 100]], []))), mergeInto(relinked, v([], [[X, 200]])))
  check('L-11 (가) a contact linked again stays, with its new createdAt', JSON.stringify(afterOld) === JSON.stringify(relinked))
  const deleted = v([], [[X, 200]])
  check('L-11 (나) a deleted contact is not brought back by an old copy', emptyPlan(mergeInto(deleted, v([[X, 'old', 100]], []))))

  // ------------------------------------------------------------ hub list store (for the merge)
  const clock = createFakeClock(NOW)
  const hub = createFakeHub(clock)
  const sk = generateSecretKeyHex()
  const t = hub.marmot().createTransport({
    secretKeyHex: sk,
    relays: ['fake://a', 'fake://b'],
    namespace: 'x',
    persistence: 'memory',
    tables: {
      table: () => {
        throw new Error('unused')
      },
    } as never,
  })
  const lp = hub.listKeyOf(t.pubkey)!
  check('H-1 the hub knows the real list key', lp === listPubkeyOf(sk))
  const pub = t.publishList(encoded[1], createdAt, ['fake://a', 'fake://b'])
  await clock.advance(100)
  const accepted = await pub
  check('H-1 both relays take a copy; listLog has both', accepted.length === 2 && hub.listLog.length === 2 && hub.listLog.every((x) => x.accepted && x.listPubkey === lp))
  const fetchP = t.fetchList()
  await clock.advance(100)
  const got = await fetchP
  check(
    'H-1 fetchList returns both copies',
    got.copies.length === 2 && got.answered.length === 2 && got.asked.length === 2 && got.copies.every((c) => c.payload === encoded[1] && c.createdAt === createdAt),
  )
  const older = rejects(t.publishList(encoded[0], createdAt - 1, ['fake://a']))
  await clock.advance(100)
  check('H-2 an older created_at is not taken (replaceable rule)', (await older) === 'list-rejected' && hub.listOf('fake://a', lp)?.payload === encoded[1])
  hub.listFate = (relay, op) => (relay === 'fake://b' && op === 'fetch' ? 'silent' : 'ok')
  const t0 = clock.now()
  let partial: Awaited<ReturnType<typeof t.fetchList>> | undefined
  void t.fetchList().then((r) => (partial = r))
  await clock.until(() => partial !== undefined, 20_000)
  check(
    'H-3 a silent relay is waited for 1 s grace + 3 s, then left out',
    clock.now() - t0 === 20 + 1000 + 3000 && partial!.answered.join() === 'fake://a' && partial!.asked.length === 2,
    `${clock.now() - t0} ms`,
  )
  hub.listFate = (_relay, op) => (op === 'fetch' ? 'silent' : 'ok')
  const t1 = clock.now()
  let none: string | null | undefined
  void rejects(t.fetchList()).then((r) => (none = r))
  await clock.until(() => none !== undefined, 20_000)
  check('H-3 nobody answers: rejects after 8 s', none !== null && clock.now() - t1 === 8000, `${clock.now() - t1} ms`)
  hub.listFate = () => 'ok'
  hub.injectListCopy(t.pubkey, { v: 1, c: [[hex(99), 'X', NOW]], d: [] })
  check(
    "H-4 injectListCopy writes a newer copy to the owner's relays",
    ['fake://a', 'fake://b'].every((r) => (hub.listOf(r, lp)?.createdAt ?? 0) > createdAt && decodeList(hub.listOf(r, lp)!.payload, t.pubkey, NOW)?.c[0][0] === hex(99)),
  )
  hub.loseList('fake://a', lp)
  check('H-4 loseList forgets the copy', hub.listOf('fake://a', lp) === undefined)
  await t.stop()
  check('H-5 a stopped transport refuses', (await rejects(t.fetchList())) === 'transport is stopped')

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
  process.exit(failed ? 1 : 0)
}

void main()
