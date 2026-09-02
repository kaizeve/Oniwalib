// SessionRecord / SessionEntry — o estado de uma sessão Double Ratchet 1:1.
//
// Um `SessionRecord` guarda VÁRIAS `SessionEntry` (indexadas pela `baseKey`):
// a aberta + as fechadas, para decifrar mensagens fora de ordem ou de uma
// sessão antiga (retry, re-pareamento). `getSessions()` devolve todas, mais
// recente primeiro — o cipher tenta uma a uma.
//
// Serialização PRÓPRIA (JSON com bytes em base64), gravada pelo `SignalKeyStore`
// no tipo `session`. Estrutura espelha `libsignal/src/session_record.js` para
// facilitar auditoria lado a lado, mas o formato no disco é nosso.

import { b64, b64decode } from "../auth/state";
import type { SignalKeyPair } from "./curve";

export const CHAIN_SENDING = 1;
export const CHAIN_RECEIVING = 2;
export const BASE_KEY_OURS = 1;
export const BASE_KEY_THEIRS = 2;

const CLOSED_SESSIONS_MAX = 40;

export interface Chain {
  chainKey: { counter: number; key?: Uint8Array };
  chainType: number;
  messageKeys: Record<number, Uint8Array>;
}

export interface Ratchet {
  ephemeralKeyPair: SignalKeyPair;
  lastRemoteEphemeralKey: Uint8Array;
  previousCounter: number;
  rootKey: Uint8Array;
}

export interface IndexInfo {
  baseKey: Uint8Array;
  baseKeyType: number;
  closed: number;
  used: number;
  created: number;
  remoteIdentityKey: Uint8Array;
}

export interface PendingPreKey {
  signedKeyId: number;
  baseKey: Uint8Array;
  preKeyId?: number;
}

const has = (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k);

export class SessionEntry {
  registrationId = 0;
  currentRatchet!: Ratchet;
  indexInfo!: IndexInfo;
  pendingPreKey?: PendingPreKey;
  private _chains: Record<string, Chain> = {};

  addChain(key: Uint8Array, value: Chain): void {
    const id = b64(key);
    if (has(this._chains, id)) throw new Error("session: tentativa de sobrescrever chain");
    this._chains[id] = value;
  }

  getChain(key: Uint8Array): Chain | undefined {
    return this._chains[b64(key)];
  }

  deleteChain(key: Uint8Array): void {
    delete this._chains[b64(key)];
  }

  serialize(): Record<string, unknown> {
    const r = this.currentRatchet;
    const i = this.indexInfo;
    const data: Record<string, unknown> = {
      registrationId: this.registrationId,
      currentRatchet: {
        ephemeralKeyPair: {
          pubKey: b64(r.ephemeralKeyPair.pubKey),
          privKey: b64(r.ephemeralKeyPair.privKey),
        },
        lastRemoteEphemeralKey: b64(r.lastRemoteEphemeralKey),
        previousCounter: r.previousCounter,
        rootKey: b64(r.rootKey),
      },
      indexInfo: {
        baseKey: b64(i.baseKey),
        baseKeyType: i.baseKeyType,
        closed: i.closed,
        used: i.used,
        created: i.created,
        remoteIdentityKey: b64(i.remoteIdentityKey),
      },
      _chains: this.serializeChains(),
    };
    if (this.pendingPreKey) {
      data.pendingPreKey = {
        signedKeyId: this.pendingPreKey.signedKeyId,
        baseKey: b64(this.pendingPreKey.baseKey),
        ...(this.pendingPreKey.preKeyId !== undefined
          ? { preKeyId: this.pendingPreKey.preKeyId }
          : {}),
      };
    }
    return data;
  }

  private serializeChains(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [id, c] of Object.entries(this._chains)) {
      const mks: Record<string, string> = {};
      for (const [idx, mk] of Object.entries(c.messageKeys)) mks[idx] = b64(mk as Uint8Array);
      out[id] = {
        chainKey: {
          counter: c.chainKey.counter,
          key: c.chainKey.key ? b64(c.chainKey.key) : undefined,
        },
        chainType: c.chainType,
        messageKeys: mks,
      };
    }
    return out;
  }

  static deserialize(data: any): SessionEntry {
    const e = new SessionEntry();
    e.registrationId = data.registrationId;
    e.currentRatchet = {
      ephemeralKeyPair: {
        pubKey: b64decode(data.currentRatchet.ephemeralKeyPair.pubKey),
        privKey: b64decode(data.currentRatchet.ephemeralKeyPair.privKey),
      },
      lastRemoteEphemeralKey: b64decode(data.currentRatchet.lastRemoteEphemeralKey),
      previousCounter: data.currentRatchet.previousCounter,
      rootKey: b64decode(data.currentRatchet.rootKey),
    };
    e.indexInfo = {
      baseKey: b64decode(data.indexInfo.baseKey),
      baseKeyType: data.indexInfo.baseKeyType,
      closed: data.indexInfo.closed,
      used: data.indexInfo.used,
      created: data.indexInfo.created,
      remoteIdentityKey: b64decode(data.indexInfo.remoteIdentityKey),
    };
    const chains: Record<string, Chain> = {};
    for (const [id, c] of Object.entries<any>(data._chains ?? {})) {
      const mks: Record<number, Uint8Array> = {};
      for (const [idx, mk] of Object.entries<string>(c.messageKeys ?? {})) mks[+idx] = b64decode(mk);
      chains[id] = {
        chainKey: {
          counter: c.chainKey.counter,
          key: c.chainKey.key ? b64decode(c.chainKey.key) : undefined,
        },
        chainType: c.chainType,
        messageKeys: mks,
      };
    }
    e["_chains"] = chains;
    if (data.pendingPreKey) {
      e.pendingPreKey = {
        signedKeyId: data.pendingPreKey.signedKeyId,
        baseKey: b64decode(data.pendingPreKey.baseKey),
        ...(data.pendingPreKey.preKeyId !== undefined
          ? { preKeyId: data.pendingPreKey.preKeyId }
          : {}),
      };
    }
    return e;
  }
}

export class SessionRecord {
  sessions: Record<string, SessionEntry> = {};

  static deserialize(data: any): SessionRecord {
    const rec = new SessionRecord();
    for (const [key, entry] of Object.entries<any>(data?._sessions ?? {})) {
      rec.sessions[key] = SessionEntry.deserialize(entry);
    }
    return rec;
  }

  serialize(): Record<string, unknown> {
    const _sessions: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(this.sessions)) _sessions[key] = entry.serialize();
    return { _sessions, version: "oni-v1" };
  }

  haveOpenSession(): boolean {
    const s = this.getOpenSession();
    return !!s && typeof s.registrationId === "number";
  }

  getSession(key: Uint8Array): SessionEntry | undefined {
    const s = this.sessions[b64(key)];
    if (s && s.indexInfo.baseKeyType === BASE_KEY_OURS) {
      throw new Error("session: lookup usando a nossa própria baseKey");
    }
    return s;
  }

  getOpenSession(): SessionEntry | undefined {
    for (const s of Object.values(this.sessions)) {
      if (!this.isClosed(s)) return s;
    }
    return undefined;
  }

  setSession(session: SessionEntry): void {
    this.sessions[b64(session.indexInfo.baseKey)] = session;
  }

  getSessions(): SessionEntry[] {
    return Object.values(this.sessions).sort(
      (a, b) => (b.indexInfo.used || 0) - (a.indexInfo.used || 0),
    );
  }

  closeSession(session: SessionEntry): void {
    if (!this.isClosed(session)) session.indexInfo.closed = Date.now();
  }

  isClosed(session: SessionEntry): boolean {
    return session.indexInfo.closed !== -1;
  }

  removeOldSessions(): void {
    while (Object.keys(this.sessions).length > CLOSED_SESSIONS_MAX) {
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const [key, s] of Object.entries(this.sessions)) {
        if (s.indexInfo.closed !== -1 && s.indexInfo.closed < oldest) {
          oldest = s.indexInfo.closed;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      delete this.sessions[oldestKey];
    }
  }
}
