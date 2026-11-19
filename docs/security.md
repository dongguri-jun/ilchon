# Security model

ilchon is early software built on alpha libraries (marmot-ts, a changing Marmot spec). It has not been audited. Do not use it for amounts you cannot afford to lose.

## What it promises

1. **An offer never reaches a contact who would not trade with you.** Side, currency and payment methods are compared by a private matching protocol; amount, premium and methods are sent only after both apps have verified a match. A contact on the same side, in another currency, with no payment method in common, or with no offer at all sees the same messages, of the same length, as any other non-match. The engine checks run twin scenarios to hold this, including after deletes and restores.
2. **Deleting a contact is silent.** The app keeps answering that contact's matching rounds with random values, so their app sees the same thing as when you simply have no matching offer.
3. **Only people you scanned in person become contacts.** Both sides must scan each other's one-time QR; a public key alone is never enough, and invites without a valid one-time code are ignored.
4. **Relays and other outsiders do not see content.** Every message is end-to-end encrypted in a two-member Marmot (MLS) group and signed with a one-time key, not your account key.
5. **The app key is separate from any other Nostr identity.** It is made from its own 12 words on account 4242, so the same words never give the key another Nostr app would make, and the app never asks for an existing Nostr key.
6. **Data on the phone is encrypted at rest.** Everything except the lock record and the support log is sealed with a data key that only the lock (passkey PRF or 6-digit PIN) can unwrap, wrapped again by a non-exportable browser key. The app locks after the auto-lock time out of view and reloads so keys leave memory.
7. **The support log holds nothing about trades or people.** Keys, amounts, accounts, addresses and links are masked; per-message failures are kept only as ten-minute intervals.

## What it does not protect against

- A counterparty who does not pay, or who relays someone else's money. There is no escrow and no dispute resolution.
- A determined contact who keeps changing their own offer to probe your side, currency and payment method while your app is open.
- A modified app on the other side that lies about a match result, or notices timing (for example that you just posted, opened the app, or re-added them).
- Relays and the networks in between: they see your IP address, connection times, room ids and the timing of invitations. Colluding relays could infer who joins which room. There is no Tor or other IP hiding.
- Anyone holding your unlocked phone, a tampered build of the app, or a rooted or jailbroken phone from which the browser's whole storage is taken (a 6-digit PIN can then be guessed offline; a passkey lock does not have this weakness).
- Anyone who learns your 12 words: they can restore your key, your contact list and your channels. Your first phone then stops, and your contacts see one "connection reopened" line.
- Exchange price APIs, your Lightning address service, the profile lookup relays and Cloudflare Pages see your IP address when the app talks to them.

The full, current list of limits is in the README under "Known limitations".

## Reporting a vulnerability

See [`SECURITY.md`](../SECURITY.md). Never post your 12 words, PIN or keys anywhere.
