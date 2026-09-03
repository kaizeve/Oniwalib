<div align="center">

<img src="assets/oni-banner.svg" alt="oniwalib — Oni, the friendly demon mascot, holding a plug" width="100%">

<br>

**A native WhatsApp Multi-Device client, built on [RTS](https://github.com/UrubuCode/rts).**
It talks the socket directly — no browser, no Puppeteer, no headless Chrome.

<br>

[![tests](https://img.shields.io/badge/tests-810%2F810%20passing-2ea44f?style=flat-square)](#tests)
[![runtimes](https://img.shields.io/badge/runs%20on-bun%20%C2%B7%20node%20%C2%B7%20RTS-0b7285?style=flat-square)](#status)
[![language](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)](#)
[![status](https://img.shields.io/badge/status-early%20%C2%B7%20foundation-d9822b?style=flat-square)](#status)
[![license](https://img.shields.io/badge/license-restricted-c92a2a?style=flat-square)](LICENSE)

<sub>working name · progress tracked separately from the RTS core · meet **Oni**, the mascot 👹 (a demon — but a friendly one)</sub>

</div>

---

## What it is

`oniwalib` speaks to WhatsApp over the **Multi-Device** protocol, in the same
spirit as [Baileys](https://github.com/WhiskeySockets/Baileys): a WebSocket
client that implements WhatsApp's handshake, cryptography and binary format on
its own.

What's different is the execution target. Instead of running on Node with dozens
of dependencies, `oniwalib` is written to **compile with RTS** — the engine that
turns TypeScript into native machine code. The intended result is a **single
executable**, no runtime to install, with a reverse-browser memory footprint
(tens of MB, not hundreds).

### What it's for

- Automating **your own** WhatsApp account: support bots, notifications, internal
  integrations.
- A base for a **multi-language** service: the binary runs as a daemon with a
  local API, and any language (Java, Go, PHP, Python…) talks to it.
- A proving ground for RTS: Baileys-shaped code — crypto, `Buffer`, long-lived
  async sockets, protobuf — is exactly what stresses the engine.

### What it is not

Not an official client, and it doesn't pretend to be one. An unofficial WhatsApp
client **can be banned** — the main trigger is volume and unsolicited messaging,
which violates the Terms of Service. This repository has no detection-evasion
features, and won't.

---

## How it works

WhatsApp Web Multi-Device, in layers:

```
  ┌──────────────────────────────────────────────────────┐
  │  application / bot / daemon                           │
  ├──────────────────────────────────────────────────────┤
  │  events      store        profiles (stock / modified) │
  ├──────────────────────────────────────────────────────┤
  │  auth  ── registration (pairing code / QR), pre-keys  │
  ├──────────────────────────────────────────────────────┤
  │  signal      proto (WA)      frame (WABinary)         │
  ├──────────────────────────────────────────────────────┤
  │  noise  ── XX handshake · Curve25519 · AES-GCM · HKDF │
  ├──────────────────────────────────────────────────────┤
  │  transport  ── TLS · WebSocket client                 │
  └──────────────────────────────────────────────────────┘
```

1. **transport** opens a WebSocket over TLS to WhatsApp's edge.
2. **noise** runs the `Noise_XX_25519_AESGCM_SHA256` handshake: ephemeral and
   static key exchanges, each step deriving a fresh key via HKDF. At the end, a
   pair of transport keys encrypts everything from there on.
3. **frame** packs and unpacks **WABinary** — WhatsApp's XML-ish binary format,
   with a token dictionary that compresses the common tags and attributes down
   to one byte.
4. **auth** registers the device (pairing code or QR), uploads the pre-keys, and
   stores the credentials so it can reconnect without pairing again.
5. **signal** end-to-end-encrypts the message content (Double Ratchet, sender
   keys for groups).
6. **proto** is the protobuf schema that shapes the content inside the encrypted
   envelope.
7. **events** hand it to the application: `connection.update`, `messages.upsert`,
   `creds.update`…

All cryptography goes through **one interface** (`src/crypto/types.ts`). The
library core never calls `node:crypto` or anything platform-specific directly —
that's an *adapter's* job. Swapping the adapter swaps the whole backend without
touching anything else. That's what keeps `oniwalib` portable and what isolates
the single point that still depends on the engine.

---

## Status

`oniwalib` runs on **bun / node** and on **RTS**: 589/589 on bun, **566 on RTS**
(the one red is `auth/file-state.ts`, the node-only persistence file — see below).

| Module | What it does | bun / node | RTS |
|---|---|:---:|:---:|
| `frame/` | WABinary codec: binary node, buffers, JID, token tables | ✅ | ✅ |
| `noise/` | XX handshake + framing + `NoiseSocket` | ✅ | ✅ |
| `crypto/` | `Crypto` interface + `node:crypto`/`curve25519-js` adapter (bun/node) + RTS adapter (`node:crypto` incl. XEdDSA) | ✅ | ✅ |
| `proto/` | own protobuf codec (no protobufjs) + message builders (buttons / list / interactive) + `HandshakeMessage` / `ClientPayload` wire | ✅ | ✅ |
| `auth/` | credentials + Signal key store + signal identities | ✅ | ✅ |
| `pairing.ts` | `configureSuccessfulPairing` — the `<pair-success>` crypto (HMAC + account/device signatures) | ✅ | ✅ |
| `signal/` | native Double Ratchet + X3DH (1:1) **+ SenderKey group cipher (read)**, own session/sender-key records, pre-key upload — studied from libsignal, imports nothing | ✅ | ✅ |
| `messages.ts` | decrypt `<message><enc>` (`pkmsg`/`msg` **and `skmsg` — group read**) → `messages.upsert`; **channel (`@newsletter`) `<plaintext>` → `messages.upsert`**; `sendText` / `sendMessage` (1:1) **with cold-send — `assertSessions` fetches the pre-key bundle for a number you've never messaged**; **`sendStatus` — `status@broadcast` sender-key fan-out**; **reactions**; **"delete for everyone"**; pre-keys after `<success>` | ✅ | ✅ |
| `usync/` · `groups/` | `getDeviceList` (`<iq xmlns="usync">` device protocol) · `groupMetadata` (`<iq xmlns="w:g2">` — participants + admin, `announce`/`restrict`, community via `<parent>`/`<linked_parent>`); `client.assertGroupSessions` chains metadata → USYNC → cold-send | ✅ | ✅ |
| `privacy/` | `fetchPrivacySettings` / `updatePrivacySetting` (`<iq xmlns="privacy">`) | ✅ | ✅ |
| `presence.ts` | `<presence>` / `<chatstate>` → `presence.update` (online, last seen, typing, recording); `sendPresenceUpdate` / `subscribePresence`; `client` read receipts + `markOnlineOnConnect` / `sendReadReceipts` toggles | ✅ | ✅ |
| `notifications.ts` | `<notification>` for profile picture / status (bio) → `contacts.update` | ✅ | ✅ |
| `client.ts` | `openWhatsApp` — QR + pairing + `515` restart + login + keepalive/acks + message / presence / notification pipeline | ✅ | ✅¹ |
| `auth/file-state.ts` | encrypted append-only log persistence (node-only, `node:fs`) | ✅ | ⚠️² |
| `transport/` | `Transport` interface + `MockTransport` + `WebSocketTransport` (bun/node) | ✅ | ✅ |
| `events/` · `profiles/` | typed event surface · stock vs modified | ✅ | ✅ |
| `transport/` — RTS connector | TLS + WebSocket client with custom headers / Origin on the engine | ⛔ | ⛔ |

<sub>¹ `client.ts` passes on RTS via `test/client.test.ts` (full pairing → `515`
restart → login over the mock server); a live socket still needs the RTS
transport connector.</sub>

<sub>² `test/file-state.test.ts` fails on RTS with an `ENOENT` on a freshly
written file mid-test; every `node:fs` call it uses works in isolation, so it's a
sequencing edge in RTS's `node:fs` still to be pinned down. The core never
imports this file (it's opt-in, like the RTS transport connector).</sub>

<sub>RTS engine quirks worked around in the source: `const f = () => …; f()?.x`
raised a bogus TDZ `ReferenceError` (use a `function` declaration); two sibling
`const` of the same name inside an awaited async arrow tripped `ReferenceError:
x is not defined` (give them distinct names); `[…].map(…).join(sep)` with a
non-ASCII `sep` prepended a stray separator (fold the sep into the `map`) —
filed as [UrubuCode/rts#2612](https://github.com/UrubuCode/rts/issues/2612). A
native binary of the lib waits on module-graph AOT
([UrubuCode/rts#2611](https://github.com/UrubuCode/rts/issues/2611)); `rts run` /
`rts test` compile the graph today.</sub>

### Phase 0 — engine primitives

| Primitive | API | State in RTS |
|---|---|---|
| SHA-256, HMAC-SHA256, HKDF, `randomBytes` | `node:crypto` | ✅ already present |
| AES-128/256-GCM and -CBC | `createCipheriv` / `createDecipheriv` (with `setAAD` / `getAuthTag` / `setAuthTag`) | ✅ added |
| X25519 ECDH | `generateX25519KeyPair` / `x25519PublicKey` / `x25519DiffieHellman` (raw bytes, no KeyObject) | ✅ added |
| Curve25519 signing (XEdDSA) | `xeddsaSign` / `xeddsaVerify` (raw bytes, no KeyObject) | ✅ added ([#2609](https://github.com/UrubuCode/rts/pull/2609)) |

With this, the Noise handshake, credential initialization, identity signing,
the Signal 1:1 + group ciphers, pairing and the message/presence pipeline all
run on the engine — `RTS_GAPS` is empty and the suite is green on RTS bar
`file-state`. What's left to actually **connect** on RTS is the transport layer
(TLS + WebSocket client). On **bun / node** it's all covered, so pairing works
end to end there today — see
`examples/pair.ts`.

### <a name="tests"></a>Tests

`version` 11 · `wire` 24 (protobuf codec + `HandshakeMessage` / `ClientPayload`)
· `wabinary` 29 · `jid` 20 (`jidKind` — user / group·community / channel
`@newsletter` / status / broadcast / lid / bot) · `e2e-message` 46 · `crypto` 19 (node/rts adapter parity —
hash/HMAC/HKDF/AES-GCM/CBC — plus XEdDSA sign/verify: round-trip, tamper
rejection, random-`Z`) · `noise` 12 · `auth` 22 · `file-state` 18 ·
`socket` 6 · `presence` 21 (receive `<presence>`/`<chatstate>`, send presence /
subscribe) · `notifications` 10 (profile picture / bio → `contacts.update`) ·
`bot` 51 (command dispatch + CPU/RAM monitor + end-to-end over the mock server).

Plus the Signal layer and everything bun-only for now: `signal` 13 (X3DH,
Double Ratchet, re-key, out-of-order, MAC rejection — two in-memory parties, no
server) · `sender-key` 17 (group cipher: SKDM distribution, in/out-of-order
decrypt, replay + bad-signature rejection, serialization) · `prekeys` 26 ·
`messages` 68 (incoming `pkmsg` → `messages.upsert` → `sendText`/`sendMessage`
reply decrypted back; group read: standalone SKDM → `skmsg` → text; retry
receipt with the full `<keys>` block on a decrypt miss; **cold-send** —
`assertSessions` fetches the bundle and opens X3DH end to end; **channel**
`<plaintext>` → `messages.upsert`; **status** `status@broadcast` sender-key
fan-out) · `media` 66 (audio /
image / video / document / sticker send: per-type HKDF → AES-CBC + 10-byte MAC,
`media_conn` `<iq>`, upload POST with host fallback, `*Message` codec roundtrip;
`downloadMedia` — GET by `url`/`directPath`, verify the 10-byte MAC and
`fileSha256`, AES-CBC decrypt back to the original bytes) ·
`profile` 11 (set / remove profile picture, set bio — the `w:profile:picture` /
`status` `<iq>`) · `privacy` 11 (`fetchPrivacySettings` / `updatePrivacySetting`
— the `<iq xmlns="privacy">` `<category>` parse, flat and nested) · `usync` 15
(`getDeviceList` — the `<iq xmlns="usync">` device-list query + parse, jid
normalization, dedup) · `groups` 62 (`groupMetadata` — the `<iq xmlns="w:g2">`
`<group>` parse: subject/owner/participants+admin, `announce`/`restrict`,
community via `<parent>` / `<linked_parent>`) · `reaction` 19
(reaction / `protocolMessage` codec roundtrip; incoming reaction → `messages.reaction`,
revoke → `messages.delete`; `sendReaction` encrypted back) · `pairing` 18 (the
`<pair-success>` crypto both directions) ·
`client` 18 (QR → pairing → `515` restart → login `<success>`, over the mock
server) → **810 / 810 on bun**.

### <a name="oni-version"></a>Keeping it working — the oni-version

WhatsApp Web announces a protocol version tuple `[2, minor, patch]` in the
handshake. When WhatsApp bumps it on their side, a client still sending the old
one stops working — the QR won't connect, login is refused.

`oniwalib` handles this the way Baileys does, without needing a new release:

- `oni-version.json` at the repo root holds the current known-good tuple. **Edit
  it and every client that calls `resolveOniVersion()` picks it up** over
  `raw.githubusercontent`.
- `resolveOniVersion()` resolves in order: explicit `override` → cached →
  fetched (from `oni-version.json`, then a live parse of `web.whatsapp.com`) →
  the built-in fallback.
- `versionBuildHash()` derives the `buildHash` the registration payload needs
  from the tuple.

```ts
import { resolveOniVersion } from "oniwalib";

const { version, source } = await resolveOniVersion();   // e.g. [2, 3000, 1023223821] from "fetch"
```

---

## Usage

> A live connection needs the real transport. What already works today is
> building and inspecting messages, and running the handshake against a
> reference adapter.

### Build a message with buttons

```ts
import { message as m } from "oniwalib";

const msg = m.buttons({
  content: "Pick an option:",
  footer: "oniwalib",
  buttons: [
    { id: "menu",  text: "See menu" },
    { id: "human", text: "Talk to a human" },
  ],
});
```

### Native flow (the path modified forks use today)

```ts
import { message as m } from "oniwalib";

const msg = m.interactive({
  body: "Your order is ready.",
  footer: "Shop X",
  buttons: [
    m.flow.url("Track it", "https://shop.x/order/123"),
    m.flow.copy("Copy code", "ABC123"),
    m.flow.quickReply("Rate us", "rate:123"),
  ],
});
```

### A basic bot (`examples/bot.ts`)

`oniwalib` doesn't connect to WhatsApp yet, so the bot runs over `MockWaServer`
(the in-memory Noise server). The command dispatch and the CPU/RAM monitoring
are real and portable — when the real transport lands, `attachBot` points at it
and the bot works for real.

```bash
bun examples/bot.ts
../rts/target/fast/rts run examples/bot.ts
```

```
→ user  !ping
← bot   pong    (round-trip ~30ms)

→ user  !status
← bot   *oni-demo* · linux · 4 vCPU
        uptime  0s
        cpu     16.7%   load 0.67 / 0.64 / 0.70
        ram     61 MB RSS
        sistema 12 GB / 16 GB
```

`OniBot` ships `!ping !status !mem !uptime !echo !table !buttons !list !menu
!help`; `bot.register(name, help, handler)` adds your own. `!ping` reports the
WhatsApp→bot latency (from the server timestamp); `!table` replies with a
monospaced table; `!buttons` / `!list` send real `buttonsMessage` /
`listMessage`, and a tap comes back as the button/row id — so a button whose id
is `!ping` routes through the same handler as the typed command.
`Monitor.sample()` gives the stats object.

### Keeping a live bot running (`pm2`)

`examples/connect-bot.ts` connects for real (QR the first time, session cached in
`./oni-auth/`). `ecosystem.config.cjs` runs it under **pm2** with `watch` on
`src/` and `examples/`, so every code change reloads the bot on the latest
library — it reconnects from the cached session, no re-pair.

```bash
bun run bot          # foreground, first run — scan the QR
npm run bot:up       # background via pm2 (bunx pm2, no global install) + tail logs
npm run bot:restart  # manual reload
npm run bot:down     # stop
```

### Encode / decode a binary node

```ts
import { frame } from "oniwalib";

const bytes = frame.encodeBinaryNode(
  frame.node("iq", { type: "get", xmlns: "w:p", to: "s.whatsapp.net" }),
);
const back = frame.decodeBinaryNode(bytes); // → { tag: "iq", attrs: {...} }
```

### Run a NoiseSocket over a mock transport

```ts
import { NoiseSocket, mockTransportPair, crypto, encodeClientPayload,
         buildClientPayload, initAuthCreds, STOCK } from "oniwalib";

const [clientT] = mockTransportPair();
const sock = new NoiseSocket({
  transport: clientT,
  crypto: crypto(),
  staticKey: crypto().generateX25519(),
  clientPayload: encodeClientPayload(buildClientPayload(initAuthCreds(), STOCK)),
});
sock.events.on("node.recv", (node) => console.log("<-", node.tag));
await sock.connect();
```

---

## Project layout

```
oniwalib/
├── assets/
│   └── oni-banner.svg        the mascot
├── src/
│   ├── frame/                WABinary codec
│   │   ├── constants.ts        tags + token tables (PROVENANCE: to verify)
│   │   ├── buffer.ts           BufferReader/Writer + own UTF-8
│   │   ├── jid.ts              JID parse / format
│   │   ├── node.ts             the BinaryNode type + accessors
│   │   ├── decode.ts           bytes → BinaryNode
│   │   └── encode.ts           BinaryNode → bytes
│   ├── noise/
│   │   ├── frame.ts           framing [3-byte len][payload] + intro header
│   │   ├── handshake.ts       Noise_XX_25519_AESGCM_SHA256, client side
│   │   ├── wire.ts            HandshakeMessage protobuf
│   │   └── socket.ts          NoiseSocket: transport + handshake + WABinary
│   ├── crypto/
│   │   ├── types.ts           the Crypto interface (the platform boundary)
│   │   ├── node-adapter.ts    over node:crypto (bun / node)
│   │   ├── rts-adapter.ts     over RTS's crypto primitives
│   │   └── index.ts           crypto() / setCrypto() with runtime detection
│   ├── proto/
│   │   ├── wire.ts            minimal protobuf codec (varint, len-delimited, i32/i64)
│   │   ├── message.ts         body builders: text, buttons, list, template, interactive
│   │   ├── handshake.ts       ClientPayload types + buildClientPayload (register + login)
│   │   ├── client-payload.ts  ClientPayload → protobuf bytes
│   │   └── adv.ts             ADV device-identity protobufs (pairing)
│   ├── auth/
│   │   ├── state.ts           initAuthCreds, memoryAuthState, own base64
│   │   └── file-state.ts      fileAuthState — encrypted append-only credential store
│   ├── pairing.ts             configureSuccessfulPairing — the <pair-success> crypto
│   ├── connect.ts             connectOni — transport + Noise handshake, up to first stanza
│   ├── client.ts              openWhatsApp — the connection driver (QR, pairing, 515, login)
│   ├── transport/
│   │   ├── types.ts           Transport interface + WhatsApp endpoints
│   │   ├── websocket.ts       WebSocketTransport (bun / node)
│   │   ├── mock.ts            in-memory transport pair (tests)
│   │   └── mock-wa-server.ts  in-memory Noise responder + message relay (tests)
│   ├── bot/
│   │   ├── bot.ts             OniBot — command router
│   │   └── monitor.ts         CPU / RAM / uptime sampling
│   ├── events/
│   │   └── emitter.ts         typed Emitter + OniwalibEvents
│   ├── profiles/
│   │   └── index.ts           STOCK vs MODIFIED
│   ├── version.ts             oni-version: WhatsApp protocol version resolver
│   └── index.ts
├── oni-version.json           the current known-good WA version (edit to update)
├── examples/
│   ├── bot.ts                 basic bot: commands + CPU/RAM, over the mock server
│   └── connect-bot.ts         the same bot on a real connection (QR + cached session)
├── ecosystem.config.cjs       pm2: keep connect-bot.ts running, watch + reload on change
├── scripts/
│   └── tests.mjs              the test runner — runs the suite, syncs the README counts
├── test/                      version · wire · wabinary · noise · auth · file-state · socket · signal · sender-key · bot · pairing · client
├── PUBLISH.md                 how to push and keep this repo updated
├── package.json · tsconfig.json · LICENSE · README.md
```

---

## Development

```bash
# one file, reference runtime
bun test/wire.test.ts

# the same file on the target engine
../rts/target/fast/rts run test/wire.test.ts

# the whole suite (also rewrites the test counts in this README)
npm test            # bun
npm run test:rts    # RTS — runs the subset that the engine supports, no README write
```

Running both and comparing is the "Baileys-shaped code works on RTS" test.
`npm test` goes through `scripts/tests.mjs`: it runs every file, and when the
bun suite is green it updates the badge and the **Tests** section above with the
fresh numbers.

### Stock and modified

One core. `src/profiles/index.ts` applies a set of parameters on top: the client
identity (browser triple, version), the pairing-code string, and whether the
interactive message types are on.

- **`STOCK`** — default client identity, no shaping. Smaller detection surface.
- **`MODIFIED`** — custom identity, a standardizable fixed pairing code,
  interactive types on. The user chooses, **with their own account at risk**.

---

## License

**Exclusive use of the author and the RTS creators.** Not open source. Do not
redistribute, publish, or use outside that circle without permission. See
[`LICENSE`](LICENSE).

Author: **loveless**.

---

<div align="center">
<sub>oniwalib · draft · progress tracked separately from the RTS core</sub>
</div>
