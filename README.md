# ilchon (일촌)

**Trade bitcoin only with people you have met, and show your offer only to the ones who would take the other side.**

Live demo: https://ilchon.dongguri.org (hackathon demo build, not for real money)

Built at **bitcoin++ Seoul 2026** (privacy edition).

## What it does

ilchon is a serverless web app for peer-to-peer bitcoin trades between people who already trust each other.

1. **Connect in person.** Two people scan each other's one-time QR codes. Only mutual scans create a contact ("ilchon", a first-degree connection). Each user names the contact; the name stays on that device.
2. **Post an offer.** Buy or sell, KRW or USD, an amount, and a premium over the market price. At this point nobody can see it.
3. **Match privately.** The app quietly runs a private matching protocol with each contact over Marmot. It tests only "does one of us buy and the other sell, in the same currency?" Amounts do not have to match.
4. **See only real counterparties.** A contact appears on your board only if they are on the opposite side in the same currency. Only then do the two apps exchange amount and premium.
5. **Trade.** Tap the match to open a private two-person room. Fiat goes by bank transfer, bitcoin by Lightning. Mark the trade done; the remaining amount stays open.
6. **Disconnect silently.** Deleting a contact stops real matching with them. Your app keeps answering with random values, so they cannot tell you left.

## Why Marmot: two layers of hiding

| Who | What they see | What stops them |
|---|---|---|
| Relays and third parties | Ciphertext only | Marmot (MLS over Nostr) |
| Contacts on the same side, or with no offer | Nothing | Private matching |
| Contacts on the opposite side | Your amount and premium | Nothing (that is the point) |
| Non-contacts | Not your offer. Someone who knows your app key can see that it uses Marmot | One-time QR, app-only key |

Marmot hides content from relays, but anyone inside a room can read what is posted there. An encrypted group chat alone would still leak "I am selling bitcoin" to every member. Private matching is the second layer: it hides your intent even from contacts who would not trade with you.

There is no ilchon server. Every message is an unsigned Nostr rumor (kind 4242) inside a two-member Marmot group. Group messages are signed with a fresh one-time key per message, not the account key. The contact list and names live only on each device.

## How private matching works

Each side builds a label:

```
label = H("ilchon/match/v1" | context | seller pubkey | buyer pubkey | currency)
```

`context` is the Marmot group id. The two labels are equal exactly when one side sells and the other buys in the same currency. A side with no offer (or a deleted contact) uses a fresh random label, so "no offer" and "same side" look identical.

The comparison uses commutative blinding over **ristretto255** with fresh secret scalars `a` (initiator) and `b` (responder) each round:

1. `m1` initiator → responder: `p = H(label_i)^a`
2. `m2` responder → initiator: `q = H(label_r)^b` and `pq = SHA-256(p^b)` — a hash commitment, never the point itself, so the initiator cannot echo it back to fake a match
3. `m3` initiator → responder: `qp = q^a`

The initiator compares `SHA-256(q^a)` against `pq`; the responder compares `SHA-256(qp)` against the commitment it kept (hashes are domain-tagged, label fields length-prefixed, points rejected if malformed or identity). Blinding commutes, so equal labels give equal values, and neither side learns the other's label. Only after both sides verify a match does each send its `offer` (amount and premium). A responder answers one round per contact per 24 hours (20 s in demo mode).

Code: `src/lib/match/`, wire format in `src/contracts.ts`.

## Connection by mutual one-time QR

- Each QR carries `{ pubkey, one-time code, expiry }` and rotates every 30 seconds. A code can be redeemed once, within 2 minutes.
- Both people must scan each other. The side with the smaller pubkey invites; the other side accepts a Marmot Welcome only from a pubkey it scanned in the last 5 minutes and otherwise ignores it silently.
- Both sides then exchange `hello` messages carrying the code the other side issued. A contact exists only after both hellos verify.
- Knowing someone's pubkey is never enough to become their contact.
- On a laptop without a camera, "Copy code" and paste work the same way.

## Key lock

The app makes its own Nostr key; it does not ask for your existing one. On setup you choose how to lock it:

- **Passkey (Face ID / fingerprint):** the key is encrypted with a key derived from the passkey's WebAuthn PRF output.
- **Password:** the key is stored as a NIP-49 `ncryptsec`, compatible with other Nostr apps.
- **No lock:** for stage demos only; the app warns before you choose it.

You can export an `ncryptsec` backup and restore the same key on another profile. Password lock, backup and restore were checked on the deployed build. The passkey lock has not yet been tested on real iOS and Android devices. Marmot group state and contacts are not encrypted at rest in this version.

## NIPs and specs used

| NIP | Used for |
|---|---|
| NIP-01 | Events, signatures, relay protocol. ilchon messages are unsigned rumors inside Marmot groups |
| NIP-19 | npub / nsec display and key backup |
| NIP-44 | Encrypting invite envelopes |
| NIP-59 | Gift wrap (kind 1059) for Marmot Welcomes |
| NIP-65 | Relay list (kind 10002) |
| NIP-17 | Inbox relay list (kind 10050) |
| NIP-42 | Relay auth, only when a relay asks |
| NIP-49 | Password-encrypted key (ncryptsec) for the lock and backup |

Marmot: KeyPackage (kind 30443), Welcome (kind 444 inside NIP-59), group message (kind 445). ilchon's own messages: kind 4242 inside the group (hello, match rounds m1/m2/m3/mx, offer, withdraw, chat, done).

Not used: NIP-04 (leaks who talks to whom), NIP-09 (ilchon never posts public notes, so there is nothing to delete).

Default relays: `wss://relay.us.whitenoise.chat`, `wss://relay.eu.whitenoise.chat`.

## Compared with existing P2P services

As far as we found (survey of official sites, docs and repos on 2026-11-06; medium confidence, and not finding something is not proof it does not exist):

| Service | Who you trade with | Who sees your offer | Sign-up | Operator holds | Scam protection |
|---|---|---|---|---|---|
| Vexl | Phone contacts (1st and 2nd degree) or club members | Everyone in your network who receives it | Phone number + SMS | Contact hashes, network graph, encrypted offers | None; report, block, common-friend count |
| Mostro | Anyone | Anyone; amount, currency, method public on Nostr | Key only | Node sees all orders | Lightning hold, dispute solver |
| RoboSats | Anyone | Anyone; coordinator books aggregated, also on Nostr | None | Coordinator handles orders and escrow | Bond + escrow, coordinator disputes |
| Hodl Hodl | Anyone | Anyone; private offers via link | Email | IP, device info, chats | 2-of-3 multisig, company arbitrates |
| Peach Bitcoin | Anyone | Anyone | Device id; sellers need ID or history | Matching and dispute mediation | Company mediates disputes |
| Bisq 1 | Anyone | Anyone on the P2P network | None | No central server | Deposits, 2-of-2 multisig, mediation and arbitration |
| Bisq Easy | Anyone | Anyone; public offer board | Pseudonymous profile | No central server | No escrow; seller reputation and limits |
| **ilchon** | Contacts you scanned in person, both ways | Only contacts on the opposite side | None; the app makes a key | No server; contacts stay on each device | None; you choose your contacts |

None of the six services we looked at reveals an offer only to counterparties whose terms match. Vexl is the only other one that limits trading to your network; ilchon differs by needing no phone number, keeping the network graph on devices instead of a company server, and showing an offer only to matching contacts.

Where ilchon is weaker, and we say so: no escrow or dispute resolution, no IP hiding (RoboSats and Bisq use Tor by default), the smallest liquidity (your contacts only), and no track record, users or audit.

## Known limitations

**Trust and trading**
- The app does not check where incoming fiat came from. If a contact relays someone else's money, your account can still receive it. Check that the bank sender name is your contact's own.
- No protection against a counterparty who does not pay.
- Useless if you do not know trusted bitcoiners nearby.
- Two people can connect over a video call by showing QR codes, without meeting.
- We have not checked the legal boundaries of a P2P crypto trading tool in Korea.

**Privacy**
- Bank transfers leave records at the bank.
- Posting "buy" reveals every selling contact to you, and you to them.
- A determined contact can probe over several days by switching sides to learn your direction.
- The side that learns the result first could modify its app to send a false answer.
- Matching starts when an offer is posted, so a non-matching contact can tell that you just posted something.
- Relays see your IP address and connection times; colluding relays could infer who joins which group.

**Usability**
- Matching waits while the contact's app is closed.
- Clearing browser storage or losing the device loses contacts and rooms; each contact must be re-scanned.
- If the final connect confirmation is delayed more than 2 minutes, only one side may keep the contact.
- marmot-ts is alpha and the Marmot spec is still changing. Do not use this for real funds.

## Run locally

```sh
pnpm i
pnpm dev
```

Open several profiles in one browser with `?p=<name>`; each name has its own key and storage. `demo=1` shortens the one-round-per-day limit to 20 seconds:

```
http://localhost:5173/?p=a&demo=1
http://localhost:5173/?p=b&demo=1
http://localhost:5173/?p=c&demo=1
```

The app needs https or localhost (WebCrypto) and talks to real Nostr relays; there is no mock transport.

## Scripts

| Command | What it checks |
|---|---|
| `pnpm exec tsx scripts/check-match.ts` | Private matching: opposite / same side / no offer / other context, malformed points, echoed or faked commitments must not match, fresh blinding each run |
| `pnpm exec tsx scripts/check-vault.ts` | Key lock: NIP-49 (ncryptsec) encrypt/decrypt and password handling |
| `pnpm exec tsx scripts/smoke-marmot.ts` | Two transports create a Marmot group and exchange messages over real relays (`RELAYS=wss://a,wss://b` to override) |
| `pnpm exec tsx scripts/e2e.ts` | The full three-user demo scenario on real relays: A buys, B sells, C buys; A sees only B, C sees nothing, chat, side change, silent delete |
| `pnpm typecheck` / `pnpm build` | TypeScript strict check / production build |

## Project layout

See the module map at the top of `src/contracts.ts`: `src/lib/marmot` (transport), `src/lib/match` (private matching), `src/lib/connect` (one-time QR), `src/lib/vault` (key lock), `src/engine` (all app logic, runs in Node too), `src/screens` (React UI).

## Credits

- UI tokens (colors, type, spacing) follow the open-source [Coconut Design System](https://github.com/noncelab/coconut_design_system) (MIT), rebuilt for the web. ilchon is **not** a Nonce Lab or Coconut Wallet product.
- Transport by [marmot-ts](https://github.com/marmot-protocol/marmot-ts); connection code follows the reference app marmots-web-chat.
- Crypto from `@noble/curves`, `@noble/hashes`, `@noble/ciphers`.

## License

MIT
