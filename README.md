# ilchon (일촌)

**Trade bitcoin only with people you have met, and show your offer only to the ones who would take the other side.**

Live demo: https://ilchon.org (early version, trade at your own risk)

Built at **bitcoin++ Seoul 2026** (privacy edition).

## What it does

ilchon is a serverless web app for peer-to-peer bitcoin trades between people who already trust each other.

It is phone-only. A computer with no ilchon key gets a prompt to open the app on a phone instead; a computer that already holds a key is not blocked. The prompt is guidance, not a security boundary.

1. **Connect in person.** Two people scan each other's one-time QR codes. Only mutual scans create a contact ("ilchon", a first-degree connection). Each user names the contact; the name stays on that device.
2. **Post an offer.** Buy or sell, in KRW, USD or JPY, an amount, and a premium over the market price. At this point nobody can see it.
3. **Match privately.** The app quietly runs a private matching protocol with each contact over Marmot. It tests only "does one of us buy and the other sell, in the same currency, with at least one payment method (Lightning, on-chain) in common?" Amounts do not have to match.
4. **See only real counterparties.** A contact appears on your board only if they are on the opposite side in the same currency, with at least one payment method (Lightning, on-chain) in common. Only then do the two apps exchange amount and premium. Amount and premium do not filter; the board sorts by closest amount, or by best premium.
5. **Trade.** Tap the match to open a private two-person room. Fiat goes by bank transfer, bitcoin by Lightning or on-chain. Mark the trade done; the remaining amount stays open.
6. **Disconnect silently.** Deleting a contact stops real matching with them. Your app keeps answering with random values, so they cannot tell you left.

## Why Marmot: two layers of hiding

| Who | What they see | What stops them |
|---|---|---|
| Relays and third parties | Encrypted message contents only. Connection and lookup metadata is still visible (see the limits below) | Marmot (MLS over Nostr) |
| Contacts who do not match | Not your side, currency, method, amount or premium. They can see that a matching round started | Private matching |
| Contacts whose offer matches yours | Your amount, premium and payment methods | Nothing (that is the point) |
| Non-contacts | Not your offer. Someone who knows your app key can see that it uses Marmot | One-time QR, app-only key |
| Relays that keep your contact list (relay.coinos.io, relay.primal.net, purplerelay.com, relay.nostr.net) | One event of one fixed size, signed by a separate list key, readable only with your key: not who your contacts are, how many, or their names. They see when it changes and your IP address, and a restore from your 12 words asks them for it | NIP-44 to yourself, a list key derived from your key (and so from your 12 words) |

Marmot hides content from relays, but anyone inside a room can read what is posted there. An encrypted group chat alone would still leak "I am selling bitcoin" to every member. Private matching is the second layer: it hides your intent even from contacts who would not trade with you.

We use Marmot not as a group chat but as one two-member MLS group per relationship. Even one-to-one, relays do not see a recipient per message, unlike NIP-17 DMs. Because each relationship is already a group, the next step is adding members to the same room: a mediator both sides agree on, an introducer for second-degree contacts, or your own extra devices.

There is no ilchon server. Every message is an unsigned Nostr rumor (kind 4242) inside a two-member Marmot group. Group messages are signed with a fresh one-time key per message, not the account key. The contact list and your names for contacts live on your device and, encrypted so only your key can read it, on relays chosen for the list.

## How private matching works

Each round compares two slots, one per payment method (slot 0 Lightning, slot 1 on-chain). For each slot each side builds a label:

```
label_i = H("ilchon/match/v2/label" | context | seller pubkey | buyer pubkey | currency
            | method_i | initiator | responder | sid)
```

`context` is the Marmot group id; `initiator`, `responder` and `sid` name the round. The two labels of a slot are equal exactly when one side sells and the other buys in the same currency and both accept that method. Each round always carries two slots (Lightning, on-chain); a slot for a method you did not pick gets a random label, so contacts cannot tell one method from two. A side with no offer (or a deleted contact) uses random labels in both slots, so "no offer", "same side" and "no method in common" look identical. The label also binds who started the round and its id, so a contact cannot reflect your own round back at you.

The comparison uses commutative blinding over **ristretto255** with fresh secret scalars `a_i` (initiator) and `b_i` (responder) per slot and round:

1. `m1` initiator → responder: `p_i = H(label_i)^a_i`
2. `m2` responder → initiator: `q_i = H(label_i)^b_i` and `pq_i = SHA-256(method_i | p_i^b_i)` — a hash commitment, never the point itself, so the initiator cannot echo it back to fake a match
3. `m3` initiator → responder: `qp_i = q_i^a_i`

The initiator compares `SHA-256(method_i | qp_i)` against `pq_i`; the responder compares the same against the commitment it kept (hashes are domain-tagged, label fields length-prefixed, points rejected if malformed or identity). A round matches when either slot matches. Blinding commutes, so equal labels give equal values, and neither side learns the other's labels. Every `m1`, `m2` and `m3` has the same length whatever the offer. Only after both sides verify a match does each send its `offer` (amount, premium and payment methods). Matching is always live, with no setting for it: each contact gets at most one completed matching round per 1-second window, so a determined contact can probe your side, currency and payment method by switching (see known limits). A contact who does not answer is retried with growing gaps, up to 15 minutes, until they are heard from again.

Code: `src/lib/match/`, wire format in `src/contracts.ts`.

## Connection by mutual one-time QR

- Each QR (format version 2) carries `{ pubkey, one-time code, expiry, key package reference }` and rotates every 30 seconds. A code can be redeemed once, within 2 minutes. A room made from a scan invites only the key package the scanned QR names, never a newer one someone holding the same key may have published. So the connect screen shows no QR until your own key package is on your relays (right after the app opens, or while offline, it shows "Getting ready"), and puts the new reference into the QR on screen whenever the key package is replaced.
- Both people must scan each other. The side with the smaller pubkey makes every room between the two; the other side joins only a room from a pubkey it scanned in the last 5 minutes, or one from an existing contact.
- Both sides then exchange `hello` messages carrying the code the other side issued. A contact exists only after both hellos verify.
- Scanning someone who already is your contact shows "already added" and keeps your QR on screen; both apps silently check that they share the same room and open a new one only when they do not (this is how a channel taken over with a stolen key is won back in person). Each sends a proof carrying the other's code into its room; a proof that arrives within 5 minutes of my scan means the room is the same. Without one, the side with the smaller pubkey makes a new room after 5 minutes, tagged with a hash of the other's code, and the other side takes it because only someone who saw its QR can make that tag. When the room they prove this way had just been moved (by a scan, by a tag, or remotely within the last 7 days), neither app takes a remote move or request for it for 7 days. If one side lost or deleted the other, that side links from scratch and the other side's app follows silently.
- Knowing someone's pubkey is never enough to become their contact.
- On a device without a camera, such as a computer in local development, "Copy code" and paste, folded under "If your camera doesn't work" at the bottom of the connect screen, work the same way. The app notes on the contact whether it was linked by camera or by paste; this is not shown and never leaves the device.

## On-device profile and trade guidance

- **KO/EN** on the top banner switches language on every screen, including first-run setup and unlock.
- Optionally paste an npub for an existing contact made by mutual QR. ilchon fetches the public kind-0 profile (name, display name, "about" text and NIP-05 address; never the picture or the Lightning address) from three public relays, checks its signature, and shows it on your device only. It is not sent to the contact or published, and does not prove that the npub belongs to that person. Profile pictures are never loaded, and the contact list shows no NIP-05 badge: your own name for the contact comes first. The NIP-05 address is checked only when you press "Check NIP-05", and the result is one line that is not kept.
- Your board offer has a status line: **Posted · Connect contacts / Checking contacts n/m / No matches / n matches**, **Edit** and **Withdraw** buttons, and buyer/seller hints that follow the payment methods you picked. A matched contact shows on the board, not in the contact list: the contact list has no "matched" badge.
- The trade room has a role-specific **Next steps** checklist. Buyer: agree price → send where I receive (Lightning invoice or on-chain address) → bank-transfer fiat → mark done after the bitcoin arrives. Seller: agree → share bank account → confirm deposit and that the sender name matches → pay their invoice or send to their address → mark done. The buyer's step 2 shows as done only while the room holds an active receiving place for a payment method both offers share. When that stops (for example after the methods change), only the transfer step the app moved to by itself goes back to step 2; a step you picked by hand or a finished one never moves back. The step you chose is kept in the encrypted store.
- The matched buyer taps "Send Lightning invoice" or "Send on-chain address" (only the methods both offers share). Lightning: the app gets an invoice for the agreed amount (or one you type) from the Lightning address you saved in Settings, checks it (mainnet, exactly the sats asked, not about to expire, the description hash) and sends it as a chat message; if that fails you paste an invoice instead. On-chain: you paste a fresh mainnet address each time; the app sends a `bitcoin:` link with the amount and never sends the same address twice in one room. The sats are the trade amount at the current price and the seller's premium, rounded down.
- Only the latest invoice or address the buyer sent in the current trade is live: both sides see its QR and copy button, and only the seller gets the pay button, only while the two offers match. Earlier ones, those of finished trades and of earlier offers turn grey. The live card shows its value at your own price, and the seller sees a warning when it asks for more than 3% above the trade amount at the seller's own premium.

## Key, 12 words and lock

The app makes its own key; it does not ask for your existing Nostr key. The key comes from 12 words (BIP-39, English word list, no passphrase) on the NIP-06 path `m/44'/1237'/4242'/0/0`. The account is 4242, not 0, so the same 12 words never give the npub another Nostr app would make from them. On first run the app shows the 12 words and goes on only after you tick that you wrote them down; nothing is stored before that. Settings shows them again only after you prove the lock again. There is no copy button: the clipboard can be read by other apps. Both screens that show the words, and the screen where you enter them, carry one line: never enter your 12 words outside the ilchon app.

The first screen offers **Start fresh** or **Restore with 12 words**. A restore checks the words, makes the same key, and fetches your encrypted contact list from the list relays (below): your contacts come back under the names you gave them, and the app reopens each channel without meeting again. Past chats, offers and settings (language, relays, Lightning address, auto-lock time) do not come back. If no list is found you can check the words again or continue without contacts. In an in-app browser (a messenger's built-in browser) the first screen only asks you to open the link in Safari or Chrome, so neither a new key nor a restore starts there.

One account works on one device at a time. At every start the app reads your key's KeyPackages on your relays; if one was published from another device after this device made or restored the key, this device stops, and from then on it opens, before it connects to any relay, on a screen that says your key was restored on another device and this device can no longer be used. Its one way forward, **Restore with 12 words again**, resets this device after a confirmation and opens the restore screen. The app cannot tell an honest move to a new phone from a thief who has your words: if you did not restore them yourself, they may have leaked. When a contact's side reopens your channel without a scan of yours (their phone was restored, or someone holding their key moved it), your chat with that contact gets one line: "The connection with this contact was reopened. If you receive account details or an address, check them directly." The line is drawn on your device only, never sent, and not drawn for a channel the two of you changed by scanning each other.

On first run you choose the lock:

- **Passkey (face or fingerprint):** the lock key is derived from the passkey's WebAuthn PRF output.
- **6-digit PIN**, offered when the phone has no passkey with PRF: the lock key is PBKDF2-SHA256 (600,000 rounds) of the PIN. Same digits and straight runs are refused. After five wrong PINs each try waits, from 30 seconds up to an hour; the count survives a restart; nothing is ever erased.

A "no lock" choice exists only in development builds; `pnpm build` checks that the shipped files hold neither it nor the test-only plain storage.

The app locks again after it has been out of view for longer than the auto-lock time: 1, 5, 15 or 30 minutes, 5 by default, chosen in Settings. Only time out of view counts (another app, the screen off), not time the app stays open in front. Locking reloads the page, so the keys and everything read from the store leave memory. Unlocking returns to the room you had open and the chat message you were writing, with no time limit.

What is encrypted: everything the app keeps in the profile's IndexedDB store, that is the key and its 12 words, contacts and the names you gave them, chats (including any bank account numbers in them), your offer, matches, the trade-guide step of each room, settings (including the relays you chose, the auto-lock time and your Lightning address), the room you had open and the chat message you were writing, whether you closed the intro card, the Nostr profile you linked to a contact (its public key, name, display name, "about" text and NIP-05 address, nothing else) and the Marmot group state. Each record is sealed with AES-GCM under a data key made for the profile, and record names are hidden. The data key is wrapped by the lock, and the wrapped record once more by a browser key the page cannot export.

What is not encrypted by the data key: the lock store (that browser key, the lock record sealed with it, and the storage format number) and the support log (see below). The browser's history entries and the address hold no contact or room. The relay list, the trade-guide step, the intro card and linked Nostr profiles that earlier builds kept in browser `localStorage` are deleted when the app starts, and on a reset. The reset on the screen of a device that was restored elsewhere adds `#restore` to the address for the reload, so it opens on "Restore with 12 words"; it names that screen only, and the app removes it as soon as the page has read it (or when that reset fails), without adding a history entry.

A 6-digit PIN is weak against someone who gets the browser's whole internal storage out of the phone (for example from a rooted or jailbroken phone): they can try all million PINs offline, and the wait above does not apply. The second wrap stops a copy of the IndexedDB files alone only if the browser keeps its non-exportable key outside those files, which has not been checked on real phones. A passkey lock does not have this weakness, since the passkey's PRF output never leaves the authenticator.

An earlier build, before the encrypted store, was tested on an Android phone with Chrome: passkey lock creation and unlock worked with Google Password Manager, camera QR scanning of a laptop screen worked, and phone ↔ laptop linking worked across two addresses serving the app. The current lock has not been tested on a real phone yet.

## NIPs and specs used

| NIP | Used for |
|---|---|
| NIP-01 | Events, signatures, relay protocol. ilchon messages are unsigned rumors inside Marmot groups. Kind 0 profiles are read (never published) when you link an npub to a contact |
| NIP-05 | Checking a linked profile's address, only when you press "Check NIP-05"; the result is not kept |
| NIP-06 | Key from 12 words (account 4242) |
| NIP-19 | npub display |
| NIP-44 | Encrypting invite envelopes; self-encrypted contact list |
| NIP-59 | Gift wrap (kind 1059) for Marmot Welcomes |
| NIP-65 | Relay list (kind 10002) |
| NIP-17 | Inbox relay list (kind 10050) |
| NIP-42 | Relay auth, only for my own inbox, my own signed relay lists and my KeyPackages; never on the contact list relays |
| NIP-78 | Contact list event (kind 30078) under a separate list key |

Marmot: KeyPackage (kind 30443), Welcome (kind 444 inside NIP-59), group message (kind 445). ilchon's own messages: kind 4242 inside the group (hello, match rounds m1/m2/m3/mx, offer, withdraw, chat, done).

Other specs: LUD-06 and LUD-16 (Lightning address to invoice), asked straight from the browser to the user's own wallet service with no proxy; BIP-21, BIP-173 and BIP-350 (mainnet on-chain address check and `bitcoin:` links). The app never looks up the blockchain.

Not used: NIP-04 (leaks who talks to whom), NIP-09 (ilchon never posts public notes, so there is nothing to delete).

Default relays: `wss://relay.coinos.io`, `wss://nostr.mom`, `wss://nostr.21crypto.ch`, `wss://relay.us.whitenoise.chat`. Lookup relay: `wss://purplepag.es`, which receives only the app key's kind 10002 and 10050 lists, never a KeyPackage. Contact list relays (`LIST_RELAYS` in `src/contracts.ts`; only the encrypted contact list goes there, and the list is looked up only there): `wss://relay.coinos.io`, `wss://relay.primal.net`, `wss://purplerelay.com`, `wss://relay.nostr.net`. They are separate from the chat relays and cannot be changed in Settings. They were picked from a test on 2026-11-14 of 16 public relays, in which 11 took a 44 KB kind 30078 event from a new key without auth, gave the same event back at once, and still served kind 30078 events older than 8 days. Reading the same event again 24 hours later (from 2026-11-15) and 7 days later (from 2026-11-21) is still pending; a relay that fails it is replaced by another one that passed. A change counts as stored once two of the four hold it.

## Known limitations

**Trust and trading**
- The app does not check where incoming fiat came from. If a contact relays someone else's money, your account can still receive it. Check that the bank sender name is your contact's own.
- No protection against a counterparty who does not pay.
- The app cannot tell whether an invoice was paid or an on-chain payment arrived; it does not look at the blockchain. Only the latest invoice or address of the current trade can be paid from the app; compare the fiat value on the card with the deposit you received. The seller's wallet adds the on-chain fee on top.
- Useless if you do not know trusted bitcoiners nearby.
- Two people can connect over a video call by showing QR codes, without meeting.
- A room made from a scan invites only the key package the QR names, and the app replaces its key package right after it joins a room (the relays then drop the old one). The QR on screen switches to the new key package at once, but a QR seen before that moment (scanned in the same instant, or from a picture) can no longer be invited: a first link from it fails with a network error, and a new room one rescan of contacts would make is not made. Scanning the QR on screen again fixes it. If someone holding your key deletes or overwrites your key package, a rescan cannot win the channel back.
- We have not checked the legal boundaries of a P2P crypto trading tool in Korea.
- No escrow or dispute resolution, and no track record or security audit yet.

**Privacy**
- Bank transfers leave records at the bank.
- Posting "buy" reveals every selling contact to you, and you to them.
- A determined contact can probe your side, currency and payment method by switching, since matching is always live (a few seconds while your app is open).
- The side that learns the result first could modify its app to send a false answer.
- If you meet someone you deleted and you both scan again, a modified app could tell that a new room arrived before the deadline. Their screen does not change. At the meeting, the screen of the person who had deleted the other shows a new connection.
- Matching starts when an offer is posted, so a non-matching contact can tell that you just posted something.
- When you post or change an offer, the app starts matching only with current contacts; a modified app could notice it was not asked.
- For contacts whose offer matched yours, the app re-runs the private match each time you open or unlock it, and again when you switch back to it or it reconnects to the relays (at most once per contact every 10 minutes; nothing re-runs on a timer while it simply stays open), retrying with growing gaps while they do not answer. So they and the relays can tell you just opened or returned to the app.
- Relays see your IP address and connection times; colluding relays could infer who joins which group.
- While the app is open it fetches the BTC price every 60 seconds from public exchange APIs (Upbit or Bithumb for KRW, Coinbase or Kraken for USD, bitbank and Coinbase for JPY, with Kraken as a tiebreaker). It asks for all three currencies whichever one you use. They see your IP address and when you asked, and the request's Origin tells them it came from ilchon.
- Getting an invoice from your Lightning address goes straight from your phone to your own wallet service, which sees your IP address, the time and the amount. The request's Origin tells it the request came from ilchon. Your contact gets only the invoice, never the Lightning address, which is kept encrypted on the device. The app asks only https hosts with a name (no IP address, localhost or local network name) and follows no redirect; the response headers allow any https host, so this rule in the app is the guard.
- Connecting by QR looks up the other person's relay lists and KeyPackage, so your relays and the lookup relay can see which public key you looked up, right before you invite it. The lookup relay also holds your app key's relay lists.
- The app key's relay lists are signed again only when your relays change, so they do not show when you open the app.
- Anyone reading a relay that serves kind 1059 without auth can see when Welcomes arrive for a given pubkey (relay.us.whitenoise.chat does). The app does not hide this.
- A relay sees a room's id and when its messages are sent; the commit and the Welcome of an invitation go out at nearly the same moment, so the timing ties a new room to an invitation.
- The browser tells every relay that the connection comes from the ilchon site (the WebSocket `Origin` header).
- Looking up a Nostr profile asks relay.damus.io, nos.lol and relay.primal.net over separate connections, so those three relays see your IP address and the npub you looked up. Pressing "Check NIP-05" also shows your IP address to the domain the profile names.
- If you choose your own relays and none of them answer, the app switches to the default relays until it is opened again; you can turn this off in Settings → Advanced. To check, and only while none of your own relays can be reached, it asks every default relay (four today) for your app key's public relay list: each of them then sees your app's public key and your IP address, even when the check ends without a switch (your relays came back, or the default relays did not answer either). Checks wait 5, 15, 30, then 60 seconds between them, at most 20 an hour. After a switch, the default relays see your IP address and connection times like your own relays do.
- An invitation is sent to the relays the other person names as their inbox, and the KeyPackage is fetched from their write relays. Those relays can see your IP address.
- A room's messages use the relays chosen by whoever sent the invitation, so a contact who picks their own relay can keep seeing your IP address and connection times while the app is open.
- The app is served from Cloudflare Pages, which sees your IP address when the app loads.
- Contacts can see when your encrypted contact list was last updated, not what changed: a contact who guesses which relay event is your contact list (a new one appears right after you connect) can see when it changes.
- A relay operator who sees both connections from one IP can link the encrypted contact-list event to the identity that published key packages from that IP. relay.coinos.io is both a default relay and a list relay.
- When you restore from the 12 words, the four list relays (relay.coinos.io, relay.primal.net, purplerelay.com, relay.nostr.net) see the list key asked for from your IP address. Restoring on another device also makes your first phone stop the next time it opens (it reads your key's KeyPackages from your relays at every start); a thief who restores your 12 words stops your phone the same way, and your contacts see one "connection reopened" line in their chat with you.
- Support log: "Copy log" (Settings, and the screens shown when the app does not open) copies a technical log for you to send to the maker. It stays on the device, unencrypted, and leaves it only when you copy it. It holds nothing about your trades or contacts and no value that identifies another person; failures that can happen per message or per room are kept only as ten-minute intervals, without counts. It does show the app version, your browser and when you used the app.

**Lock and storage**
- While the app is unlocked, anyone holding the phone sees everything, and a tampered app build could read everything.
- A rooted or jailbroken phone that yields the browser's internal storage can brute-force a 6-digit PIN offline.
- Moving the phone's clock forward skips the PIN wait.
- The number and size of stored records are visible.
- The lock screen uses the browser's language, not the one chosen in settings.
- Auto-lock counts only time out of view: an app left open in front stays unlocked.
- The picture the phone's app switcher keeps of the last screen is taken by the system, and no web feature can exclude a page from it (native apps have one; browsers do not offer it). When the app has a lock, ilchon covers the whole screen with a blank cover as early as the browser lets it. A first test on an Android phone with Chrome showed the cover came too late: the picture still showed the open room, amounts and the unsent text, and on a return after the auto-lock time the unlocked room showed for about a second before the lock screen. Since then (not yet re-tested on a phone):
  - On a phone or tablet the cover now goes on when the page loses focus, which on Android comes as you start leaving and while the page is still drawn, so it should be in the picture. Whether Chrome draws it before Android takes the picture is not yet confirmed. If it does not, the picture can still show the last screen.
  - A loss of focus within 1 second of a tap on a control in the app (a click, or Enter or Space on a button) is taken as the app's own system prompt (passkey, camera or clipboard permission) and covers nothing. A touch that scrolls is not a tap, so reading and scrolling a room and then leaving is still covered at once. Leaving within 1 second of a tap on a control is covered only when the page is hidden, as before, which may be too late for the picture.
  - The cover also shows briefly behind system panels that take focus without a tap in the app, such as the notification shade, and comes off when the app gets focus back or you touch it.
  - On a return after the auto-lock time the cover is drawn before the lock reloads the page, so the last frame on screen is the cover, not the room. Android may still show its stored picture for a moment while the app comes back, so if that picture showed the room, the room can show for that moment.
  - Computers do not cover when another window comes in front, only when the tab or window is hidden.
- The PIN field is a masked text field with the number pad, not a password field, so password managers do not offer to fill or save the PIN. The trade-off: some screen readers may read the digits aloud as they are typed (not yet checked with a screen reader).
- The Content Security Policy (`public/_headers`) is sent as `Content-Security-Policy-Report-Only` for now: the browser reports what it would block but blocks nothing. It is switched to enforcing after a check on phones of a preview deploy. The other security headers already apply.

**Usability**
- ilchon needs an internet connection. Without one it shows a connection screen and continues by itself once connected.
- There is no service worker, so the page itself cannot load offline. If the auto-lock reload happens while the phone has no internet, the browser shows its own offline error page instead of the app's lock screen. The key is already gone from memory, so the app stays locked; reload once you are online to get the lock screen.
- Matching waits while the contact's app is closed.
- Losing the phone or clearing storage loses chats and offers. With the 12 words the key and the contact list come back, and the app reopens each channel without meeting again; the other person keeps your name and the chat. One account works on one device at a time: the phone restored last takes over, and the other one shows that it was restored elsewhere and stops the next time it opens. Losing the passkey or PIN works the same way: reset the device, then restore with the 12 words.
- Public relays can delete what they hold, so a restore of the contact list is not guaranteed; the app keeps it on four list relays for that reason. Settings (language, relays, Lightning address, auto-lock time) are not in the list and do not come back.
- The check that stops a replaced device looks only at KeyPackages: someone holding your key who overwrites your own KeyPackage instead of publishing another one is not seen at start, only when you open the connect screen. If the old device replaces its KeyPackage (it does every 14 days) in the same moment a newly restored device starts, the new device can stop; restoring it again fixes it.
- The 12 words also restore at another address that serves this app (for example one you built yourself from this repository).
- A contact you added, renamed or deleted while every list relay refused or could not be reached is not in the list on the relays until the app reaches them again (it retries, and again when you open or return to the app). Losing the phone in between loses that change.
- Withdrawing or editing an offer, and a "trade done" notice, are re-sent until a relay accepts them, also across restarts; a failed chat message goes again only when you tap retry. If a relay accepts a message and then loses it, it is not sent again: a lost withdrawal is corrected the next time both apps are open (the contact's app runs the match again), a lost edit stays until your next edit, and a lost chat message or "done" notice stays lost.
- A message counts as sent once a relay accepted it. There are no read receipts.
- If the final connect confirmation reaches the invitee more than 7 days late, only the inviter keeps the contact; scanning again fixes it.
- marmot-ts is alpha and the Marmot spec is still changing. Do not use this for real funds.


## Run locally

Requires Node 24 (see `.node-version`) and pnpm (the version in `package.json`).

```sh
pnpm i
pnpm dev
```

Note: the build served at the public address can be older than the latest `main`.

Open several profiles in one browser with `?p=<name>`; each name has its own key and storage:

```
http://localhost:5173/?p=a
http://localhost:5173/?p=b
http://localhost:5173/?p=c
```

The app needs https or localhost (WebCrypto) and talks to real Nostr relays; the app has no mock transport. `pnpm check` runs the engine on an in-memory fake that lives only in `scripts/`.

The phone-only prompt does not appear on localhost, so you can develop in a desktop browser. Deployed preview addresses do show it.

## Scripts

`pnpm check` (`scripts/check-all.sh`, the one place that lists the steps) runs the steps in this order, with no network (the same as CI, which also runs `pnpm build`). It prints each step's time at the end and stops at the first failure with that step's exit code. Fast checks come first and the slow ones (`check:boot`, `check:guard`, `check:engine`) come last, so the table below is by topic, not by run order:

| Command | What it checks |
|---|---|
| `pnpm typecheck` | TypeScript strict check of the app and the scripts |
| `pnpm check:lint` | Biome lint and format check (`biome ci`, ts and tsx only, config in `biome.jsonc`): unused imports and variables, unreachable or mistaken code, and formatting. Fix formatting with `pnpm format`; `pnpm lint` shows lint hits. Under `src/engine` and `src/lib` the same rules are warnings, not errors |
| `pnpm check:match` | Private matching: two slots, reflection and slot swaps; opposite / same side / no offer / other context, at least one payment method in common, malformed points, echoed or faked commitments must not match, every message the same length, fresh blinding each run, same currency only (KRW, USD, JPY) |
| `pnpm check:currency` | Currencies: amount text and input per currency, whole-unit rules, wire accepts only known currencies, JPY price needs two agreeing sources or a plausible USD/JPY ratio, every currency has its labels |
| `pnpm check:storage` | Encrypted storage: codec, hidden names, request order, tamper, error classes, PIN attempts and waits, no plaintext at rest, the 12 words shown again only after the lock is proven, the auto-lock time and clock (time out of view, phone asleep, clock moved back), nothing but the support log in `localStorage` and no `pushState`, the first-run steps (start fresh, restore, back, lock) and the `#restore` mark read once and cleared |
| `pnpm check:seed` | 12 words: the official NIP-06 test vectors, the ilchon account 4242, normalization of pasted words, checksum |
| `pnpm check:list` | Contact list event on its own (no network): the list key and `d` value from the app key, one fixed size whatever the list holds, too big fails without dropping deletions, kind 30078 sealed by the list key and readable only with your key, forged or changed copies refused, a copy with an entry dated more than 10 minutes ahead refused; the digest ignores order and padding, and the merge table (later fact wins, a tie goes to the deletion, old copies do no harm) |
| `pnpm check:bolt11` | Invoice reader: BOLT11 spec test vectors (amount, expiry, network), invoice candidates in text; payment request tokens in chat text (nothing over 4,096 characters is parsed) |
| `pnpm check:relays` | Relay settings: URL normalising, the host rule for relays you choose (wss:// only, no IP address, localhost or local network name), at least 2 and at most 8, relay info assessment, the default and lookup relay lists |
| `pnpm check:nostr-profile` | Nostr profile lookup (`node:test`, no network): signatures, latest event, timeouts, NIP-05, storage |
| `pnpm check:history` | The back button (`node:test`, fake browser history): back closes an open bottom sheet, then an open chat room or the connect screen, before it leaves the app (a sheet that cannot be dismissed stays), the close button goes back once, a reload or auto-lock reopens the same room, a removed contact's room closes, history holds only the kind of screen |
| `pnpm check:i18n` | String tables and language plumbing (no network): Korean and English have the same keys and placeholders, generated Japanese files match the translation table and status, Japanese safety strings carry a valid AI cross-check before Japanese is switched on, words to avoid, no Hangul outside the string tables, no text glued together by code, the boot splash picks the same language, full-width digits in amounts and fees, no stored language outside the encrypted settings |
| `pnpm check:i18n-table` | The translation table scripts in a temporary folder (no network): CSV round trip byte for byte, files other programs write, export then import changes nothing, stops and skips, every cell of the status table, fingerprints and the cross-check rule |
| `pnpm check:inbox` | The received-message inbox on its own: a message stays stored until it was handled, comes back in order after a restart, damaged entries are dropped, a hanging store never blocks, the stored size is bounded |
| `pnpm check:boot` | Start without relays: the transport keeps retrying instead of failing, a broken stored room does not block the start, sends wait for a socket before encrypting, one relay that never answers does not stop the start or a connection, a message not handled before a restart comes again once and is stored encrypted, a send and the ingest of the same room take turns, a forgotten room gives its turn back and the other rooms go on, relay settings and the switch to the default relays (when, when not, how often it checks, one new relay list signed for the default relays, back to your relays at the next start) (fake WebSocket relays, no network) |
| `pnpm check:guard` | The inbox entrance under a flood of junk gift wraps: bounded invite store writes, no wrap decrypted twice, the real Welcome still arrives; inbox shape checks and peer relay filtering (no network) |
| `pnpm check:trade` | Money in integer minor units (won, yen, cents): checks, exact parsing without floating point, formatting, sats estimates and the sats a receiving request asks for, partial completions that add up exactly, the over-amount limit decided in integers; trade bounds of a room; the trade room view: one active invoice or on-chain address, the pay button only for the seller who matches now, the amount warning at the seller's own premium, the guide step (the buyer's step 2 follows an active receiving place for a shared method); on-chain cards (`bitcoin:` links, bare addresses, unified links read as Lightning, testnet and look-alike addresses refused) and the shared payment methods in the view and on the board |
| `pnpm check:lnurl` | Lightning address to invoice with a fake fetch (no network): address rules (NFKC, ASCII, no IP, localhost or private names), the exact request URLs, the invoice checked for amount, network, expiry and description hash, body and metadata limits, time limit, no credentials, no redirects |
| `pnpm check:onchain` | Mainnet address check (BIP-173, BIP-350 and base58 test vectors; testnet, wrong checksum variant, mixed case refused) and `bitcoin:` links (BIP-21 amounts from integers, `req-` parameters refused) |
| `pnpm check:support-log` | Support log on its own: masking of keys, amounts, accounts, addresses (Lightning and on-chain, `bitcoin:` and `lightning:` links) and urls, relay text replaced by a code, the allow list of engine events, interval lines, folding and caps, storage |
| `pnpm check:engine` | The real engine on a fake transport and virtual clock (`scripts/fake-transport.ts`, no network): terms never reach a non-matching contact (also one that differs only in payment method, which looks on the wire like any other non-match), a delete is invisible on the wire and in the support log (twin worlds, also after a restore from the 12 words), the contact list (every change reaches two list relays, a relay that did not answer is never written over, each relay's copy is merged once after a restore and the phone rules afterwards, a thief's copy is not taken in, a damaged contacts item comes back from the relays, the first phone stops once the words are restored on another), reflected matching rounds, no writes after stop, a crash at every write point (also while receiving: every message is handled once after the restart; also while re-adding a deleted contact), scanning a contact again ('already'; the two proofs pair and nothing moves, a channel out of step gets one new room from the lower key, a thief of a key can neither move a channel nor get an answer out of a rescan; a holder's deadline waits for the backlog after a start and after a return from the background, within a bounded return window; a crash at every holder write too; no QR before the key package it names is on a relay) and re-adding a deleted one by scanning, floods stay bounded, a format wipe and its retry, completions in integer amounts (one at a time, the record stored before the deduction, a crash in between finished on the next start, a re-sent completion counted once, a failed completion goes once into the room the channel is reopened in and never into the old one), the guide step kept and deleted with the contact, no pay button for a contact that never matched, a premium swap does not widen the warning, a long chat keeps the live invoice, messages that arrive while the app is locked again are handled once after unlock, receiving requests (every refusal of the request table leaves nothing sent, stored or logged; the sats at the seller's premium; no address twice in a room; a request delivered twice or retried is kept once; after a room reopens it goes into the new room only; across a tagged move and a remote reopen the seller sees at most one active card, payable only while matched, and a failed request is not sent again by itself; the Lightning address is checked once, never set through other settings and never sent) |
| `pnpm check:csp` | Response headers (`public/_headers`): Cloudflare Pages format, the CSP and other security headers, every URL the code requests is allowed by the CSP, no inline script in the HTML, no remote profile picture and no automatic NIP-05 check, the Lightning address lookups allowed and never sent to http, IP, localhost or private hosts |
| `pnpm check:a11y` | Accessibility without a browser: text colour tokens reach 4.5:1 contrast (WCAG 2.1 AA) on the surfaces they sit on, language buttons are named starting with their visible code, setup and unlock screens sit in `<main>`, the dim grey stays visibly darker than the faint grey, the room is a named dialog (not modal, so the toast is still announced), no empty heading, and every logo image is small with its size set |
| `pnpm check:tokens` | Design value names (tokens) in CSS, no network: every border width, radius, font size, transition and animation duration or curve under `src/` uses a `var(--…)` token instead of a bare number; the one allow list carries a reason per entry, and the rules are tested on a known-bad sample |

Build, and checks on real relays (network; not in CI):

| Command | What it checks |
|---|---|
| `pnpm build` | Production build (`tsc`, Vite, then `scripts/check-dist.ts`): neither the no-lock shortcut nor the test-only plain storage in the shipped files, no inline script, inline handler or `javascript:` URL in the HTML, no `eval`, `new Function`, string timer or WebAssembly in the scripts, and `_headers` copied as written |
| `pnpm e2e` | The full three-user demo scenario on real relays: A buys, B sells, C buys; A sees only B, C sees nothing, chat, partial completions on both sides, side change, JPY matches only JPY, the buyer sends an on-chain address and a Lightning invoice (from an in-process wallet service, nothing paid) to the matched seller only, silent delete; two contacts rescanning keep their room, and a channel a thief of A's key moved is won back by scanning; a user whose own relays are all dead switches to the default relays and chats with A, or keeps waiting with switching turned off; a person whose phone is lost has their contact list on at least two of the contact list relays, restores from the 12 words on an empty profile with the same key and no stored words, gets the contact back under the same name, chats again both ways without meeting, and the contact's room has at most one "connection reopened" line, with no key, words or contact name in either support log; afterwards no support log holds a key, amount, code or chat |
| `pnpm e2e:link-late` | A late connect confirmation on real relays (about a minute): when the final connect confirmation reaches the invitee late, both sides still end up with the contact, and a rescan is not blocked by the waiting link |
| `pnpm e2e:ui` | Screen test on real relays, about half a minute: Playwright starts its own dev server on port 5183 (a running `pnpm dev` on 5173 is left alone) and drives two fresh random profiles in headless Chromium at phone size (390×844): start with "no lock (dev only)", connect by "Copy code" and "Paste code" both ways, both contact lists, the back button closes the intent sheet and stays in the app, opposite intents match on both boards, the match opens the room and back closes it, then both intents are withdrawn. Known open screen bugs are written as `test.fixme` steps to turn on once fixed. One Playwright worker, one retry. Not in `pnpm check` or CI. First run on a machine: `pnpm exec playwright install --only-shell chromium`. Failure traces and screenshots go to `test-results/ui/` |
| `pnpm exec tsx scripts/smoke-marmot.ts` | Two transports create a Marmot group and exchange messages over real relays; an invite after a KeyPackage rotation, an ignored invite, a restart with a message sent while offline (`RELAYS=wss://a,wss://b` to override, `DEBUG_MARMOT=1` for transport logs) |
| `… smoke-marmot.ts list` | Contact list round trip on real relays with a throwaway key: one fixed-size kind 30078 event published to each relay and read back three ways; passes when at least two relays took it and give it back. `LIST_KEY_OUT=<file outside the repo>` keeps the throwaway secret key for a later decrypting read |
| `… smoke-marmot.ts list-read <listPubkey> <d> <eventId>` | Read-only: asks each relay for that event again (24 hours and 7 days later) and says whether it still gives back the same event; `LIST_KEY_FILE=<file>` also decrypts it. Publishes nothing |
| `… smoke-marmot.ts list-age` | Read-only: per relay, how many kind 30078 events older than 8 days it still serves and the oldest one (evidence that it keeps this kind past 7 days), with a NIP-11 summary |
| `LIST_RELAYS=wss://a,wss://b …` | Sets the relays of the three list modes (list relay candidates); without it they use `RELAYS` or the default relays |

Tools:

| Command | What it does |
|---|---|
| `pnpm i18n:table` / `pnpm i18n:import` | Not checks: export every string as a review table (CSV, or JSON for AI drafts), and the only way Japanese gets into the repository (generated `ja-strings.ts`, status and context files; nothing is written without `--write`) |
| `scripts/invoice-fixture.ts` | Not a check: builds the hand-made BOLT11 invoices that check-bolt11, check-trade and check-engine use |

## Project layout

See the module map at the top of `src/contracts.ts`: `src/lib/marmot` (transport), `src/lib/match` (private matching), `src/lib/connect` (one-time QR), `src/lib/vault` (lock keys), `src/lib/store` (encrypted storage), `src/lib/seed` (12 words), `src/engine` (all app logic, runs in Node too), `src/screens` (React UI).

How the parts fit together: [`docs/architecture.md`](docs/architecture.md). What the app protects and what it does not: [`docs/security.md`](docs/security.md).

## Credits

- UI tokens (colors, type, spacing) follow the open-source [Coconut Design System](https://github.com/noncelab/coconut_design_system) (MIT), rebuilt for the web. ilchon is **not** a Nonce Lab or Coconut Wallet product.
- Transport by [marmot-ts](https://github.com/marmot-protocol/marmot-ts); connection code follows the reference app marmots-web-chat.
- Crypto from `@noble/curves`, `@noble/hashes`, `@scure/bip39`, `@scure/bip32` and the browser's WebCrypto.

## License

MIT
