// Os dois protobufs do Signal que o WhatsApp 1:1 usa, sobre `proto/wire.ts`.
//
//   message WhisperMessage {          // "msg"  (type=1)
//     bytes  ephemeralKey    = 1;     // ratchet pública corrente (33 bytes DJB)
//     uint32 counter         = 2;
//     uint32 previousCounter = 3;
//     bytes  ciphertext      = 4;     // AES-256-CBC
//   }
//   message PreKeyWhisperMessage {    // "pkmsg" (type=3)
//     uint32 registrationId = 5;
//     uint32 preKeyId       = 1;
//     uint32 signedPreKeyId = 6;
//     bytes  baseKey        = 2;      // efêmera de quem inicia (33 bytes)
//     bytes  identityKey    = 3;      // identidade de quem inicia (33 bytes)
//     bytes  message        = 4;      // WhisperMessage serializada (com versão+MAC)
//   }
//
// No fio: `versionByte || protobuf`, e a WhisperMessage ainda leva `|| mac[0:8]`.
// versionByte = (3 << 4) | 3 = 0x33.

import { Reader, Writer } from "../proto/wire";

export const CIPHERTEXT_MESSAGE_VERSION = 3;
export const MAC_LENGTH = 8;

/** `(current << 4) | current` — o byte de versão que prefixa msg e pkmsg. */
export const VERSION_BYTE = (CIPHERTEXT_MESSAGE_VERSION << 4) | CIPHERTEXT_MESSAGE_VERSION;

export function decodeVersionByte(b: number): [number, number] {
  return [b >> 4, b & 0x0f];
}

export interface WhisperMessage {
  ephemeralKey: Uint8Array;
  counter: number;
  previousCounter: number;
  ciphertext: Uint8Array;
}

export function encodeWhisperMessage(m: WhisperMessage): Uint8Array {
  // `counter`/`previousCounter` são escritos MESMO valendo 0 — a libsignal
  // (protobufjs) os inclui porque o campo é setado explicitamente, e o MAC
  // precisa bater byte a byte.
  return new Writer()
    .bytes(1, m.ephemeralKey)
    .uintF(2, m.counter)
    .uintF(3, m.previousCounter)
    .bytes(4, m.ciphertext)
    .finish();
}

export function decodeWhisperMessage(bytes: Uint8Array): WhisperMessage {
  const f = new Reader(bytes).fields();
  const eph = bytesField(f, 1);
  const ct = bytesField(f, 4);
  if (!eph || !ct) throw new Error("WhisperMessage: falta ephemeralKey/ciphertext");
  return {
    ephemeralKey: eph,
    counter: numField(f, 2),
    previousCounter: numField(f, 3),
    ciphertext: ct,
  };
}

export interface PreKeyWhisperMessage {
  registrationId: number;
  preKeyId?: number;
  signedPreKeyId: number;
  baseKey: Uint8Array;
  identityKey: Uint8Array;
  message: Uint8Array;
}

export function encodePreKeyWhisperMessage(m: PreKeyWhisperMessage): Uint8Array {
  const w = new Writer();
  if (m.preKeyId !== undefined) w.uintF(1, m.preKeyId);
  w.bytes(2, m.baseKey);
  w.bytes(3, m.identityKey);
  w.bytes(4, m.message);
  w.uintF(5, m.registrationId);
  w.uintF(6, m.signedPreKeyId);
  return w.finish();
}

export function decodePreKeyWhisperMessage(bytes: Uint8Array): PreKeyWhisperMessage {
  const f = new Reader(bytes).fields();
  const baseKey = bytesField(f, 2);
  const identityKey = bytesField(f, 3);
  const message = bytesField(f, 4);
  if (!baseKey || !identityKey || !message) {
    throw new Error("PreKeyWhisperMessage: falta baseKey/identityKey/message");
  }
  const preKeyId = f.has(1) ? numField(f, 1) : undefined;
  return {
    registrationId: numField(f, 5),
    preKeyId,
    signedPreKeyId: numField(f, 6),
    baseKey,
    identityKey,
    message,
  };
}

type Fields = Map<number, Array<number | Uint8Array>>;

function bytesField(f: Fields, n: number): Uint8Array | undefined {
  const v = f.get(n)?.[0];
  return v instanceof Uint8Array ? v : undefined;
}
function numField(f: Fields, n: number): number {
  const v = f.get(n)?.[0];
  return typeof v === "number" ? v : 0;
}
