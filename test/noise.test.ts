// Handshake Noise XX de ponta a ponta + enquadramento. O "servidor" é simulado
// AQUI com as mesmas primitivas, com o transcript escrito à mão (independente da
// classe `NoiseHandshake`) — então o teste valida a lógica, não ela contra si
// mesma.

import { nodeAdapter as C } from "../src/crypto/node-adapter";
import { NoiseHandshake } from "../src/noise/handshake";
import { FrameDecoder, encodeFrame, introHeader } from "../src/noise/frame";

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
const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
const eqBytes = (n: string, a: Uint8Array, b: Uint8Array) => ok(n, hex(a) === hex(b), `${hex(a)} != ${hex(b)}`);

// ---- servidor XX inline (responder) --------------------------------------

function sha(x: Uint8Array) {
  return C.sha256(x);
}
function cat(...ps: Uint8Array[]) {
  let n = 0;
  for (const p of ps) n += p.length;
  const o = new Uint8Array(n);
  let k = 0;
  for (const p of ps) {
    o.set(p, k);
    k += p.length;
  }
  return o;
}
function iv(ctr: number) {
  const b = new Uint8Array(12);
  b[11] = ctr & 0xff;
  b[10] = (ctr >>> 8) & 0xff;
  b[9] = (ctr >>> 16) & 0xff;
  b[8] = (ctr >>> 24) & 0xff;
  return b;
}

class Server {
  hash: Uint8Array;
  salt: Uint8Array;
  encKey: Uint8Array;
  decKey: Uint8Array;
  w = 0;
  r = 0;
  fin = false;
  e = C.generateX25519();
  s = C.generateX25519();

  constructor() {
    const name = Uint8Array.from("Noise_XX_25519_AESGCM_SHA256", (c) => c.charCodeAt(0));
    this.hash = name.length === 32 ? name : sha(name);
    this.salt = this.hash;
    this.encKey = this.hash;
    this.decKey = this.hash;
  }
  mixHash(d: Uint8Array) {
    this.hash = sha(cat(this.hash, d));
  }
  mixKey(m: Uint8Array) {
    const o = C.hkdf(m, 64, { salt: this.salt });
    this.salt = o.subarray(0, 32);
    this.encKey = o.subarray(32, 64);
    this.decKey = o.subarray(32, 64);
    this.w = 0;
    this.r = 0;
  }
  enc(p: Uint8Array) {
    const ct = C.aesGcmEncrypt(this.encKey, iv(this.w), p, this.hash);
    this.w++;
    if (!this.fin) this.mixHash(ct);
    return ct;
  }
  dec(c: Uint8Array) {
    const p = C.aesGcmDecrypt(this.decKey, iv(this.r), c, this.hash);
    this.r++;
    if (!this.fin) this.mixHash(c);
    return p;
  }
  // <- e, ee, s, es
  hello(clientEphemeral: Uint8Array, cert: Uint8Array) {
    this.mixHash(clientEphemeral);
    this.mixHash(this.e.publicKey);
    this.mixKey(C.x25519(this.e.privateKey, clientEphemeral));
    const staticCipher = this.enc(this.s.publicKey);
    this.mixKey(C.x25519(this.s.privateKey, clientEphemeral));
    const payloadCipher = this.enc(cert);
    return { serverEphemeral: this.e.publicKey, staticCipher, payloadCipher };
  }
  // -> s, se
  finishClient(staticCipher: Uint8Array, payloadCipher: Uint8Array) {
    const clientStatic = this.dec(staticCipher);
    this.mixKey(C.x25519(this.e.privateKey, clientStatic));
    const payload = this.dec(payloadCipher);
    return payload;
  }
  split() {
    const o = C.hkdf(new Uint8Array(0), 64, { salt: this.salt });
    this.decKey = o.subarray(0, 32); // trocado em relação ao iniciador
    this.encKey = o.subarray(32, 64);
    this.hash = new Uint8Array(0);
    this.w = 0;
    this.r = 0;
    this.fin = true;
  }
  tEnc(p: Uint8Array) {
    const c = C.aesGcmEncrypt(this.encKey, iv(this.w), p);
    this.w++;
    return c;
  }
  tDec(c: Uint8Array) {
    const p = C.aesGcmDecrypt(this.decKey, iv(this.r), c);
    this.r++;
    return p;
  }
}

// ---- roda o handshake ---------------------------------------------------

const client = new NoiseHandshake(C);
const server = new Server();
const clientEph = C.generateX25519();
const clientStatic = C.generateX25519();
const CERT = Uint8Array.from("<noise-cert-placeholder>", (c) => c.charCodeAt(0));
const CLIENT_PAYLOAD = Uint8Array.from("<client-payload-protobuf>", (c) => c.charCodeAt(0));

const hello = client.clientHello(clientEph);
const sh = server.hello(hello, CERT);
const read = client.readServerHello(clientEph, sh.serverEphemeral, sh.staticCipher, sh.payloadCipher);
eqBytes("cliente recupera a estática do servidor", read.serverStatic, server.s.publicKey);
eqBytes("cliente recupera o certificado", read.payload, CERT);

const cf = client.clientFinish(clientStatic, sh.serverEphemeral, CLIENT_PAYLOAD);
const serverPayload = server.finishClient(cf.staticCipher, cf.payloadCipher);
eqBytes("servidor recupera o ClientPayload", serverPayload, CLIENT_PAYLOAD);

const ck = client.finish();
server.split();
eqBytes("client.encKey == server.decKey", ck.encKey, server.decKey);
eqBytes("client.decKey == server.encKey", ck.decKey, server.encKey);

// transporte nos dois sentidos
const m1 = Uint8Array.from("ping do cliente", (c) => c.charCodeAt(0));
eqBytes("servidor decifra msg do cliente", server.tDec(client.transportEncrypt(m1)), m1);
const m2 = Uint8Array.from("pong do servidor", (c) => c.charCodeAt(0));
eqBytes("cliente decifra msg do servidor", client.transportDecrypt(server.tEnc(m2)), m2);

// ---- enquadramento ----------------------------------------------------

{
  const p1 = Uint8Array.from([1, 2, 3]);
  const p2 = C.randomBytes(500);
  const stream = cat(encodeFrame(p1), encodeFrame(p2));
  const d = new FrameDecoder();
  // entrega o stream em pedaços de 7 bytes, como o TCP faria
  let frames: Uint8Array[] = [];
  for (let i = 0; i < stream.length; i += 7) {
    frames = frames.concat(d.push(stream.subarray(i, i + 7)));
  }
  ok("2 frames remontados de chunks", frames.length === 2);
  eqBytes("frame 1 íntegro", frames[0], p1);
  eqBytes("frame 2 íntegro", frames[1], p2);
  ok("nada pendente", d.pending === 0);
}

{
  const h = introHeader({ version: [6, 0] });
  ok("intro header WA", h[0] === 0x57 && h[1] === 0x41 && h[2] === 6 && h[3] === 0);
}

// ---- resumo ---------------------------------------------------------

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/noise [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
