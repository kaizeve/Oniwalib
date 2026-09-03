// Expansão de chave e MACs do app-state sync. Porte fiel do
// `@whiskeysockets/baileys` `src/Utils/chat-utils.ts` (6.x):
//
//   mutationKeys(keydata) = HKDF-SHA256(keydata, 160, info="WhatsApp Mutation Keys")
//     → indexKey | valueEncryptionKey | valueMacKey | snapshotMacKey | patchMacKey
//       (5 fatias de 32)
//
//   generateMac(op, encValue, keyId, valueMacKey):
//     kd   = [op==SET?1:2] ++ keyId
//     last = 8 bytes, last[7] = kd.length
//     HMAC-SHA512(valueMacKey, kd ++ encValue ++ last)[:32]
//
//   generateSnapshotMac(lthash, version, name, snapshotMacKey):
//     HMAC-SHA256(key, lthash ++ u64be(version) ++ utf8(name))
//
//   generatePatchMac(snapshotMac, valueMacs, version, type, patchMacKey):
//     HMAC-SHA256(key, snapshotMac ++ ...valueMacs ++ u64be(version) ++ utf8(type))

import type { Crypto } from "../crypto/types";
import { utf8Encode } from "../frame/buffer";

export const SET = 1;
export const REMOVE = 2;
export type SyncdOperation = typeof SET | typeof REMOVE;

export interface MutationKeys {
  indexKey: Uint8Array;
  valueEncryptionKey: Uint8Array;
  valueMacKey: Uint8Array;
  snapshotMacKey: Uint8Array;
  patchMacKey: Uint8Array;
}

const MUT_INFO = utf8Encode("WhatsApp Mutation Keys");

export function concat(...parts: Uint8Array[]): Uint8Array {
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

export function mutationKeys(c: Crypto, keydata: Uint8Array): MutationKeys {
  const e = c.hkdf(keydata, 160, { info: MUT_INFO });
  return {
    indexKey: e.slice(0, 32),
    valueEncryptionKey: e.slice(32, 64),
    valueMacKey: e.slice(64, 96),
    snapshotMacKey: e.slice(96, 128),
    patchMacKey: e.slice(128, 160),
  };
}

/** 8 bytes, big-endian, com o valor nos 4 bytes baixos (como o
 *  `Buffer.alloc(8).writeUint32BE(n, 4)` da Baileys). */
export function u64be(n: number): Uint8Array {
  const b = new Uint8Array(8);
  b[4] = (n >>> 24) & 0xff;
  b[5] = (n >>> 16) & 0xff;
  b[6] = (n >>> 8) & 0xff;
  b[7] = n & 0xff;
  return b;
}

export function generateMac(
  c: Crypto,
  operation: SyncdOperation,
  data: Uint8Array,
  keyId: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  const kd = concat(Uint8Array.from([operation === SET ? 1 : 2]), keyId);
  const last = new Uint8Array(8);
  last[7] = kd.length & 0xff;
  return c.hmacSha512(key, concat(kd, data, last)).slice(0, 32);
}

export function generateSnapshotMac(
  c: Crypto,
  lthash: Uint8Array,
  version: number,
  name: string,
  key: Uint8Array,
): Uint8Array {
  return c.hmacSha256(key, concat(lthash, u64be(version), utf8Encode(name)));
}

export function generatePatchMac(
  c: Crypto,
  snapshotMac: Uint8Array,
  valueMacs: Uint8Array[],
  version: number,
  type: string,
  key: Uint8Array,
): Uint8Array {
  return c.hmacSha256(
    key,
    concat(snapshotMac, ...valueMacs, u64be(version), utf8Encode(type)),
  );
}
