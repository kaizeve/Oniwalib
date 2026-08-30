// SignalStorage — a ponte entre o `SignalKeyStore`/`AuthCreds` do oniwalib e o
// que o session-builder / session-cipher pedem. Espelha o `signalStorage(...)`
// da Baileys (`Signal/libsignal.js`).
//
//   sessão      → SignalKeyStore tipo "session",      id = endereço ("user.device")
//   pre-key     → tipo "pre-key",     id = número em string
//   identity    → tipo "identity-key", id = endereço  (TOFU)
//   signedPreKey / identidade / registrationId → direto de `creds`

import type { AuthenticationState } from "../auth/state";
import { prefixKey, type SignalKeyPair } from "./curve";
import { SessionRecord } from "./session-record";

export interface SignalStorage {
  getOurIdentity(): SignalKeyPair;
  getOurRegistrationId(): number;
  loadSession(id: string): Promise<SessionRecord | undefined>;
  storeSession(id: string, rec: SessionRecord): Promise<void>;
  isTrustedIdentity(id: string, key: Uint8Array): Promise<boolean>;
  /** Grava a identidade do par (TOFU). `true` se era nova ou mudou. */
  saveIdentity(id: string, key: Uint8Array): Promise<boolean>;
  loadPreKey(id: number): Promise<SignalKeyPair | undefined>;
  removePreKey(id: number): Promise<void>;
  loadSignedPreKey(id: number): Promise<SignalKeyPair | undefined>;
}

function u8(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  if (v && typeof v === "object" && Array.isArray((v as any).data)) {
    return Uint8Array.from((v as any).data);
  }
  throw new Error("signal store: valor de chave não é bytes");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export function makeSignalStorage(auth: AuthenticationState): SignalStorage {
  const { creds, keys } = auth;

  return {
    getOurIdentity() {
      return {
        pubKey: prefixKey(creds.signedIdentityKey.publicKey),
        privKey: creds.signedIdentityKey.privateKey,
      };
    },

    getOurRegistrationId() {
      return creds.registrationId;
    },

    async loadSession(id) {
      const { [id]: s } = await keys.get("session", [id]);
      if (!s) return undefined;
      return SessionRecord.deserialize(s);
    },

    async storeSession(id, rec) {
      await keys.set({ session: { [id]: rec.serialize() } });
    },

    async isTrustedIdentity() {
      return true; // TOFU — igual ao WhatsApp Web
    },

    async saveIdentity(id, key) {
      const { [id]: existingRaw } = await keys.get("identity-key", [id]);
      const existing = existingRaw ? u8(existingRaw) : undefined;
      if (existing && !bytesEqual(existing, key)) {
        // identidade mudou → derruba a sessão e regrava a chave
        await keys.set({ session: { [id]: null }, "identity-key": { [id]: key } });
        return true;
      }
      if (!existing) {
        await keys.set({ "identity-key": { [id]: key } });
        return true;
      }
      return false;
    },

    async loadPreKey(id) {
      const key = String(id);
      const { [key]: k } = await keys.get("pre-key", [key]);
      if (!k) return undefined;
      const pair = k as { public?: unknown; private?: unknown; publicKey?: unknown; privateKey?: unknown };
      return {
        pubKey: prefixKey(u8(pair.public ?? pair.publicKey)),
        privKey: u8(pair.private ?? pair.privateKey),
      };
    },

    async removePreKey(id) {
      await keys.set({ "pre-key": { [String(id)]: null } });
    },

    async loadSignedPreKey() {
      return {
        pubKey: prefixKey(creds.signedPreKey.keyPair.publicKey),
        privKey: creds.signedPreKey.keyPair.privateKey,
      };
    },
  };
}
