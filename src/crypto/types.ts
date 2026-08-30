// A fronteira de criptografia da lib. TUDO que precisa de primitivo cripto passa
// por esta interface — o núcleo do oniwalib não chama `node:crypto` nem nada de
// plataforma diretamente. Assim a lib é ~100% portável e o ÚNICO ponto preso ao
// motor é qual adapter se injeta.
//
// - `node-adapter.ts`  usa `node:crypto` — referência, roda hoje em bun/node e
//   nas partes que o RTS já tem (HKDF, HMAC, SHA-256, randomBytes).
// - `rts-adapter.ts`   (Fase 0) usará as primitivas nativas do RTS quando
//   `createCipheriv` + X25519 + Ed25519 entrarem.
//
// O que falta no RTS para o adapter nativo fechar está marcado com  RTS-GAP.

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

/** Lista dos métodos que o adapter nativo do RTS ainda não consegue prover. */
export const RTS_GAPS = [
  "aesGcmEncrypt",
  "aesGcmDecrypt",
  "aesCbcEncrypt",
  "aesCbcDecrypt",
  "generateX25519",
  "x25519",
  "generateSigningKey",
  "sign",
  "verify",
] as const;
