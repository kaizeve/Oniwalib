// Curve25519 — a fina camada sobre `Crypto` que a libsignal chama de `curve`.
//
// Convenção DJB: chave pública no fio tem 33 bytes, `0x05 || pub(32)`. No ECDH
// e na assinatura a gente usa os 32 crus. `prefixKey`/`stripKey` fazem a ponte.
// A identidade Signal É uma chave X25519 (serve para DH E para XEdDSA); as
// chaves de ratchet/base são X25519 puras e nunca são assinadas.
//
// Espelha `libsignal/src/curve.js` (WhiskeySockets, v6) — estudada, não
// importada: aqui toda a cripto passa por `Crypto`, então roda no RTS.

import type { Crypto } from "../crypto/types";

export const KEY_TYPE = 0x05;

export interface SignalKeyPair {
  /** 33 bytes — `0x05 || pub`. */
  pubKey: Uint8Array;
  /** 32 bytes. */
  privKey: Uint8Array;
}

export function prefixKey(pub: Uint8Array): Uint8Array {
  if (pub.length === 33) return pub;
  if (pub.length !== 32) throw new Error(`curve: pública com ${pub.length} bytes (esperava 32/33)`);
  const out = new Uint8Array(33);
  out[0] = KEY_TYPE;
  out.set(pub, 1);
  return out;
}

export function stripKey(pub: Uint8Array): Uint8Array {
  if (pub.length === 33) return pub.subarray(1);
  if (pub.length !== 32) throw new Error(`curve: pública com ${pub.length} bytes (esperava 32/33)`);
  return pub;
}

export interface Curve {
  generateKeyPair(): SignalKeyPair;
  /** ECDH. `pub` 32 ou 33 bytes, `priv` 32. → segredo de 32 bytes. */
  calculateAgreement(pub: Uint8Array, priv: Uint8Array): Uint8Array;
  /** XEdDSA. Assinatura de 64 bytes sobre `message` com a identidade. */
  calculateSignature(priv: Uint8Array, message: Uint8Array): Uint8Array;
  verifySignature(pub: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean;
}

export function makeCurve(c: Crypto): Curve {
  return {
    generateKeyPair() {
      const kp = c.generateX25519();
      return { pubKey: prefixKey(kp.publicKey), privKey: kp.privateKey };
    },
    calculateAgreement(pub, priv) {
      return c.x25519(priv, stripKey(pub));
    },
    calculateSignature(priv, message) {
      return c.sign(priv, message);
    },
    verifySignature(pub, message, sig) {
      try {
        return c.verify(stripKey(pub), message, sig);
      } catch {
        return false;
      }
    },
  };
}
