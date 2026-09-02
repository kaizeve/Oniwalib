// Adapter de referência sobre `node:crypto`. Roda hoje em bun e node; no RTS
// cobre randomBytes / sha256 / hmac / hkdf, e lança nos RTS-GAP até a Fase 0.
//
// Este arquivo é o ÚNICO da lib que importa algo de plataforma. Trocar por
// `rts-adapter.ts` não toca em mais nada.

import nodeCrypto from "node:crypto";
import * as curve25519 from "curve25519-js";
import type { Crypto, KeyPair } from "./types";

const u8 = (b: Uint8Array | Buffer): Uint8Array => Uint8Array.from(b);

function jwkRaw(field: string, keyObject: nodeCrypto.KeyObject): Uint8Array {
  const jwk = keyObject.export({ format: "jwk" }) as Record<string, string>;
  return u8(Buffer.from(jwk[field]!, "base64url"));
}

function x25519Objects(priv: Uint8Array, pub?: Uint8Array) {
  const d = Buffer.from(priv).toString("base64url");
  const privateKey = nodeCrypto.createPrivateKey({
    key: { kty: "OKP", crv: "X25519", d, x: d } as nodeCrypto.JsonWebKey,
    format: "jwk",
  });
  const publicKey = pub
    ? nodeCrypto.createPublicKey({
        key: {
          kty: "OKP",
          crv: "X25519",
          x: Buffer.from(pub).toString("base64url"),
        } as nodeCrypto.JsonWebKey,
        format: "jwk",
      })
    : nodeCrypto.createPublicKey(privateKey);
  return { privateKey, publicKey };
}

export const nodeAdapter: Crypto = {
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
    // HKDF-Extract + Expand à mão: `crypto.hkdfSync` existe nos dois, mas a
    // ordem dos args já mordeu o RTS uma vez — fazer explícito é mais seguro.
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
    const body = Buffer.concat([c.update(plaintext), c.final()]);
    return u8(Buffer.concat([body, c.getAuthTag()]));
  },

  aesGcmDecrypt(key, iv, ciphertext, aad) {
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const body = ciphertext.subarray(0, ciphertext.length - 16);
    const d = nodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    if (aad) d.setAAD(aad);
    return u8(Buffer.concat([d.update(body), d.final()]));
  },

  aesCbcEncrypt(key, iv, plaintext) {
    const c = nodeCrypto.createCipheriv("aes-256-cbc", key, iv);
    return u8(Buffer.concat([c.update(plaintext), c.final()]));
  },

  aesCbcDecrypt(key, iv, ciphertext) {
    const d = nodeCrypto.createDecipheriv("aes-256-cbc", key, iv);
    return u8(Buffer.concat([d.update(ciphertext), d.final()]));
  },

  generateX25519(): KeyPair {
    const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("x25519");
    return {
      publicKey: jwkRaw("x", publicKey),
      privateKey: jwkRaw("d", privateKey),
    };
  },

  x25519(privateKey, publicKey) {
    const objs = x25519Objects(privateKey, publicKey);
    return u8(nodeCrypto.diffieHellman(objs));
  },

  // Assinatura XEdDSA sobre Curve25519 — o que o WhatsApp/Signal usam de fato
  // (a chave de identidade é X25519, usada pra DH E pra assinar). `curve25519-js`
  // é a implementação ref10 pura, mesma que o libsignal.
  generateSigningKey(): KeyPair {
    const kp = curve25519.generateKeyPair(u8(nodeCrypto.randomBytes(32)));
    return { publicKey: u8(kp.public), privateKey: u8(kp.private) };
  },

  sign(privateKey, message) {
    return u8(curve25519.sign(privateKey, message, u8(nodeCrypto.randomBytes(64))));
  },

  verify(publicKey, message, signature) {
    return curve25519.verify(publicKey, message, signature);
  },
};
