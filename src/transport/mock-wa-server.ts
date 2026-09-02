// MockWaServer — o lado servidor do handshake Noise XX + um relay de mensagens,
// em memória. Aidamente de teste/dev, como `MockTransport`. NÃO fala com o
// WhatsApp: existe para exercitar `NoiseSocket` e bots ponta a ponta.
//
// Depois do handshake, `pushMessage({from,id,text})` cifra e envia um node
// `<message from id><body>text</body></message>` (convenção do mock — no real
// isto vira `<enc>` + libsignal + protobuf). Os nodes que o cliente devolve
// saem no callback de `onReply`.

import type { Crypto } from "../crypto/types";
import { decodeBinaryNode, encodeBinaryNode } from "../frame/index";
import { node, type BinaryNode } from "../frame/node";
import { FrameDecoder, encodeFrame } from "../noise/frame";
import { decodeHandshake, encodeHandshake } from "../noise/wire";
import type { Transport } from "./types";

function cat(...ps: Uint8Array[]): Uint8Array {
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
function iv(ctr: number): Uint8Array {
  const b = new Uint8Array(12);
  b[11] = ctr & 0xff;
  b[10] = (ctr >>> 8) & 0xff;
  b[9] = (ctr >>> 16) & 0xff;
  b[8] = (ctr >>> 24) & 0xff;
  return b;
}

export interface MockMessage {
  from: string;
  id: string;
  text: string;
}

export class MockWaServer {
  private hash: Uint8Array;
  private salt: Uint8Array;
  private encKey: Uint8Array;
  private decKey: Uint8Array;
  private ctr = 0; // contador único do handshake (Noise); w/r só no transporte
  private w = 0;
  private r = 0;
  private fin = false;
  private e: { publicKey: Uint8Array; privateKey: Uint8Array };
  private s: { publicKey: Uint8Array; privateKey: Uint8Array };
  private dec = new FrameDecoder();
  private introSkipped = false;
  private intro = new Uint8Array(0);
  private replyHandlers = new Set<(n: BinaryNode) => void>();
  private readyHandlers = new Set<() => void>();

  clientPayload?: Uint8Array;

  constructor(
    private readonly transport: Transport,
    private readonly c: Crypto,
  ) {
    this.e = c.generateX25519();
    this.s = c.generateX25519();
    const name = Uint8Array.from("Noise_XX_25519_AESGCM_SHA256\0\0\0\0", (ch) => ch.charCodeAt(0));
    this.hash = name; // 32 bytes crus (ver handshake.ts)
    this.salt = this.hash;
    this.encKey = this.hash;
    this.decKey = this.hash;
    transport.onData((d) => this.onData(d));
  }

  onReply(handler: (n: BinaryNode) => void): () => void {
    this.replyHandlers.add(handler);
    return () => this.replyHandlers.delete(handler);
  }

  /** Dispara quando o handshake fecha (já dá pra `pushNode`). */
  onReady(handler: () => void): () => void {
    this.readyHandlers.add(handler);
    if (this.fin) handler();
    return () => this.readyHandlers.delete(handler);
  }

  /** Cifra, enquadra e envia um binary node arbitrário ao cliente. */
  pushNode(n: BinaryNode): void {
    if (!this.fin) throw new Error("handshake não terminou");
    const ct = this.c.aesGcmEncrypt(this.encKey, iv(this.w), encodeBinaryNode(n));
    this.w++;
    this.transport.send(encodeFrame(ct));
  }

  /** Envia uma mensagem de texto ao cliente (só depois do handshake). */
  pushMessage(m: MockMessage): void {
    this.pushNode(node("message", { from: m.from, id: m.id }, [node("body", {}, m.text)]));
  }

  private mixHash(d: Uint8Array): void {
    this.hash = this.c.sha256(cat(this.hash, d));
  }
  private mixKey(m: Uint8Array): void {
    const o = this.c.hkdf(m, 64, { salt: this.salt });
    this.salt = o.subarray(0, 32);
    this.encKey = o.subarray(32, 64);
    this.decKey = o.subarray(32, 64);
    this.ctr = 0;
  }
  private enc(p: Uint8Array): Uint8Array {
    const ct = this.c.aesGcmEncrypt(this.encKey, iv(this.ctr), p, this.hash);
    this.ctr++;
    if (!this.fin) this.mixHash(ct);
    return ct;
  }
  private decr(ct: Uint8Array): Uint8Array {
    const p = this.c.aesGcmDecrypt(this.decKey, iv(this.ctr), ct, this.hash);
    this.ctr++;
    if (!this.fin) this.mixHash(ct);
    return p;
  }

  private onData(d: Uint8Array): void {
    if (!this.introSkipped) {
      this.intro = cat(this.intro, d);
      if (this.intro.length < 4) return;
      // O header entra no transcript do Noise (prologue), igual ao cliente.
      this.mixHash(this.intro.subarray(0, 4));
      d = this.intro.subarray(4);
      this.introSkipped = true;
    }
    for (const frame of this.dec.push(d)) this.onFrame(frame);
  }

  private onFrame(frame: Uint8Array): void {
    if (this.fin) {
      const plain = this.c.aesGcmDecrypt(this.decKey, iv(this.r), frame);
      this.r++;
      const n = decodeBinaryNode(plain);
      for (const h of this.replyHandlers) h(n);
      return;
    }
    const msg = decodeHandshake(frame);
    if (msg.clientHello?.ephemeral) {
      const clientEph = msg.clientHello.ephemeral;
      this.mixHash(clientEph);
      this.mixHash(this.e.publicKey);
      this.mixKey(this.c.x25519(this.e.privateKey, clientEph));
      const staticCipher = this.enc(this.s.publicKey);
      this.mixKey(this.c.x25519(this.s.privateKey, clientEph));
      const payloadCipher = this.enc(Uint8Array.from("<mock-cert>", (ch) => ch.charCodeAt(0)));
      this.transport.send(
        encodeFrame(
          encodeHandshake({
            serverHello: { ephemeral: this.e.publicKey, static: staticCipher, payload: payloadCipher },
          }),
        ),
      );
    } else if (msg.clientFinish) {
      const clientStatic = this.decr(msg.clientFinish.static!);
      this.mixKey(this.c.x25519(this.e.privateKey, clientStatic));
      this.clientPayload = this.decr(msg.clientFinish.payload!);
      const o = this.c.hkdf(new Uint8Array(0), 64, { salt: this.salt });
      this.decKey = o.subarray(0, 32);
      this.encKey = o.subarray(32, 64);
      this.hash = new Uint8Array(0);
      this.w = 0;
      this.r = 0;
      this.fin = true;
      for (const h of this.readyHandlers) h();
    }
  }
}
