// A fronteira de criptografia da lib. TUDO que precisa de primitivo cripto passa
// por esta interface — o núcleo do oniwalib não chama `node:crypto` nem nada de
// plataforma diretamente. Assim a lib é ~100% portável e o ÚNICO ponto preso ao
// motor é qual adapter se injeta.
//
// - `node-adapter.ts`  usa `node:crypto` + `curve25519-js` — referência, roda em
//   bun/node.
// - `rts-adapter.ts`   usa as primitivas nativas do RTS: `node:crypto` para
//   hashes/HMAC/HKDF/AES-GCM/AES-CBC, o trio X25519 cru e o par XEdDSA
//   `xeddsaSign`/`xeddsaVerify` (UrubuCode/rts#2609). Fechou — `RTS_GAPS` vazio.
//
// As marcas  RTS-GAP  abaixo são históricas: descrevem o que faltava no RTS
// antes de #2609 e ficam como nota do porquê de cada método existir na interface.

export interface KeyPair {
  /** 32 bytes. */
  publicKey: Uint8Array;
  /** 32 bytes. */
  privateKey: Uint8Array;
}

export interface Crypto {
  /** Bytes aleatórios criptográficos. */
  randomBytes(n: number): Uint8Array;

  /** SHA-256. */
  sha256(data: Uint8Array): Uint8Array;

  /** HMAC-SHA-256. */
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array;

  /** HMAC-SHA-512 — usado no MAC de valor do app-state sync (LT-hash). */
  hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array;

  /** MD5 — só para o `buildHash` do handshake (não é primitivo de segurança). */
  md5?(data: Uint8Array): Uint8Array;

  /** HKDF-SHA-256 → `length` bytes. */
  hkdf(ikm: Uint8Array, length: number, opts: { salt?: Uint8Array; info?: Uint8Array }): Uint8Array;

  /** AES-256-GCM. `aad` opcional. Devolve ciphertext SEGUIDO da tag de 16 bytes. RTS-GAP */
  aesGcmEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array;
  /** Inverso. `ciphertext` inclui a tag de 16 bytes no fim. Lança se a tag não bater. RTS-GAP */
  aesGcmDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array, aad?: Uint8Array): Uint8Array;

  /** AES-256-CBC com padding PKCS#7. RTS-GAP */
  aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array): Uint8Array;
  aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array;

  /** Par de chaves X25519 (Curve25519 para ECDH). RTS-GAP */
  generateX25519(): KeyPair;
  /** ECDH X25519 → segredo compartilhado de 32 bytes. RTS-GAP */
  x25519(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;

  /** Par de chaves de assinatura sobre Curve25519 (Ed25519 / XEdDSA). RTS-GAP */
  generateSigningKey(): KeyPair;
  /** Assinatura de 64 bytes. RTS-GAP */
  sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array;
  /** Verifica uma assinatura de 64 bytes. RTS-GAP */
  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;
}

/**
 * Métodos que o adapter nativo do RTS ainda não consegue prover.
 *
 * Vazio desde UrubuCode/rts#2609 (AES-GCM/CBC, trio X25519 e XEdDSA disponíveis
 * em `node:crypto`). Mantido como lista para `RTS_GAPS.length === 0` seguir
 * sendo o sinal de "cripto do RTS fechada" e voltar a encher se algo regredir.
 */
export const RTS_GAPS: readonly (keyof Crypto)[] = [];
