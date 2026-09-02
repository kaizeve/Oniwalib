// Estado de autenticação: as credenciais de longa duração + o cofre de chaves
// do Signal. É o que precisa sobreviver a um restart para reconectar sem
// re-parear.
//
// `initAuthCreds` gera o material novo (uma vez, no primeiro boot). O
// `SignalKeyStore` é a interface que a camada Signal consome; aqui vêm duas
// implementações: memória (testes) e arquivo JSON (dev).

import { crypto } from "../crypto";
import type { KeyPair } from "../crypto/types";

export interface Contact {
  id: string;
  name?: string;
}

/** Identidade Signal de um par (a conta principal, no pareamento). `identifierKey`
 *  é a pública com o byte de tipo DJB (0x05) na frente. */
export interface SignalIdentity {
  identifier: { name: string; deviceId: number };
  identifierKey: Uint8Array;
}

export interface AuthCreds {
  noiseKey: KeyPair; // estática do cliente no handshake Noise
  signedIdentityKey: KeyPair; // identidade Signal (Curve25519)
  signedPreKey: {
    keyPair: KeyPair;
    signature: Uint8Array;
    keyId: number;
  };
  registrationId: number;
  advSecretKey: string; // base64 — usado no pareamento multi-device
  me?: Contact;
  account?: unknown; // ADVSignedDeviceIdentity assinada, guardada após o pareamento
  signalIdentities?: SignalIdentity[];
  platform?: string;
  registered: boolean;
  pairingCode?: string;
  nextPreKeyId: number;
  firstUnuploadedPreKeyId: number;
}

export type SignalDataType =
  | "pre-key"
  | "session"
  | "identity-key"
  | "sender-key"
  | "app-state-sync-key"
  | "app-state-sync-version"
  | "sender-key-memory"
  // Mapa número↔lid (`553...@s.whatsapp.net` ↔ `1...@lid`). Gravado nos dois
  // sentidos: id = um lado, valor (string) = o outro. Alimentado passivamente
  // pelo que as stanzas e a metadata de grupo já pareiam.
  | "lid-mapping";

export interface SignalKeyStore {
  get(type: SignalDataType, ids: string[]): Promise<Record<string, unknown>>;
  set(data: { [T in SignalDataType]?: Record<string, unknown> }): Promise<void>;
}

export interface AuthenticationState {
  creds: AuthCreds;
  keys: SignalKeyStore;
}

function signedKeyId(): number {
  // 1..(2^24-1), como a Baileys.
  return (crypto().randomBytes(3)[0]! << 16) | (crypto().randomBytes(2)[0]! << 8) | 1;
}

export function initAuthCreds(): AuthCreds {
  const c = crypto();
  const identity = c.generateSigningKey();
  const preKey = c.generateX25519();
  const keyId = 1;

  // signedPreKey: assina a pública da preKey (formato DJB `0x05 || pub`) com a
  // identidade. Ambos os adapters já assinam de verdade (bun/node via
  // `curve25519-js`, RTS via `xeddsaSign`), então isto tem de dar uma assinatura
  // real de 64 bytes — o servidor rejeita o registro com qualquer outra coisa.
  const signature = c.sign(identity.privateKey, prefixType(preKey.publicKey));
  if (signature.length !== 64) {
    throw new Error(
      `initAuthCreds: assinatura da signedPreKey com ${signature.length} bytes (esperado 64) — adapter de cripto sem XEdDSA?`,
    );
  }

  const regId = ((c.randomBytes(2)[0]! << 8) | c.randomBytes(1)[0]!) & 0x3fff;

  return {
    noiseKey: c.generateX25519(),
    signedIdentityKey: identity,
    signedPreKey: { keyPair: preKey, signature, keyId },
    registrationId: regId,
    advSecretKey: b64(c.randomBytes(32)),
    registered: false,
    nextPreKeyId: 2,
    firstUnuploadedPreKeyId: 2,
  };
}

// A assinatura da signedPreKey é sobre  0x05 || pubkey(32)  (formato DJB do
// Signal). `prefixType` põe o byte de tipo.
function prefixType(pub: Uint8Array): Uint8Array {
  const out = new Uint8Array(pub.length + 1);
  out[0] = 0x05;
  out.set(pub, 1);
  return out;
}

// --- stores ---------------------------------------------------------------

export function memoryAuthState(creds?: AuthCreds): AuthenticationState {
  const store: Record<string, Record<string, unknown>> = {};
  return {
    creds: creds ?? initAuthCreds(),
    keys: {
      async get(type, ids) {
        const bucket = store[type] ?? {};
        const out: Record<string, unknown> = {};
        for (const id of ids) {
          if (id in bucket) out[id] = bucket[id];
        }
        return out;
      },
      async set(data) {
        for (const type of Object.keys(data) as SignalDataType[]) {
          store[type] = { ...(store[type] ?? {}), ...data[type] };
        }
      },
    },
  };
}

// --- helpers de codificação (sem Buffer, para portar limpo) --------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function b64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[c & 63] : "=";
  }
  return out;
}

export function b64decode(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

void signedKeyId;
