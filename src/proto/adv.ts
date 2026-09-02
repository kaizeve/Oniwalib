// ADV (Auth Device / companion) — as mensagens protobuf do pareamento
// multi-device. Portado de @whiskeysockets/baileys `WAProto` (master, 2026-08),
// só os campos que o fluxo QR usa.
//
//   message ADVSignedDeviceIdentityHMAC { bytes details = 1; bytes hmac = 2; }
//   message ADVSignedDeviceIdentity {
//     bytes details = 1; bytes accountSignatureKey = 2;
//     bytes accountSignature = 3; bytes deviceSignature = 4;
//   }
//   message ADVDeviceIdentity {
//     uint32 rawId = 1; uint64 timestamp = 2; uint32 keyIndex = 3;
//     ADVEncryptionType accountType = 4; ADVEncryptionType deviceType = 5;
//   }
//
// Sobre o codec `proto/wire.ts` (varint + length-delimited), não protobufjs.

import { Reader, Writer } from "./wire";

export interface ADVSignedDeviceIdentityHMAC {
  details: Uint8Array;
  hmac: Uint8Array;
}

export interface ADVSignedDeviceIdentity {
  details: Uint8Array;
  accountSignatureKey?: Uint8Array;
  accountSignature: Uint8Array;
  deviceSignature?: Uint8Array;
}

export interface ADVDeviceIdentity {
  rawId: number;
  timestamp: number;
  keyIndex: number;
}

const bytesAt = (
  f: Map<number, Array<number | Uint8Array>>,
  field: number,
): Uint8Array | undefined => {
  const v = f.get(field)?.[0];
  return v instanceof Uint8Array ? v : undefined;
};

const numAt = (
  f: Map<number, Array<number | Uint8Array>>,
  field: number,
): number => {
  const v = f.get(field)?.[0];
  return typeof v === "number" ? v : 0;
};

export function decodeSignedDeviceIdentityHMAC(bytes: Uint8Array): ADVSignedDeviceIdentityHMAC {
  const f = new Reader(bytes).fields();
  return {
    details: bytesAt(f, 1) ?? new Uint8Array(0),
    hmac: bytesAt(f, 2) ?? new Uint8Array(0),
  };
}

export function decodeSignedDeviceIdentity(bytes: Uint8Array): ADVSignedDeviceIdentity {
  const f = new Reader(bytes).fields();
  return {
    details: bytesAt(f, 1) ?? new Uint8Array(0),
    accountSignatureKey: bytesAt(f, 2),
    accountSignature: bytesAt(f, 3) ?? new Uint8Array(0),
    deviceSignature: bytesAt(f, 4),
  };
}

/** Reserializa uma `ADVSignedDeviceIdentity`. Com `includeAccountSignatureKey`
 *  falso (o caso da resposta `pair-device-sign`), o campo 2 é omitido — igual
 *  ao `encodeSignedDeviceIdentity(account, false)` da Baileys. */
export function encodeSignedDeviceIdentity(
  a: ADVSignedDeviceIdentity,
  includeAccountSignatureKey: boolean,
): Uint8Array {
  const w = new Writer();
  w.bytes(1, a.details);
  if (includeAccountSignatureKey && a.accountSignatureKey && a.accountSignatureKey.length) {
    w.bytes(2, a.accountSignatureKey);
  }
  w.bytes(3, a.accountSignature);
  if (a.deviceSignature && a.deviceSignature.length) {
    w.bytes(4, a.deviceSignature);
  }
  return w.finish();
}

export function encodeSignedDeviceIdentityHMAC(m: ADVSignedDeviceIdentityHMAC): Uint8Array {
  return new Writer().bytes(1, m.details).bytes(2, m.hmac).finish();
}

export function decodeDeviceIdentity(bytes: Uint8Array): ADVDeviceIdentity {
  const f = new Reader(bytes).fields();
  return {
    rawId: numAt(f, 1),
    timestamp: numAt(f, 2),
    keyIndex: numAt(f, 3),
  };
}

export function encodeDeviceIdentity(d: ADVDeviceIdentity): Uint8Array {
  return new Writer()
    .uint(1, d.rawId)
    .uint(2, d.timestamp)
    .uint(3, d.keyIndex)
    .finish();
}
