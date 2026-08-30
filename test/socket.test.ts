// Integração: transporte + enquadramento + Noise XX + cripto de transporte +
// WABinary, tudo junto, sobre um par de MockTransport. O "servidor" é inline,
// com o transcript XX escrito à mão (como em noise.test.ts).

import { crypto } from "../src/crypto";
import { NoiseSocket } from "../src/noise/socket";
import { mockTransportPair } from "../src/transport/mock";
import { FrameDecoder, encodeFrame } from "../src/noise/frame";
import { decodeHandshake, encodeHandshake } from "../src/noise/wire";
import { decodeBinaryNode, encodeBinaryNode } from "../src/frame/index";
import { node } from "../src/frame/node";
import type { Transport } from "../src/transport/types";

const C = crypto();
let pass = 0;
let fail = 0;
const fails: string[] = [];
const ok = (n: string, c: boolean, d = "") => {
  if (c) pass++;
  else {
    fail++;
    fails.push(n + (d ? ` — ${d}` : ""));
  }
};
const cat = (...ps: Uint8Array[]) => {
  let n = 0;
  for (const p of ps) n += p.length;
  const o = new Uint8Array(n);
  let k = 0;
  for (const p of ps) {
    o.set(p, k);
    k += p.length;
  }
  return o;
};
const iv = (ctr: number) => {
  const b = new Uint8Array(12);
  b[11] = ctr & 0xff;
  b[10] = (ctr >>> 8) & 0xff;
  b[9] = (ctr >>> 16) & 0xff;
  b[8] = (ctr >>> 24) & 0xff;
  return b;
};

// ---- servidor XX inline sobre um Transport ------------------------------

class Server {
  hash!: Uint8Array;
  salt!: Uint8Array;
  encKey!: Uint8Array;
  decKey!: Uint8Array;
  w = 0;
  r = 0;
  fin = false;
  e = C.generateX25519();
  s = C.generateX25519();
  private dec = new FrameDecoder();
  private introSkipped = false;
  private intro = new Uint8Array(0);
  clientPayload?: Uint8Array;
  gotNode?: unknown;

  constructor(private t: Transport) {
    const name = Uint8Array.from("Noise_XX_25519_AESGCM_SHA256", (c) => c.charCodeAt(0));
    this.hash = C.sha256(name);
    this.salt = this.hash;
    this.encKey = this.hash;
    this.decKey = this.hash;
    t.onData((d) => this.onData(d));
  }
  private mixHash(d: Uint8Array) {
    this.hash = C.sha256(cat(this.hash, d));
  }
  private mixKey(m: Uint8Array) {
    const o = C.hkdf(m, 64, { salt: this.salt });
    this.salt = o.subarray(0, 32);
    this.encKey = o.subarray(32, 64);
    this.decKey = o.subarray(32, 64);
    this.w = 0;
    this.r = 0;
  }
  private enc(p: Uint8Array) {
    const c = C.aesGcmEncrypt(this.encKey, iv(this.w), p, this.hash);
    this.w++;
    if (!this.fin) this.mixHash(c);
    return c;
  }
  private decr(c: Uint8Array) {
    const p = C.aesGcmDecrypt(this.decKey, iv(this.r), c, this.hash);
    this.r++;
    if (!this.fin) this.mixHash(c);
    return p;
  }

  private onData(d: Uint8Array) {
    if (!this.introSkipped) {
      this.intro = cat(this.intro, d);
      if (this.intro.length < 4) return;
      // 4 bytes de intro header (WA + major + minor), então frames.
      d = this.intro.subarray(4);
      this.introSkipped = true;
    }
    for (const frame of this.dec.push(d)) this.onFrame(frame);
  }

  private onFrame(frame: Uint8Array) {
    if (!this.fin) {
      const msg = decodeHandshake(frame);
      if (msg.clientHello?.ephemeral) {
        const clientEph = msg.clientHello.ephemeral;
        this.mixHash(clientEph);
        this.mixHash(this.e.publicKey);
        this.mixKey(C.x25519(this.e.privateKey, clientEph));
        const staticCipher = this.enc(this.s.publicKey);
        this.mixKey(C.x25519(this.s.privateKey, clientEph));
        const payloadCipher = this.enc(Uint8Array.from("<cert>", (c) => c.charCodeAt(0)));
        this.t.send(
          encodeFrame(
            encodeHandshake({
              serverHello: {
                ephemeral: this.e.publicKey,
                static: staticCipher,
                payload: payloadCipher,
              },
            }),
          ),
        );
      } else if (msg.clientFinish) {
        const clientStatic = this.decr(msg.clientFinish.static!);
        this.mixKey(C.x25519(this.e.privateKey, clientStatic));
        this.clientPayload = this.decr(msg.clientFinish.payload!);
        const o = C.hkdf(new Uint8Array(0), 64, { salt: this.salt });
        this.decKey = o.subarray(0, 32);
        this.encKey = o.subarray(32, 64);
        this.hash = new Uint8Array(0);
        this.w = 0;
        this.r = 0;
        this.fin = true;
      }
    } else {
      // frame de transporte: decifra + decodifica WABinary
      const plain = C.aesGcmDecrypt(this.decKey, iv(this.r), frame);
      this.r++;
      this.gotNode = decodeBinaryNode(plain);
      // responde com um node
      const reply = encodeBinaryNode(node("iq", { type: "result", id: "1" }));
      const ct = C.aesGcmEncrypt(this.encKey, iv(this.w), reply);
      this.w++;
      this.t.send(encodeFrame(ct));
    }
  }
}

// ---- roda ------------------------------------------------------------

async function run() {
  const [clientT, serverT] = mockTransportPair();
  const server = new Server(serverT);

  const staticKey = C.generateX25519();
  const CLIENT_PAYLOAD = Uint8Array.from("<client-payload>", (c) => c.charCodeAt(0));

  const sock = new NoiseSocket({
    transport: clientT,
    crypto: C,
    staticKey,
    clientPayload: CLIENT_PAYLOAD,
  });

  let recv: unknown;
  sock.events.on("node.recv", (n) => {
    recv = n;
  });

  await sock.connect();
  ok("connect() resolve", sock.status === "open");
  ok(
    "servidor recuperou o ClientPayload",
    !!server.clientPayload &&
      Array.from(server.clientPayload).join(",") === Array.from(CLIENT_PAYLOAD).join(","),
  );

  sock.sendNode(node("iq", { type: "get", xmlns: "w:p", to: "s.whatsapp.net" }, [node("ping")]));
  await new Promise((r) => setTimeout(r, 20));

  ok("servidor decodificou o node do cliente", (server.gotNode as any)?.tag === "iq");
  ok(
    "servidor viu o filho <ping>",
    Array.isArray((server.gotNode as any)?.content) &&
      (server.gotNode as any).content[0].tag === "ping",
  );
  ok("cliente recebeu a resposta", (recv as any)?.tag === "iq" && (recv as any)?.attrs.type === "result");

  sock.close();
  ok("fecha limpo", sock.status === "closed");
}

await run();

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/socket [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
