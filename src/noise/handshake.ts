// Noise_XX_25519_AESGCM_SHA256 — o handshake que estabelece o canal cifrado
// com o servidor do WhatsApp, ANTES de qualquer coisa de Signal.
//
// Padrão XX, lado cliente (é o que a Baileys implementa):
//
//   -> e
//   <- e, ee, s, es          (ServerHello: efêmera + estática cifrada + payload)
//   -> s, se                 (ClientFinish: estática do cliente + ClientPayload)
//   split                    (deriva as chaves de transporte)
//
// Toda a cripto entra pela interface `Crypto` — este arquivo é puro e roda
// idêntico em qualquer runtime. É testável de ponta a ponta simulando o servidor
// com o mesmo adapter (ver `handshake.test.ts`).

import type { Crypto, KeyPair } from "../crypto/types";

// O nome do protocolo TEM 4 nulls de padding — completa 32 bytes, e o Noise
// (e o WhatsApp) usa esses 32 bytes CRUS como hash inicial, não `sha256(nome)`.
// Sem o padding, `"Noise_XX_25519_AESGCM_SHA256"` tem 28 chars e cairia no
// `sha256`, divergindo do servidor no primeiro passo.
const PROTOCOL = "Noise_XX_25519_AESGCM_SHA256\0\0\0\0";
const ASCII = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function iv(counter: number): Uint8Array {
  const b = new Uint8Array(12);
  // 4 bytes zero + contador big-endian de 8 bytes (só os 32 bits baixos usados).
  b[8] = (counter >>> 24) & 0xff;
  b[9] = (counter >>> 16) & 0xff;
  b[10] = (counter >>> 8) & 0xff;
  b[11] = counter & 0xff;
  return b;
}

export interface HandshakeResult {
  /** Chave para cifrar o que o cliente ENVIA no transporte. */
  encKey: Uint8Array;
  /** Chave para decifrar o que o cliente RECEBE. */
  decKey: Uint8Array;
}

export class NoiseHandshake {
  private hash: Uint8Array;
  private salt: Uint8Array;
  private encKey: Uint8Array;
  private decKey: Uint8Array;
  // DURANTE o handshake o Noise usa UM contador só (o nonce `n`), compartilhado
  // por encrypt e decrypt, resetado apenas no `mixKey`. Só no transporte
  // (pós-`finish`) é que read/write têm contadores separados.
  private counter = 0;
  private writeCounter = 0;
  private readCounter = 0;
  private finished = false;

  constructor(
    private readonly c: Crypto,
    /** Bytes misturados no hash logo após a inicialização — o WhatsApp usa o
     *  header `WA 6 3` aqui (ver Baileys `authenticate(NOISE_WA_HEADER)`). */
    prologue?: Uint8Array,
  ) {
    const name = ASCII(PROTOCOL);
    this.hash = name.length === 32 ? name : c.sha256(name);
    this.salt = this.hash;
    this.encKey = this.hash;
    this.decKey = this.hash;
    if (prologue && prologue.length) {
      this.mixHash(prologue);
    }
  }

  authenticate(data: Uint8Array): void {
    this.mixHash(data);
  }

  private mixHash(data: Uint8Array): void {
    this.hash = this.c.sha256(concat(this.hash, data));
  }

  private mixKey(material: Uint8Array): void {
    const out = this.c.hkdf(material, 64, { salt: this.salt });
    this.salt = out.subarray(0, 32);
    this.encKey = out.subarray(32, 64);
    this.decKey = out.subarray(32, 64);
    this.counter = 0; // InitializeKey → nonce volta a 0
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    const ct = this.c.aesGcmEncrypt(this.encKey, iv(this.counter), plaintext, this.hash);
    this.counter += 1;
    if (!this.finished) {
      this.mixHash(ct);
    }
    return ct;
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    const pt = this.c.aesGcmDecrypt(this.decKey, iv(this.counter), ciphertext, this.hash);
    this.counter += 1;
    if (!this.finished) {
      this.mixHash(ciphertext);
    }
    return pt;
  }

  /** Passo 1: gera a efêmera e produz o ClientHello (a chave pública crua). */
  clientHello(ephemeral: KeyPair): Uint8Array {
    this.mixHash(ephemeral.publicKey);
    return ephemeral.publicKey;
  }

  /**
   * Passo 2: processa o ServerHello. Devolve a chave estática do servidor e o
   * payload (certificado Noise) decifrado, para quem chama validar a cadeia.
   */
  readServerHello(
    ephemeral: KeyPair,
    serverEphemeral: Uint8Array,
    serverStaticCipher: Uint8Array,
    payloadCipher: Uint8Array,
  ): { serverStatic: Uint8Array; payload: Uint8Array } {
    this.mixHash(serverEphemeral);
    this.mixKey(this.c.x25519(ephemeral.privateKey, serverEphemeral));
    const serverStatic = this.decrypt(serverStaticCipher);
    this.mixKey(this.c.x25519(ephemeral.privateKey, serverStatic));
    const payload = this.decrypt(payloadCipher);
    return { serverStatic, payload };
  }

  /**
   * Passo 3: produz o ClientFinish — a estática do cliente cifrada e o
   * ClientPayload cifrado.
   */
  clientFinish(
    staticKey: KeyPair,
    serverEphemeral: Uint8Array,
    clientPayload: Uint8Array,
  ): { staticCipher: Uint8Array; payloadCipher: Uint8Array } {
    const staticCipher = this.encrypt(staticKey.publicKey);
    this.mixKey(this.c.x25519(staticKey.privateKey, serverEphemeral));
    const payloadCipher = this.encrypt(clientPayload);
    return { staticCipher, payloadCipher };
  }

  /** split: deriva as chaves de transporte e fecha o handshake. */
  finish(): HandshakeResult {
    const out = this.c.hkdf(new Uint8Array(0), 64, { salt: this.salt });
    this.encKey = out.subarray(0, 32);
    this.decKey = out.subarray(32, 64);
    this.hash = new Uint8Array(0);
    this.readCounter = 0;
    this.writeCounter = 0;
    this.finished = true;
    return { encKey: this.encKey, decKey: this.decKey };
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** Cifra uma mensagem de transporte (pós-handshake). */
  transportEncrypt(plaintext: Uint8Array): Uint8Array {
    if (!this.finished) throw new Error("handshake não terminou");
    const ct = this.c.aesGcmEncrypt(this.encKey, iv(this.writeCounter), plaintext);
    this.writeCounter += 1;
    return ct;
  }

  transportDecrypt(ciphertext: Uint8Array): Uint8Array {
    if (!this.finished) throw new Error("handshake não terminou");
    const pt = this.c.aesGcmDecrypt(this.decKey, iv(this.readCounter), ciphertext);
    this.readCounter += 1;
    return pt;
  }
}
