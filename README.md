<div align="center">

<img src="assets/oni-banner.png" alt="OniWaLib — Oni riding a raven, over the RTS wordmark" width="100%">

<br>

**A native WhatsApp Multi-Device client, built on [RTS](https://github.com/UrubuCode/rts).**
It talks the socket directly — no browser, no Puppeteer, no headless Chrome.

<br>

[![tests](https://img.shields.io/badge/tests-1071%2F1071%20passing-2ea44f?style=flat-square)](#tests)
[![runtimes](https://img.shields.io/badge/runs%20on-bun%20%C2%B7%20node%20%C2%B7%20RTS-0b7285?style=flat-square)](#status)
[![language](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)](#)
[![status](https://img.shields.io/badge/status-early%20%C2%B7%20foundation-d9822b?style=flat-square)](#status)
[![license](https://img.shields.io/badge/license-restricted-c92a2a?style=flat-square)](LICENSE)
[![channel](https://img.shields.io/badge/WhatsApp-official%20channel-25D366?style=flat-square&logo=whatsapp&logoColor=white)](https://whatsapp.com/channel/0029Vb93Ug3LI8YRuoroJd44)

<sub>**OniWaLib** · `v0.1.0` · progress tracked separately from the RTS core · meet **Oni**, the mascot 👹 (a demon — but a friendly one)</sub>

<sub>Official channel: **[whatsapp.com/channel/0029Vb93Ug3LI8YRuoroJd44](https://whatsapp.com/channel/0029Vb93Ug3LI8YRuoroJd44)** — releases, API changes, breaking-change notices.</sub>

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

`oniwalib` **connects to WhatsApp for real** on **bun / node** today — pairing
(QR + code), 1:1 and group messaging, media, status, groups, channels,
app-state sync and the rest of the surface in [`docs/API.md`](docs/API.md). A
reference bot (`examples/connect-bot.ts`) has been running against a live
account under `pm2` throughout development.

**On RTS it connects to WhatsApp for real too.** `rts run examples/bot-rts.ts`
opens the socket over the engine's `node:tls` / `ws`, runs the full Noise XX
handshake, and prints a pairing QR. `rts compile src/index.ts` produces a
**native ELF binary** (module-graph AOT landed —
[#2611](https://github.com/UrubuCode/rts/issues/2611), with
[#2612](https://github.com/UrubuCode/rts/issues/2612) /
[#2617](https://github.com/UrubuCode/rts/issues/2617) fixed alongside). The RTS
entrypoint is explicit — `await conn.start(); await conn.waitUntilClose();` —
because `rts run` drains its task queue and exits without a `setInterval`, so the
connect chain must be awaited and the process held open by a loop; bun/node don't
need it. Auth persists with **`jsonFileAuthState(path)`** (plain read/write, no
`stat`) — `fileAuthState`'s encrypted append-log hits a `node:fs` edge on RTS.
Still open on RTS: `import "oniwalib"` from `node_modules`
([#2625](https://github.com/UrubuCode/rts/issues/2625)) — vendor the source.

Suite: **1071 / 1071 on bun**, **green on RTS** (`rts run` / `rts test`).
`client` and `file-state` skip themselves on the engine — the first drives the
whole connection over the mock transport and hits an RTS async-scheduler edge,
the second is node-only persistence with a `node:fs` sequencing edge; neither is
in the library's path.

| Area | What it does | bun / node | RTS |
|---|---|:---:|:---:|
| `frame/` | WABinary codec: binary node, buffers, JID (`jidKind`), token tables | ✅ | ✅ |
| `noise/` | `Noise_XX_25519_AESGCM_SHA256` handshake + framing + `NoiseSocket` | ✅ | ✅ |
| `crypto/` | `Crypto` interface + `node:crypto`/`curve25519-js` adapter (bun/node) + RTS adapter (`node:crypto` incl. XEdDSA, X25519, `inflate`) — `RTS_GAPS` empty | ✅ | ✅ |
| `proto/` | own protobuf codec (no protobufjs) + `E2EMessage` codec (text, media, buttons/list/native-flow, poll, album, contextInfo, protocolMessage) + `ClientPayload` / `HandshakeMessage` wire | ✅ | ✅ |
| `auth/` | credentials, Signal key store, signal identities; `memoryAuthState` + encrypted append-only `fileAuthState` | ✅ | ✅¹ |
| `pairing.ts` · `client.ts` | `openWhatsApp` — QR + pairing code, `<pair-success>` crypto, `515` restart, login, keepalive/acks, the message / presence / notification / call pipeline | ✅ | ✅² |
| `signal/` | native Double Ratchet + X3DH (1:1) + SenderKey group cipher (read + write), cold-send (`assertSessions` — prekey-bundle fetch + X3DH), pre-key top-up with a watermark — studied from libsignal, imports nothing | ✅ | ✅ |
| `messages.ts` | decrypt `pkmsg`/`msg`/`skmsg` → `messages.upsert`; `sendText`/`sendMessage`/`sendAlbum` 1:1 + group; **edit** + **delete-for-all**; **reactions**; **polls** (create + `decryptPollVote`); `sendContact` / `sendLocation`; link preview; `SendOptions` (quoted reply, mentions, ephemeral) | ✅ | ✅ |
| `media/` | send audio/image/video/document/sticker (per-type HKDF → AES-CBC + 10-byte MAC, `media_conn`, upload with host fallback); auto width/height + thumbnail; `downloadMedia` + `autoDownloadMedia` → `messages.media` | ✅ | ✅ |
| status | `postStatus` (`status@broadcast` sender-key fan-out) **and receive** (generic skmsg path) | ✅ | ✅ |
| `groups/` | `groupMetadata` + full management (create/leave/subject/description/participants/settings/ephemeral/approval-mode/invite-code/accept/join-requests) + **community** subgroups (list/link/unlink) | ✅ | ✅ |
| `appstate/` | **LT-hash app-state sync** — `updateProfileName` (push name), `chatModify` (mute/pin/archive/read), labels; auto key-capture + resync. LT-hash + key expansion byte-verified against `whatsapp-rust-bridge` | ✅ | ✅ |
| `history/` | `historySyncNotification` → download blob → zlib-inflate → `messaging-history.set` (chats + pushnames + lid map + message bodies) | ✅ | ✅ |
| `channels/` | `@newsletter`: metadata, follow/unfollow, mute, create, delete, react, fetch old posts, live-updates subscribe; text + media send | ✅ | ✅ |
| `usync/` · `privacy/` · `presence.ts` · `blocklist/` · `calls/` | device list; privacy get/set; presence recv + send + toggles + read receipts; block/unblock; incoming `call` event + `rejectCall` | ✅ | ✅ |
| `business/` | Business read — `getBusinessProfile` / `getCatalog` / `getCollections` / `getOrderDetails` | ✅ | ✅ |
| `store/` | `makeInMemoryStore` — chats / contacts / messages / presence / group meta / labels / poll votes, `toJSON`/`fromJSON` | ✅ | ✅ |
| `notifications.ts` · `events/` · `profiles/` | `<notification>` → `contacts.update`; typed event surface; stock vs modified fingerprint | ✅ | ✅ |
| `transport/` | `Transport` interface + `MockTransport` + `wsConnector` (default — `ws` package, falls back to the global `WebSocket`) | ✅ | ✅³ |

<sub>³ `wsConnector` connects on RTS via `ws` over `node:tls` / `node:net`;
`connectOni` completes the Noise handshake against live WhatsApp on the engine.
`openWhatsApp`'s reconnect loop still hits an RTS async edge — see above.</sub>

<sub>¹ `test/file-state.test.ts` red on RTS — an `ENOENT` on a freshly written
file mid-test; each `node:fs` call works in isolation, so a sequencing edge in
RTS's `node:fs`. The library never imports this file unless you opt in (use
`memoryAuthState` on the engine).</sub>

<sub>² `client.ts` passes on RTS via the mock server; `test/client.test.ts`
itself is red on the engine ("promise cannot settle" — an async-scheduler edge
in the test's mock transport driver, not the library).</sub>

<sub>RTS engine issues found while porting, **all filed and now fixed
upstream**: module-graph AOT
([#2611](https://github.com/UrubuCode/rts/issues/2611)), regex `[` in a char
class ([#2612](https://github.com/UrubuCode/rts/issues/2612)), a closure over a
param that indexes `Map.get(k)?.[0]` returning the param
([#2617](https://github.com/UrubuCode/rts/issues/2617)). One workaround stays in
the source (const-arrow `?.` TDZ → `function` decl). Open:
`node_modules` bare-specifier resolution
([#2625](https://github.com/UrubuCode/rts/issues/2625)).</sub>

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

`version` 13 · `wire` 31 (protobuf codec + `HandshakeMessage` / `ClientPayload`)
· `wabinary` 29 · `jid` 20 (`jidKind` — user / group·community / channel
`@newsletter` / status / broadcast / lid / bot) · `e2e-message` 68 · `crypto` 19 (node/rts adapter parity —
hash/HMAC/HKDF/AES-GCM/CBC — plus XEdDSA sign/verify: round-trip, tamper
rejection, random-`Z`) · `noise` 12 · `auth` 22 · `file-state` 18 ·
`socket` 6 · `presence` 21 (receive `<presence>`/`<chatstate>`, send presence /
subscribe) · `notifications` 10 (profile picture / bio → `contacts.update`) ·
`bot` 51 (command dispatch + CPU/RAM monitor + end-to-end over the mock server).

Plus the Signal layer and everything bun-only for now: `signal` 13 (X3DH,
Double Ratchet, re-key, out-of-order, MAC rejection — two in-memory parties, no
server) · `sender-key` 17 (group cipher: SKDM distribution, in/out-of-order
decrypt, replay + bad-signature rejection, serialization) · `prekeys` 26 ·
`messages` 99 (incoming `pkmsg` → `messages.upsert` → `sendText`/`sendMessage`
reply decrypted back; group read: standalone SKDM → `skmsg` → text; retry
receipt with the full `<keys>` block on a decrypt miss; **cold-send** —
`assertSessions` fetches the bundle and opens X3DH end to end; **channel**
`<plaintext>` → `messages.upsert`; **status** `status@broadcast` sender-key
fan-out) · `media` 82 (audio /
image / video / document / sticker send: per-type HKDF → AES-CBC + 10-byte MAC,
`media_conn` `<iq>`, upload POST with host fallback, `*Message` codec roundtrip;
`downloadMedia` — GET by `url`/`directPath`, verify the 10-byte MAC and
`fileSha256`, AES-CBC decrypt back to the original bytes) ·
`profile` 20 (set / remove profile picture, set bio — the `w:profile:picture` /
`status` `<iq>`) · `privacy` 11 (`fetchPrivacySettings` / `updatePrivacySetting`
— the `<iq xmlns="privacy">` `<category>` parse, flat and nested) · `usync` 21
(`getDeviceList` — the `<iq xmlns="usync">` device-list query + parse, jid
normalization, dedup) · `groups` 67 (`groupMetadata` — the `<iq xmlns="w:g2">`
`<group>` parse: subject/owner/participants+admin, `announce`/`restrict`,
community via `<parent>` / `<linked_parent>`) · `reaction` 19
(reaction / `protocolMessage` codec roundtrip; incoming reaction → `messages.reaction`,
revoke → `messages.delete`; `sendReaction` encrypted back) · `pairing` 18 (the
`<pair-success>` crypto both directions) ·
`client` 18 (QR → pairing → `515` restart → login `<success>`, over the mock
server) → **1071 / 1071 on bun**.

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

## Install

```bash
bun  add oniwalib        # or: git clone … && bun install
npm  install oniwalib
```

`import { openWhatsApp } from "oniwalib"` resolves per runtime:

| Runtime | Entry | Notes |
|---|---|---|
| **bun** | `src/index.ts` (the `"bun"` export condition) | runs the TypeScript directly, no build |
| **node** | `dist/index.js` | a single bundled ESM file (`bun run build`, auto on `prepack`); `node:*` builtins external, everything else inlined |
| **RTS** | `src/index.ts` | `rts run` / `rts test` compile the module graph; a checkout is the usual mode |

`npm run smoke` packs the library and imports it by name from a clean consumer
under node **and** bun — the deploy gate.

## Usage

**Full method + event reference: [`docs/API.md`](docs/API.md).**

### Connect and reply

```ts
import { openWhatsApp, fileAuthState } from "oniwalib";

const auth = fileAuthState("./auth/state.owl");     // encrypted, append-only
const conn = openWhatsApp({
  auth,
  saveCreds: () => auth.saveCreds(),
  fetch: globalThis.fetch,                          // for media / link preview
});

conn.events.on("connection.update", ({ qr, connection }) => {
  if (qr) console.log("scan:", qr);
  if (connection === "open") console.log("online");
});

conn.events.on("messages.upsert", async ({ type, messages }) => {
  if (type !== "notify") return;
  for (const m of messages) {
    if (m.key.fromMe || !m.message) continue;
    await conn.sendText(m.key.remoteJid, "pong");
  }
});
```

First run prints a QR (or use `countryCode` + the `pairingCode` on
`connection.update` for a pairing code). The session caches in the auth store —
reconnects don't re-pair.

**On RTS**, drive it explicitly (see `examples/bot-rts.ts`):

```ts
const conn = openWhatsApp({ auth, saveCreds });
conn.events.on("connection.update", …);
conn.events.on("messages.upsert", …);
await conn.start();          // run the connect chain in an awaited context
await conn.waitUntilClose(); // hold the process open + keepalive-ping
```

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

### A basic bot

`examples/connect-bot.ts` is the real thing: `OniBot` (command router) on a live
connection, session cached in `./oni-auth/`. `examples/bot.ts` runs the same bot
over `MockWaServer` (in-memory Noise server) for a no-account smoke test that
also runs on RTS.

```bash
bun examples/connect-bot.ts        # live — scan the QR the first time
bun examples/bot.ts                # over the mock server
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
├── docs/API.md               method + event reference (the real one)
├── src/
│   ├── frame/                WABinary codec — node, buffers, JID, token tables, encode/decode
│   ├── noise/                XX handshake + framing + NoiseSocket
│   ├── crypto/               Crypto interface + node adapter + RTS adapter + runtime detect
│   ├── proto/                own protobuf codec + E2EMessage codec + ClientPayload/handshake wire + ADV
│   ├── auth/                 initAuthCreds, memoryAuthState, encrypted file-state, own base64
│   ├── signal/               Double Ratchet + X3DH + SenderKey group cipher + prekeys (own records)
│   ├── pairing.ts            configureSuccessfulPairing — the <pair-success> crypto
│   ├── connect.ts            connectOni — transport + Noise handshake up to the first stanza
│   ├── client.ts             openWhatsApp — QR / pairing / 515 / login / the pipeline (OniConnection)
│   ├── messages.ts           decrypt + send (text/media/album/edit/delete/reaction/poll/contact/location)
│   ├── media/                encrypt + upload + download; dimensions + thumbnail
│   ├── link-preview.ts       fetch the first URL → title/description card
│   ├── groups/               metadata + full management + community subgroups
│   ├── appstate/             LT-hash sync — lt-hash, key expansion, patch codec, layer
│   ├── history/              historySyncNotification → inflate → messaging-history.set
│   ├── channels/             @newsletter — follow/mute/create/react/fetch/subscribe
│   ├── usync/ privacy/ presence.ts blocklist/ calls/ notifications.ts
│   ├── business/             Business read — profile / catalog / collections / orders
│   ├── store/                makeInMemoryStore
│   ├── transport/            Transport interface + MockTransport + WebSocketTransport
│   ├── bot/                  OniBot command router + CPU/RAM monitor
│   ├── events/ profiles/ version.ts
│   └── index.ts
├── oni-version.json          the current known-good WA version (edit to update)
├── examples/                 connect-bot.ts (live) · bot.ts (mock) · pair.ts · connect-*.ts
├── ecosystem.config.cjs      pm2: keep connect-bot.ts on the latest lib
├── scripts/tests.mjs         the test runner — runs the suite, syncs the README counts
├── test/                     36 files, one per module (self-labels [bun] / [rts] / [node])
├── CHANGELOG.md · PUBLISH.md · package.json · tsconfig.json · LICENSE · README.md
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
