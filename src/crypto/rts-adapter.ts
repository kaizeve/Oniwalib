// Adapter para quando a lib roda compilada pelo RTS.
//
// O RTS expõe, em `node:crypto`: `createHash`, `createHmac`, `randomBytes`,
// `hkdfSync`, `createCipheriv`/`createDecipheriv` (AES-128/256 GCM e CBC), o
// trio X25519 em forma de bytes crus — `generateX25519KeyPair`,
// `x25519PublicKey`, `x25519DiffieHellman` — e o par XEdDSA `xeddsaSign` /
// `xeddsaVerify` (UrubuCode/rts#2609). NÃO tem `generateKeyPairSync`,
// `KeyObject` nem `diffieHellman`.
//
// Então este adapter é o `node-adapter` menos o dance de KeyObject: cifras e
// hashes vêm de `node:crypto` (que o RTS implementa), curvas e assinatura vêm
// das primitivas cruas. Nomes fora do padrão Node de propósito — chaves são
// bytes crus, sem o DER/PEM/PKCS8 que um KeyObject exigiria.

import nodeCrypto from "node:crypto";
import type { Crypto, KeyPair } from "./types";

const u8 = (b: unknown): Uint8Array => Uint8Array.from(b as ArrayLike<number>);

// As primitivas de curva/assinatura que o RTS adiciona ao namespace.
type RawCurve = {
  generateX25519KeyPair(): { privateKey: Uint8Array; publicKey: Uint8Array };
  x25519PublicKey(priv: Uint8Array): Uint8Array;
  x25519DiffieHellman(priv: Uint8Array, pub: Uint8Array): Uint8Array;
  xeddsaSign(priv: Uint8Array, message: Uint8Array): Uint8Array;
  xeddsaVerify(pub: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;
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

  md5(data) {
    return u8(nodeCrypto.createHash("md5").update(data).digest());
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
    // Mesmo `concat` model-agnóstico do encrypt: no RTS `update` devolve vazio e
    // `final` devolve tudo; no node/bun é o contrário. Descartar o retorno de
    // `update` (como estava) perdia o plaintext inteiro fora do RTS.
    return concat(u8(d.update(body)), u8(d.final()));
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
  // quanto pra assinar via XEdDSA), então o par certo é o próprio par X25519.
  generateSigningKey(): KeyPair {
    const kp = raw.generateX25519KeyPair();
    return { publicKey: u8(kp.publicKey), privateKey: u8(kp.privateKey) };
  },
  // XEdDSA cru — assina/verifica exatamente os bytes recebidos (o prefixo de
  // tipo `0x05` fica com quem chama, igual ao `node-adapter`). O `Z` aleatório
  // é interno ao RTS e não é exposto — assinar a mesma mensagem duas vezes dá
  // assinaturas diferentes, ambas válidas.
  sign(privateKey, message) {
    if (typeof raw.xeddsaSign !== "function") {
      throw new Error(
        "oniwalib/rts: node:crypto.xeddsaSign ausente — binário do RTS anterior a UrubuCode/rts#2609; rebuild com XEdDSA",
      );
    }
    return u8(raw.xeddsaSign(privateKey, message));
  },
  verify(publicKey, message, signature) {
    if (typeof raw.xeddsaVerify !== "function") {
      throw new Error(
        "oniwalib/rts: node:crypto.xeddsaVerify ausente — binário do RTS anterior a UrubuCode/rts#2609; rebuild com XEdDSA",
      );
    }
    return raw.xeddsaVerify(publicKey, message, signature);
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
