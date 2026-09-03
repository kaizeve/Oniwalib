// Protobuf do app-state sync — só os campos que a oniwalib usa. Escrito à mão
// sobre `Reader`/`Writer` (mesmo estilo de `proto/e2e-message.ts`), sem
// protobufjs. Números de campo do WAProto (`SyncdPatch`, `SyncActionValue`, …),
// estáveis há anos.

import { Reader, Writer } from "../proto/wire";

function b(v: number | Uint8Array | undefined): Uint8Array | undefined {
  return v instanceof Uint8Array ? v : undefined;
}
function n(v: number | Uint8Array | undefined): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function s(v: number | Uint8Array | undefined): string | undefined {
  return v instanceof Uint8Array ? utf8(v) : undefined;
}
function utf8(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const c = bytes[i++]!;
    if (c < 0x80) out += String.fromCharCode(c);
    else if (c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++]! & 0x3f));
    else if (c < 0xf0)
      out += String.fromCharCode(
        ((c & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f),
      );
    else {
      const cp =
        ((c & 0x07) << 18) |
        ((bytes[i++]! & 0x3f) << 12) |
        ((bytes[i++]! & 0x3f) << 6) |
        (bytes[i++]! & 0x3f);
      const u = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff));
    }
  }
  return out;
}

// ---- estruturas simples -------------------------------------------------

export interface KeyId {
  id?: Uint8Array;
}
export interface SyncdVersion {
  version?: number;
}
export interface ExternalBlobReference {
  mediaKey?: Uint8Array;
  directPath?: string;
  handle?: string;
  fileSizeBytes?: number;
  fileSha256?: Uint8Array;
  fileEncSha256?: Uint8Array;
}
export interface SyncdRecord {
  index?: { blob?: Uint8Array };
  value?: { blob?: Uint8Array };
  keyId?: KeyId;
}
export interface SyncdMutation {
  /** 0 = SET, 1 = REMOVE (enum do WAProto). */
  operation?: number;
  record?: SyncdRecord;
}
export interface SyncdPatch {
  version?: SyncdVersion;
  mutations: SyncdMutation[];
  externalMutations?: ExternalBlobReference;
  snapshotMac?: Uint8Array;
  patchMac?: Uint8Array;
  keyId?: KeyId;
}
export interface SyncdSnapshot {
  version?: SyncdVersion;
  records: SyncdRecord[];
  mac?: Uint8Array;
  keyId?: KeyId;
}

// ---- decode -----------------------------------------------------------

export function decodeExternalBlobReference(buf: Uint8Array): ExternalBlobReference {
  const f = new Reader(buf).fields();
  return {
    mediaKey: b(f.get(1)?.[0]),
    directPath: s(f.get(2)?.[0]),
    handle: s(f.get(3)?.[0]),
    fileSizeBytes: n(f.get(4)?.[0]),
    fileSha256: b(f.get(5)?.[0]),
    fileEncSha256: b(f.get(6)?.[0]),
  };
}

function decodeKeyId(buf: Uint8Array | undefined): KeyId | undefined {
  if (!buf) return undefined;
  return { id: b(new Reader(buf).fields().get(1)?.[0]) };
}
function decodeVersion(buf: Uint8Array | undefined): SyncdVersion | undefined {
  if (!buf) return undefined;
  return { version: n(new Reader(buf).fields().get(1)?.[0]) };
}
function decodeRecord(buf: Uint8Array): SyncdRecord {
  const f = new Reader(buf).fields();
  const idx = b(f.get(1)?.[0]);
  const val = b(f.get(2)?.[0]);
  return {
    index: idx ? { blob: b(new Reader(idx).fields().get(1)?.[0]) } : undefined,
    value: val ? { blob: b(new Reader(val).fields().get(1)?.[0]) } : undefined,
    keyId: decodeKeyId(b(f.get(3)?.[0])),
  };
}
function decodeMutation(buf: Uint8Array): SyncdMutation {
  const f = new Reader(buf).fields();
  const rec = b(f.get(2)?.[0]);
  return {
    operation: n(f.get(1)?.[0]) ?? 0,
    record: rec ? decodeRecord(rec) : undefined,
  };
}

export function decodeSyncdPatch(buf: Uint8Array): SyncdPatch {
  const f = new Reader(buf).fields();
  return {
    version: decodeVersion(b(f.get(1)?.[0])),
    mutations: (f.get(2) ?? []).map((x) => decodeMutation(x as Uint8Array)),
    externalMutations: b(f.get(3)?.[0])
      ? decodeExternalBlobReference(b(f.get(3)?.[0])!)
      : undefined,
    snapshotMac: b(f.get(5)?.[0]),
    patchMac: b(f.get(6)?.[0]),
    keyId: decodeKeyId(b(f.get(7)?.[0])),
  };
}

export function decodeSyncdSnapshot(buf: Uint8Array): SyncdSnapshot {
  const f = new Reader(buf).fields();
  return {
    version: decodeVersion(b(f.get(1)?.[0])),
    records: (f.get(2) ?? []).map((x) => decodeRecord(x as Uint8Array)),
    mac: b(f.get(3)?.[0]),
    keyId: decodeKeyId(b(f.get(4)?.[0])),
  };
}

/** `SyncdMutations { repeated SyncdMutation mutations = 1 }` — o corpo de um
 *  blob externo de patch. */
export function decodeSyncdMutationsBlob(buf: Uint8Array): SyncdMutation[] {
  const f = new Reader(buf).fields();
  return (f.get(1) ?? []).map((x) => decodeMutation(x as Uint8Array));
}

// ---- SyncActionData / SyncActionValue --------------------------------

export interface SyncActionMessageRange {
  lastMessageTimestamp?: number;
  lastSystemMessageTimestamp?: number;
}
export interface SyncActionValue {
  timestamp?: number;
  starAction?: { starred?: boolean };
  contactAction?: { fullName?: string; firstName?: string; lidJid?: string };
  muteAction?: { muted?: boolean; muteEndTimestamp?: number };
  pinAction?: { pinned?: boolean };
  pushNameSetting?: { name?: string };
  archiveChatAction?: { archived?: boolean };
  markChatAsReadAction?: { read?: boolean };
  deleteChatAction?: Record<string, never>;
  deleteMessageForMeAction?: { deleteMedia?: boolean; messageTimestamp?: number };
}
export interface SyncActionData {
  index?: Uint8Array;
  value?: SyncActionValue;
  padding?: Uint8Array;
  version?: number;
}

function decodeBoolMsg(buf: Uint8Array | undefined, field: number): boolean | undefined {
  if (!buf) return undefined;
  const v = new Reader(buf).fields().get(field)?.[0];
  return typeof v === "number" ? v !== 0 : undefined;
}

export function decodeSyncActionValue(buf: Uint8Array): SyncActionValue {
  const f = new Reader(buf).fields();
  const out: SyncActionValue = {};
  const ts = f.get(1)?.[0];
  if (typeof ts === "number") out.timestamp = ts;

  const star = b(f.get(2)?.[0]);
  if (star) out.starAction = { starred: decodeBoolMsg(star, 1) };

  const contact = b(f.get(3)?.[0]);
  if (contact) {
    const cf = new Reader(contact).fields();
    out.contactAction = {
      fullName: s(cf.get(1)?.[0]),
      firstName: s(cf.get(2)?.[0]),
      lidJid: s(cf.get(3)?.[0]),
    };
  }

  const mute = b(f.get(4)?.[0]);
  if (mute) {
    const mf = new Reader(mute).fields();
    out.muteAction = {
      muted: typeof mf.get(1)?.[0] === "number" ? mf.get(1)![0] !== 0 : undefined,
      muteEndTimestamp: n(mf.get(2)?.[0]),
    };
  }

  const pin = b(f.get(5)?.[0]);
  if (pin) out.pinAction = { pinned: decodeBoolMsg(pin, 1) };

  const pushName = b(f.get(7)?.[0]);
  if (pushName) out.pushNameSetting = { name: s(new Reader(pushName).fields().get(1)?.[0]) };

  const archive = b(f.get(14)?.[0]);
  if (archive) out.archiveChatAction = { archived: decodeBoolMsg(archive, 1) };

  const delForMe = b(f.get(15)?.[0]);
  if (delForMe) {
    const df = new Reader(delForMe).fields();
    out.deleteMessageForMeAction = {
      deleteMedia: typeof df.get(1)?.[0] === "number" ? df.get(1)![0] !== 0 : undefined,
      messageTimestamp: n(df.get(2)?.[0]),
    };
  }

  const markRead = b(f.get(17)?.[0]);
  if (markRead) out.markChatAsReadAction = { read: decodeBoolMsg(markRead, 1) };

  if (b(f.get(19)?.[0])) out.deleteChatAction = {};

  return out;
}

export function decodeSyncActionData(buf: Uint8Array): SyncActionData {
  const f = new Reader(buf).fields();
  const val = b(f.get(2)?.[0]);
  return {
    index: b(f.get(1)?.[0]),
    value: val ? decodeSyncActionValue(val) : undefined,
    padding: b(f.get(3)?.[0]),
    version: n(f.get(4)?.[0]),
  };
}

// ---- encode (caminho de envio: push name; ganchos p/ mute/pin/etc) ----

export interface SyncActionValueInput {
  timestamp: number;
  pushNameSetting?: { name: string };
  muteAction?: { muted: boolean; muteEndTimestamp?: number };
  pinAction?: { pinned: boolean };
  archiveChatAction?: { archived: boolean };
  markChatAsReadAction?: { read: boolean };
}

export function encodeSyncActionValue(v: SyncActionValueInput): Uint8Array {
  const w = new Writer();
  w.uint(1, v.timestamp);
  if (v.pushNameSetting) {
    w.message(7, new Writer().string(1, v.pushNameSetting.name));
  }
  if (v.muteAction) {
    const m = new Writer().boolF(1, v.muteAction.muted);
    if (v.muteAction.muteEndTimestamp) m.uint(2, v.muteAction.muteEndTimestamp);
    w.message(4, m);
  }
  if (v.pinAction) w.message(5, new Writer().boolF(1, v.pinAction.pinned));
  if (v.archiveChatAction) w.message(14, new Writer().boolF(1, v.archiveChatAction.archived));
  if (v.markChatAsReadAction) w.message(17, new Writer().boolF(1, v.markChatAsReadAction.read));
  return w.finish();
}

export function encodeSyncActionData(d: {
  index: Uint8Array;
  value: Uint8Array;
  padding?: Uint8Array;
  version?: number;
}): Uint8Array {
  const w = new Writer();
  w.bytes(1, d.index);
  w.bytes(2, d.value);
  w.bytes(3, d.padding ?? new Uint8Array(0));
  if (d.version !== undefined) w.uint(4, d.version);
  return w.finish();
}

export function encodeSyncdRecord(r: {
  indexBlob: Uint8Array;
  valueBlob: Uint8Array;
  keyId: Uint8Array;
}): Uint8Array {
  return new Writer()
    .message(1, new Writer().bytes(1, r.indexBlob))
    .message(2, new Writer().bytes(1, r.valueBlob))
    .message(3, new Writer().bytes(1, r.keyId))
    .finish();
}

export function encodeSyncdPatch(p: {
  version: number;
  keyId: Uint8Array;
  snapshotMac: Uint8Array;
  patchMac: Uint8Array;
  mutations: Array<{ operation: number; indexBlob: Uint8Array; valueBlob: Uint8Array; keyId: Uint8Array }>;
}): Uint8Array {
  const w = new Writer();
  w.message(1, new Writer().uintF(1, p.version));
  for (const m of p.mutations) {
    const mut = new Writer();
    mut.uint(1, m.operation); // 0 (SET) é omitido, como no proto
    mut.bytes(
      2,
      encodeSyncdRecord({ indexBlob: m.indexBlob, valueBlob: m.valueBlob, keyId: m.keyId }),
    );
    w.message(2, mut);
  }
  w.bytes(5, p.snapshotMac);
  w.bytes(6, p.patchMac);
  w.message(7, new Writer().bytes(1, p.keyId));
  return w.finish();
}

// ---- AppStateSyncKeyShare (vem no protocolMessage) ------------------

export interface AppStateSyncKey {
  keyId?: Uint8Array;
  keyData?: Uint8Array;
  timestamp?: number;
}

export function decodeAppStateSyncKeyShare(buf: Uint8Array): AppStateSyncKey[] {
  const f = new Reader(buf).fields();
  return (f.get(1) ?? []).map((raw) => {
    const kf = new Reader(raw as Uint8Array).fields();
    const keyId = b(kf.get(1)?.[0]);
    const keyData = b(kf.get(2)?.[0]);
    const out: AppStateSyncKey = {};
    if (keyId) out.keyId = b(new Reader(keyId).fields().get(1)?.[0]);
    if (keyData) {
      const df = new Reader(keyData).fields();
      out.keyData = b(df.get(1)?.[0]);
      out.timestamp = n(df.get(3)?.[0]);
    }
    return out;
  });
}

export function encodeAppStateSyncKeyRequest(keyIds: Uint8Array[]): Uint8Array {
  const w = new Writer();
  for (const id of keyIds) {
    w.message(1, new Writer().message(1, new Writer().bytes(1, id)));
  }
  return w.finish();
}
