<div align="center">

<img src="assets/oni-banner.svg" alt="oniwalib — Oni, the friendly demon mascot, holding a plug" width="100%">

<br>

**A native WhatsApp Multi-Device client, built on [RTS](https://github.com/UrubuCode/rts).**
It talks the socket directly — no browser, no Puppeteer, no headless Chrome.

<br>

[![tests](https://img.shields.io/badge/tests-87%2F87%20passing-2ea44f?style=flat-square)](#tests)
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

`oniwalib` runs on **bun / node today**, and on **RTS** for everything that
doesn't need a cryptographic primitive the engine doesn't expose yet.

| Module | What it does | bun / node | RTS |
|---|---|:---:|:---:|
| `frame/` | WABinary codec: binary node, buffers, JID, token tables | ✅ | ✅ |
| `noise/` | XX handshake + framing + `NoiseSocket` | ✅ | ✅ |
| `crypto/` | `Crypto` interface + `node:crypto` adapter (bun/node) + RTS adapter | ✅ | ✅ |
| `proto/` | own protobuf codec (no protobufjs) + message builders (buttons / list / interactive) + `HandshakeMessage` / `ClientPayload` wire | ✅ | ✅ |
| `auth/` | credentials + Signal key store | ✅ | ✅¹ |
| `transport/` | `Transport` interface + `MockTransport` | ✅ | ✅ |
| `events/` · `profiles/` | typed event surface · stock vs modified | ✅ | ✅ |
| `transport/` — real connector | TLS + WebSocket client with custom headers / Origin | ⛔ | ⛔ |

<sub>¹ Identity signing (XEdDSA) isn't in RTS yet — on the engine, the
`signedPreKey` carries a placeholder signature until Phase 2. Everything else
runs native.</sub>

### Phase 0 — engine primitives

| Primitive | API | State in RTS |
|---|---|---|
| SHA-256, HMAC-SHA256, HKDF, `randomBytes` | `node:crypto` | ✅ already present |
| AES-128/256-GCM and -CBC | `createCipheriv` / `createDecipheriv` (with `setAAD` / `getAuthTag` / `setAuthTag`) | ✅ added |
| X25519 ECDH | `generateX25519KeyPair` / `x25519PublicKey` / `x25519DiffieHellman` (raw bytes, no KeyObject) | ✅ added |
| Curve25519 signing (XEdDSA) | — | ⛔ pending (Phase 2) |

With this, the Noise handshake and credential initialization run on the engine.
What's left to actually connect is the transport layer (TLS + WebSocket client).

### <a name="tests"></a>Tests

`wire` 24 (protobuf codec + `HandshakeMessage` / `ClientPayload`) · `wabinary`
23 · `noise` 12 · `auth` 22 · `socket` 6 (integration: transport → framing → XX
handshake → transport crypto → WABinary, end to end) → **87 / 87 on bun AND on
RTS**.

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
│   │   ├── handshake.ts       ClientPayload types + buildClientPayload
│   │   └── client-payload.ts  ClientPayload → protobuf bytes
│   ├── auth/
│   │   └── state.ts           initAuthCreds, memoryAuthState, own base64
│   ├── transport/
│   │   ├── types.ts           Transport interface + WhatsApp endpoints
│   │   └── mock.ts            in-memory transport pair (tests)
│   ├── events/
│   │   └── emitter.ts         typed Emitter + OniwalibEvents
│   ├── profiles/
│   │   └── index.ts           STOCK vs MODIFIED
│   └── index.ts
├── test/                      wire · wabinary · noise · auth · socket
├── PUBLISH.md                 how to push and keep this repo updated
├── package.json · tsconfig.json · LICENSE · README.md
```

---

## Development

```bash
# reference runtime
bun test/wire.test.ts

# the same tests on the target engine
../rts/target/fast/rts run test/wire.test.ts
```

Running both and comparing is the "Baileys-shaped code works on RTS" test.

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
