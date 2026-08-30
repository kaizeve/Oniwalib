// Adapter para quando a lib roda compilada pelo RTS.
//
// O RTS expõe, em `node:crypto`: `createHash`, `createHmac`, `randomBytes`,
// `hkdfSync`, `createCipheriv`/`createDecipheriv` (AES-128/256 GCM e CBC), e o
// trio X25519 em forma de bytes crus — `generateX25519KeyPair`,
// `x25519PublicKey`, `x25519DiffieHellman`. NÃO tem `generateKeyPairSync`,
// `KeyObject`, `diffieHellman`, nem assinatura.
//
// Então este adapter é o `node-adapter` menos o dance de KeyObject: cifras e
// hashes vêm de `node:crypto` (que o RTS implementa), e as curvas vêm do trio
// cru. `sign`/`verify` ainda não existem no RTS (o WhatsApp usa XEdDSA, não
// Ed25519 puro) — lançam com mensagem clara.

import nodeCrypto from "node:crypto";
import type { Crypto, KeyPair } from "./types";

const u8 = (b: unknown): Uint8Array => Uint8Array.from(b as ArrayLike<number>);

// As três funções cruas que o RTS adiciona ao namespace.
type RawCurve = {
  generateX25519KeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array };
  x25519PublicKey(priv: Uint8Array): Uint8Array;
  x25519DiffieHellman(priv: Uint8Array, pub: Uint8Array): Uint8Array;
};
const raw = nodeCrypto as unknown as RawCurve;

export const rtsAdapter: Crypto = {
  randomBytes(n) {
    return u8(nodeCrypto.randomBytes(n));
  },

  sha256(data) {
    return u8(nodeCrypto.createHash("sha256").update(data).digest());
  },

  hmacSha256(key, data) {
    return u8(nodeCrypto.createHmac("sha256", key).update(data).digest());
  },

  hkdf(ikm, length, opts) {
    const salt = opts.salt ?? new Uint8Array(32);
    const info = opts.info ?? new Uint8Array(0);
    const prk = u8(nodeCrypto.createHmac("sha256", salt).update(ikm).digest());
    const out: number[] = [];
    let t = new Uint8Array(0);
    let counter = 1;
    while (out.length < length) {
      const h = nodeCrypto.createHmac("sha256", prk);
      h.update(t);
      h.update(info);
      h.update(Uint8Array.from([counter & 0xff]));
      t = u8(h.digest());
      for (const b of t) out.push(b);
      counter++;
    }
    return Uint8Array.from(out.slice(0, length));
  },

  aesGcmEncrypt(key, iv, plaintext, aad) {
    const c = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
    if (aad) c.setAAD(aad);
    // Modelo do RTS: update acumula, final produz tudo. `concat` funciona nos dois.
    const body = concat(u8(c.update(plaintext)), u8(c.final()));
    return concat(body, u8(c.getAuthTag()));
  },

  aesGcmDecrypt(key, iv, ciphertext, aad) {
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const body = ciphertext.subarray(0, ciphertext.length - 16);
    const d = nodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    if (aad) d.setAAD(aad);
    d.update(body);
    return concat(u8(d.update(new Uint8Array(0))), u8(d.final()));
  },

  aesCbcEncrypt(key, iv, plaintext) {
    const c = nodeCrypto.createCipheriv("aes-256-cbc", key, iv);
    return concat(u8(c.update(plaintext)), u8(c.final()));
  },

  aesCbcDecrypt(key, iv, ciphertext) {
    const d = nodeCrypto.createDecipheriv("aes-256-cbc", key, iv);
    return concat(u8(d.update(ciphertext)), u8(d.final()));
  },

  generateX25519(): KeyPair {
    const kp = raw.generateX25519KeyPair();
    return { publicKey: u8(kp.publicKey), privateKey: u8(kp.privateKey) };
  },

  x25519(privateKey, publicKey) {
    return u8(raw.x25519DiffieHellman(privateKey, publicKey));
  },

  // A chave de identidade do Signal É uma chave X25519 (usada tanto pra DH
  // quanto pra assinar via XEdDSA). Então o par certo dá pra gerar; só a
  // OPERAÇÃO de assinar/verificar falta no RTS (XEdDSA — Fase 2).
  generateSigningKey(): KeyPair {
    const kp = raw.generateX25519KeyPair();
    return { publicKey: u8(kp.publicKey), privateKey: u8(kp.privateKey) };
  },
  sign() {
    throw new Error("oniwalib/rts: sign() indisponível no RTS (XEdDSA pendente — Fase 2)");
  },
  verify() {
    throw new Error("oniwalib/rts: verify() indisponível no RTS (XEdDSA pendente — Fase 2)");
  },
};

// Deriva a pública de uma privada X25519 — útil pra testes que só têm a privada.
export function rtsX25519PublicKey(priv: Uint8Array): Uint8Array {
  return u8(raw.x25519PublicKey(priv));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
