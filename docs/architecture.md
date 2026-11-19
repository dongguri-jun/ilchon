# Architecture

ilchon is a single-page web app with no server of its own. Every phone runs the whole app; phones talk to each other only through public Nostr relays, inside end-to-end encrypted Marmot (MLS) groups. The static files are served from Cloudflare Pages.

## Modules

The module boundaries and shared types live in `src/contracts.ts`; its header is the module map. In short:

| Module | Role |
|---|---|
| `src/engine/` | All app logic: contacts, offers, matching rounds, trades, delivery and retries. No DOM; it runs in Node too, which is how the checks drive it |
| `src/lib/marmot/` | Transport: Marmot groups over Nostr relays (marmot-ts), relay lists, KeyPackages, invites, the received-message inbox, the encrypted contact list event |
| `src/lib/match/` | The private matching protocol (ristretto255 blinding) |
| `src/lib/connect/` | One-time QR payloads |
| `src/lib/store/`, `src/lib/vault/` | Encrypted on-device storage and the lock keys (passkey PRF or PIN) |
| `src/lib/seed/` | The app key from 12 words (BIP-39, NIP-06 path, account 4242) |
| `src/lib/money/`, `src/lib/rates/` | Integer money amounts and the BTC price in KRW, USD and JPY |
| `src/lib/bolt11/`, `src/lib/lnurl/`, `src/lib/onchain/`, `src/lib/pay/` | Lightning invoices, Lightning address lookups, on-chain addresses and `bitcoin:` links |
| `src/lib/relays/`, `src/lib/nostr-profile/`, `src/lib/support-log/` | Relay list rules, read-only Nostr profile lookup, the value-free support log |
| `src/screens/`, `src/ui/`, `src/i18n/` | React screens that only read engine state and call engine actions; design tokens and components; strings |

The screens never talk to relays or storage directly. Everything that must hold for privacy is decided in the engine and the libraries under it.

## One relationship, one room

Each contact is one two-member Marmot group. All ilchon messages are unsigned Nostr rumors of kind 4242 inside that group: `hello` (connect proof), `m1`/`m2`/`m3`/`mx` (matching rounds), `offer`, `withdraw`, `chat` and `done`. Group messages are signed with a fresh one-time key per message, never with the account key, and relays see only the group id, timing and the sender's IP address.

Marmot kinds used: KeyPackage (30443), Welcome (444, wrapped in a NIP-59 gift wrap), group message (445). Each user publishes relay lists (kinds 10002 and 10050) on their own relays and on a lookup relay, so two people whose relay lists differ can still find each other's KeyPackage and inbox.

## Connecting

1. The connect screen shows a QR with the app key, a one-time code that rotates every 30 seconds and can be redeemed once within 2 minutes, and a reference to the user's current KeyPackage. No QR is shown until that KeyPackage is on a relay.
2. Both people scan each other. The side with the smaller public key creates the room and invites exactly the KeyPackage the scanned QR names. The other side joins only a room from a key it scanned recently, or from an existing contact.
3. Both sides send `hello` with the code the other side issued. The contact exists only after both proofs verify. Knowing a public key is never enough.

Scanning an existing contact again checks quietly that both still share the same room and opens a new one only when they do not. This is how a channel taken over with a stolen key is won back in person. A lost or unreadable room is reopened remotely by the app, within per-day limits.

## Matching

When a user posts an offer, the engine runs one matching round with each contact. A round compares two slots (Lightning, on-chain). Each side hashes a label made of side, currency, payment method, the room and the round id, and the two sides compare blinded values. Labels are equal only when one side buys and the other sells, in the same currency, with that payment method. A slot for a method not chosen, a side with no offer and a deleted contact all use random labels, and every message has the same length, so a non-matching contact learns nothing beyond the fact that a round ran.

Only after both sides verify a match does each send its `offer` (amount, premium, payment methods). The side that started the round sends first; the other answers after it has received a valid offer. Details are in the README and `src/lib/match/`.

## Delivery

Relays may drop messages, and the app may be closed at any moment. The engine handles three kinds of messages differently:

| Kind | Messages | How it gets there |
|---|---|---|
| State | `offer`, `withdraw` | The engine keeps, per contact, the last state it told them, and re-sends until a relay accepts the current state: from 60 seconds, doubling up to 10 minutes, and again on start, on return to the app and on reconnect |
| Event | `chat`, `done` | Each carries the sender's record id, so the receiver adds it once. A failed `done` is re-sent automatically; a failed chat message is re-sent only when the user taps retry |
| Procedure | `hello`, `m1`, `m2`, `m3`, `mx` | Not stored; a round that does not finish is simply run again, with growing gaps up to 15 minutes |

"Sent" means a relay accepted the message; there are no read receipts. Every received message is first written to an encrypted inbox (at most 2,000 entries) and removed only after the engine has handled it and saved the result, so a message that arrives just before a crash or an auto-lock is handled after the restart. Handlers are written so that handling a message twice gives the same result.

The app needs an internet connection. A room message waits up to 8 seconds for a relay socket before it is encrypted, so a message that cannot be sent does not use up an MLS ratchet step.

## Storage and lock

Everything the app keeps is in one IndexedDB store per profile, each record sealed with AES-GCM under a data key, with hidden record names. The data key is wrapped by the lock (a passkey's WebAuthn PRF output, or PBKDF2 of a 6-digit PIN) and then by a non-exportable browser key. Only the lock record and the support log sit outside the data key. The app locks again after it has been out of view for the auto-lock time; locking reloads the page so keys leave memory.

## Contact list and restore

The contact list (public keys and the names the user gave) is encrypted to the user's own key with NIP-44, padded to one fixed size, and published as one kind 30078 event signed by a separate list key derived from the app key. It goes only to four dedicated list relays (`LIST_RELAYS`). A restore from the 12 words rebuilds the same key, fetches and merges the list, and reopens a room with each contact without meeting again. Chats, offers and settings do not come back. One account works on one device at a time: the device restored last takes over.

## Outside services

- Public Nostr relays: default chat relays, one lookup relay and four list relays, listed in `src/contracts.ts`. Users can choose their own chat relays.
- BTC price APIs of public exchanges, every 60 seconds while the app is open.
- The user's own Lightning address service, asked directly from the browser when the buyer requests an invoice.
- Three public relays for the optional, read-only Nostr profile lookup.

There is no ilchon backend and no proxy. Response headers, including the Content Security Policy, are in `public/_headers`.
