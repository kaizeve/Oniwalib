// `deriveSecrets` — o KDF que a libsignal usa em todo lugar (X3DH, ratchet DH,
// message keys). É HKDF-SHA256 (RFC 5869) devolvendo os primeiros `chunks`
// blocos de 32 bytes. O `salt` é SEMPRE 32 bytes (zeros nas message keys, a
// rootKey no ratchet).
//
// libsignal `crypto.deriveSecrets(input, salt, info, chunks=3)`.

import type { Crypto } from "../crypto/types";

export function deriveSecrets(
  c: Crypto,
  input: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  chunks = 3,
): Uint8Array[] {
  if (salt.length !== 32) {
    throw new Error(`deriveSecrets: salt precisa ter 32 bytes (tem ${salt.length})`);
  }
  if (chunks < 1 || chunks > 3) throw new Error("deriveSecrets: chunks fora de 1..3");
  const okm = c.hkdf(input, 32 * chunks, { salt, info });
  const out: Uint8Array[] = [];
  for (let i = 0; i < chunks; i++) out.push(okm.subarray(i * 32, i * 32 + 32));
  return out;
}
