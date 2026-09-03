// App-state sync — decodifica (e monta) os patches LT-hash do WhatsApp
// Multi-Device. Porte fiel do `@whiskeysockets/baileys` `src/Utils/chat-utils.ts`
// (6.x, quando ainda era JS puro). Cobre:
//
//   - fetch/decode de patches e snapshots (`w:sync:app:state`)
//   - verificação de MAC (valueMac HMAC-SHA512, snapshotMac/patchMac HMAC-SHA256,
//     LT-hash "WhatsApp Patch Integrity") — se a nossa cripto estiver errada, o
//     decode LANÇA (não é silencioso no caminho de leitura)
//   - aplicação das mutações → eventos (`contacts.upsert`, `chats.update`,
//     `creds.update` com push name, …)
//   - `encodeSyncdPatch` para o caminho de envio (push name via
//     `chatModificationToAppPatch`)

import type { Crypto } from "../crypto/types";
import { b64, b64decode } from "../auth/state";
import { utf8Encode, utf8Decode } from "../frame/buffer";
import { getBinaryNodeChild, getBinaryNodeChildren, type BinaryNode } from "../frame/node";
import { makeLtHash, type LtHash } from "./lt-hash";
import {
  concat,
  generateMac,
  generatePatchMac,
  generateSnapshotMac,
  mutationKeys,
  SET,
  REMOVE,
  type MutationKeys,
} from "./mac";
import {
  decodeExternalBlobReference,
  decodeSyncActionData,
  decodeSyncdMutationsBlob,
  decodeSyncdPatch as protoDecodePatch,
  decodeSyncdSnapshot as protoDecodeSnapshot,
  encodeSyncActionData,
  encodeSyncActionValue,
  encodeSyncdPatch as protoEncodePatch,
  type ExternalBlobReference,
  type SyncActionValue,
  type SyncActionValueInput,
  type SyncdMutation,
  type SyncdRecord,
} from "./proto";

export type WAPatchName =
  | "critical_block"
  | "critical_unblock_low"
  | "regular_high"
  | "regular_low"
  | "regular";

export const ALL_PATCH_NAMES: WAPatchName[] = [
  "critical_block",
  "critical_unblock_low",
  "regular_high",
  "regular_low",
  "regular",
];

export interface LTHashState {
  version: number;
  hash: Uint8Array;
  /** indexMac (base64) → { valueMac } */
  indexValueMap: Record<string, { valueMac: Uint8Array }>;
}

export function newLTHashState(): LTHashState {
  return { version: 0, hash: new Uint8Array(128), indexValueMap: {} };
}

export interface ChatMutation {
  syncAction: { value?: SyncActionValue; timestamp?: number };
  /** o índice já parseado do JSON: ex. `["mute", jid]`, `["setting_pushName"]` */
  index: string[];
}

export type FetchAppStateSyncKey = (
  keyIdBase64: string,
) => Uint8Array | undefined | Promise<Uint8Array | undefined>;

export type DownloadExternalBlob = (
  ref: ExternalBlobReference,
) => Promise<Uint8Array>;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

// --- gerador de LT-hash incremental (Baileys makeLtHashGenerator) --------

interface Mac {
  indexMac: Uint8Array;
  valueMac: Uint8Array;
  operation: number; // SET | REMOVE (constantes do mac.ts: 1 | 2)
}

function makeLtHashGenerator(
  init: Pick<LTHashState, "hash" | "indexValueMap">,
  lt: LtHash,
) {
  const indexValueMap: Record<string, { valueMac: Uint8Array }> = {
    ...init.indexValueMap,
  };
  const addBuffs: Uint8Array[] = [];
  const subBuffs: Uint8Array[] = [];

  return {
    mix({ indexMac, valueMac, operation }: Mac): void {
      const key = b64(indexMac);
      const prev = indexValueMap[key];
      if (operation === REMOVE) {
        if (!prev) {
          // WA Web só loga e segue; a falta vira mismatch de LTHash, tratado
          // pela camada de MAC (recuperação por snapshot).
          return;
        }
        delete indexValueMap[key];
      } else {
        addBuffs.push(valueMac);
        indexValueMap[key] = { valueMac };
      }
      if (prev) subBuffs.push(prev.valueMac);
    },
    finish(): { hash: Uint8Array; indexValueMap: Record<string, { valueMac: Uint8Array }> } {
      const hash = lt.subtractThenAdd(init.hash, subBuffs, addBuffs);
      return { hash, indexValueMap };
    },
  };
}

// --- decode -----------------------------------------------------------

interface Deps {
  crypto: Crypto;
  getKey: FetchAppStateSyncKey;
}

async function keysFor(d: Deps, keyId: Uint8Array): Promise<MutationKeys> {
  const base64 = b64(keyId);
  const keyData = await d.getKey(base64);
  if (!keyData) throw new Error(`appstate: chave "${base64}" não encontrada p/ decodificar mutação`);
  return mutationKeys(d.crypto, keyData);
}

export async function decodeSyncdMutations(
  d: Deps,
  lt: LtHash,
  mutations: SyncdMutation[],
  initialState: LTHashState,
  onMutation: (m: ChatMutation) => void,
  validateMacs: boolean,
): Promise<{ hash: Uint8Array; indexValueMap: Record<string, { valueMac: Uint8Array }> }> {
  const gen = makeLtHashGenerator(initialState, lt);

  for (const msg of mutations) {
    const operationRaw = msg.operation ?? 0; // proto enum: 0 SET, 1 REMOVE
    const op = operationRaw === 1 ? REMOVE : SET;
    const record = (msg.record ?? (msg as unknown as SyncdRecord)) as SyncdRecord;
    if (!record.value?.blob || !record.index?.blob || !record.keyId?.id) {
      throw new Error("appstate: SyncdRecord incompleto");
    }
    const keys = await keysFor(d, record.keyId.id);

    const content = record.value.blob;
    const encContent = content.slice(0, content.length - 32);
    const valueMac = content.slice(content.length - 32);

    if (validateMacs) {
      const expect = generateMac(d.crypto, op, encContent, record.keyId.id, keys.valueMacKey);
      if (!bytesEqual(expect, valueMac)) throw new Error("appstate: valueMac inválido");
    }

    const iv = encContent.slice(0, 16);
    const ct = encContent.slice(16);
    const plain = d.crypto.aesCbcDecrypt(keys.valueEncryptionKey, iv, ct);
    const actionData = decodeSyncActionData(plain);

    if (validateMacs && actionData.index) {
      const idxMac = d.crypto.hmacSha256(keys.indexKey, actionData.index);
      if (!bytesEqual(idxMac, record.index.blob)) throw new Error("appstate: indexMac inválido");
    }

    let index: string[] = [];
    if (actionData.index) {
      try {
        const parsed = JSON.parse(utf8Decode(actionData.index));
        if (Array.isArray(parsed)) index = parsed.map((x) => String(x));
      } catch {
        /* índice não-JSON — deixa vazio */
      }
    }
    onMutation({
      syncAction: { value: actionData.value, timestamp: actionData.value?.timestamp },
      index,
    });

    gen.mix({ indexMac: record.index.blob, valueMac, operation: op });
  }

  return gen.finish();
}

export async function decodeSyncdPatch(
  d: Deps,
  lt: LtHash,
  patch: import("./proto").SyncdPatch,
  name: WAPatchName,
  initialState: LTHashState,
  onMutation: (m: ChatMutation) => void,
  validateMacs: boolean,
): Promise<{ state: LTHashState }> {
  const version = patch.version?.version ?? initialState.version + 1;

  if (validateMacs && patch.keyId?.id) {
    const keyData = await d.getKey(b64(patch.keyId.id));
    if (!keyData) throw new Error("appstate: chave do patch não encontrada");
    const keys = mutationKeys(d.crypto, keyData);
    const valueMacs = patch.mutations.map((m) => {
      const blob = m.record?.value?.blob;
      if (!blob) throw new Error("appstate: mutação sem value.blob");
      return blob.slice(blob.length - 32);
    });
    const patchMac = generatePatchMac(
      d.crypto,
      patch.snapshotMac!,
      valueMacs,
      version,
      name,
      keys.patchMacKey,
    );
    if (!patch.patchMac || !bytesEqual(patchMac, patch.patchMac)) {
      throw new Error("appstate: patchMac inválido");
    }
  }

  const { hash, indexValueMap } = await decodeSyncdMutations(
    d,
    lt,
    patch.mutations,
    initialState,
    onMutation,
    validateMacs,
  );

  const state: LTHashState = { version, hash, indexValueMap };

  if (validateMacs && patch.keyId?.id && patch.snapshotMac) {
    const keyData = await d.getKey(b64(patch.keyId.id));
    const keys = mutationKeys(d.crypto, keyData!);
    const snap = generateSnapshotMac(d.crypto, hash, version, name, keys.snapshotMacKey);
    if (!bytesEqual(snap, patch.snapshotMac)) {
      throw new Error(`appstate: LTHash não confere na versão ${version} de ${name}`);
    }
  }

  return { state };
}

export async function decodeSyncdSnapshot(
  d: Deps,
  lt: LtHash,
  name: WAPatchName,
  snapshotBuf: Uint8Array,
  minimumVersionNumber: number | undefined,
  validateMacs: boolean,
): Promise<{ state: LTHashState; mutationMap: Record<string, ChatMutation> }> {
  const snapshot = protoDecodeSnapshot(snapshotBuf);
  const state = newLTHashState();
  state.version = snapshot.version?.version ?? 0;

  const mutationMap: Record<string, ChatMutation> = {};
  const wantMutations =
    minimumVersionNumber === undefined || state.version > minimumVersionNumber;

  const asMutations: SyncdMutation[] = snapshot.records.map((r): SyncdMutation => ({ operation: 0, record: r }));
  const { hash, indexValueMap } = await decodeSyncdMutations(
    d,
    lt,
    asMutations,
    state,
    wantMutations
      ? (m) => {
          if (m.index.length) mutationMap[JSON.stringify(m.index)] = m;
        }
      : () => {},
    validateMacs,
  );
  state.hash = hash;
  state.indexValueMap = indexValueMap;

  if (validateMacs && snapshot.keyId?.id && snapshot.mac) {
    const keyData = await d.getKey(b64(snapshot.keyId.id));
    if (!keyData) throw new Error("appstate: chave do snapshot não encontrada");
    const keys = mutationKeys(d.crypto, keyData);
    const computed = generateSnapshotMac(d.crypto, state.hash, state.version, name, keys.snapshotMacKey);
    if (!bytesEqual(computed, snapshot.mac)) {
      throw new Error(`appstate: LTHash do snapshot não confere na versão ${state.version} de ${name}`);
    }
  }

  return { state, mutationMap };
}

export interface CollectionPatches {
  name: WAPatchName;
  patches: Uint8Array[];
  hasMorePatches: boolean;
  snapshot?: Uint8Array;
  version: number;
}

/** Parseia `<iq><sync><collection name version has_more_patches>` de um
 *  `w:sync:app:state`. Baixa o snapshot externo se houver. */
export async function extractSyncdPatches(
  result: BinaryNode,
  downloadBlob: DownloadExternalBlob,
): Promise<Record<string, CollectionPatches>> {
  const sync = getBinaryNodeChild(result, "sync");
  const collections = getBinaryNodeChildren(sync, "collection");
  const out: Record<string, CollectionPatches> = {};

  for (const col of collections) {
    const name = col.attrs.name as WAPatchName;
    const version = Number(col.attrs.version ?? "0");
    const hasMorePatches = col.attrs.has_more_patches === "true";
    const patchesNode = getBinaryNodeChild(col, "patches") ?? col;
    const patches = getBinaryNodeChildren(patchesNode, "patch")
      .map((p) => (p.content instanceof Uint8Array ? p.content : undefined))
      .filter((x): x is Uint8Array => !!x);

    let snapshot: Uint8Array | undefined;
    const snapNode = getBinaryNodeChild(col, "snapshot");
    if (snapNode?.content instanceof Uint8Array) {
      const ref = decodeExternalBlobReference(snapNode.content);
      snapshot = await downloadBlob(ref);
    }

    out[name] = { name, patches, hasMorePatches, snapshot, version };
  }
  return out;
}

/** Aplica uma coleção de patches (já extraídos) sobre um estado inicial. */
export async function decodePatches(
  d: Deps,
  lt: LtHash,
  name: WAPatchName,
  patches: Uint8Array[],
  initial: LTHashState,
  downloadBlob: DownloadExternalBlob,
  minimumVersionNumber: number | undefined,
  validateMacs = true,
): Promise<{ state: LTHashState; mutationMap: Record<string, ChatMutation> }> {
  let state: LTHashState = {
    version: initial.version,
    hash: initial.hash,
    indexValueMap: { ...initial.indexValueMap },
  };
  const mutationMap: Record<string, ChatMutation> = {};

  for (const patchBuf of patches) {
    const patch = protoDecodePatch(patchBuf);
    if (patch.externalMutations) {
      const blob = await downloadBlob(patch.externalMutations);
      patch.mutations = patch.mutations.concat(decodeSyncdMutationsBlob(blob));
    }
    const version = patch.version?.version ?? state.version + 1;
    const shouldMutate =
      minimumVersionNumber === undefined || version > minimumVersionNumber;

    const { state: next } = await decodeSyncdPatch(
      d,
      lt,
      patch,
      name,
      state,
      shouldMutate
        ? (m) => {
            if (m.index.length) mutationMap[JSON.stringify(m.index)] = m;
          }
        : () => {},
      validateMacs,
    );
    state = next;
  }

  return { state, mutationMap };
}

// --- encode (envio) --------------------------------------------------

export interface WAPatchCreate {
  syncAction: SyncActionValueInput;
  index: string[];
  type: WAPatchName;
  apiVersion: number;
  operation: number; // SET (1) | REMOVE (2) — constantes do mac.ts
}

/** Monta um `SyncdPatch` pronto p/ subir e devolve o novo `LTHashState`. */
export async function encodeSyncdPatch(
  d: Deps,
  lt: LtHash,
  create: WAPatchCreate,
  myAppStateKeyIdBase64: string,
  state: LTHashState,
): Promise<{ patch: Uint8Array; state: LTHashState; collection: WAPatchName }> {
  const keyData = await d.getKey(myAppStateKeyIdBase64);
  if (!keyData) throw new Error(`appstate: minha chave "${myAppStateKeyIdBase64}" ausente`);
  const encKeyId = b64decode(myAppStateKeyIdBase64);
  const keys = mutationKeys(d.crypto, keyData);

  const next: LTHashState = {
    version: state.version,
    hash: state.hash,
    indexValueMap: { ...state.indexValueMap },
  };

  const indexBuffer = utf8Encode(JSON.stringify(create.index));
  const encoded = encodeSyncActionData({
    index: indexBuffer,
    value: encodeSyncActionValue(create.syncAction),
    padding: new Uint8Array(0),
    version: create.apiVersion,
  });

  const iv = d.crypto.randomBytes(16);
  const ct = d.crypto.aesCbcEncrypt(keys.valueEncryptionKey, iv, encoded);
  const encValue = concat(iv, ct);
  const valueMac = generateMac(d.crypto, create.operation, encValue, encKeyId, keys.valueMacKey);
  const indexMac = d.crypto.hmacSha256(keys.indexKey, indexBuffer);

  const gen = makeLtHashGenerator(next, lt);
  gen.mix({ indexMac, valueMac, operation: create.operation });
  const fin = gen.finish();
  next.hash = fin.hash;
  next.indexValueMap = fin.indexValueMap;
  next.version = state.version + 1;

  const snapshotMac = generateSnapshotMac(d.crypto, next.hash, next.version, create.type, keys.snapshotMacKey);
  const patchMac = generatePatchMac(
    d.crypto,
    snapshotMac,
    [valueMac],
    next.version,
    create.type,
    keys.patchMacKey,
  );

  const patch = protoEncodePatch({
    version: next.version,
    keyId: encKeyId,
    snapshotMac,
    patchMac,
    mutations: [
      {
        operation: create.operation === REMOVE ? 1 : 0,
        indexBlob: indexMac,
        valueBlob: concat(encValue, valueMac),
        keyId: encKeyId,
      },
    ],
  });

  next.indexValueMap[b64(indexMac)] = { valueMac };
  return { patch, state: next, collection: create.type };
}

// --- chatModification → patch (subconjunto) -------------------------

export type ChatModification =
  | { pushNameSetting: string }
  | { mute: number | null }
  | { pin: boolean }
  | { archive: boolean }
  | { markRead: boolean }
  | { addChatLabel: { labelId: string } }
  | { removeChatLabel: { labelId: string } };

/** LabelAssociationType.Chat na Baileys (`Types/LabelAssociation`). */
const LABEL_JID = "label_jid";

export function chatModificationToAppPatch(
  mod: ChatModification,
  jid: string,
): WAPatchCreate {
  const now = Date.now();
  if ("pushNameSetting" in mod) {
    return {
      syncAction: { timestamp: now, pushNameSetting: { name: mod.pushNameSetting } },
      index: ["setting_pushName"],
      type: "critical_block",
      apiVersion: 1,
      operation: SET,
    };
  }
  if ("mute" in mod) {
    return {
      syncAction: {
        timestamp: now,
        muteAction: { muted: !!mod.mute, muteEndTimestamp: mod.mute || undefined },
      },
      index: ["mute", jid],
      type: "regular_high",
      apiVersion: 2,
      operation: SET,
    };
  }
  if ("pin" in mod) {
    return {
      syncAction: { timestamp: now, pinAction: { pinned: !!mod.pin } },
      index: ["pin_v1", jid],
      type: "regular_low",
      apiVersion: 5,
      operation: SET,
    };
  }
  if ("archive" in mod) {
    return {
      syncAction: { timestamp: now, archiveChatAction: { archived: !!mod.archive } },
      index: ["archive", jid],
      type: "regular_low",
      apiVersion: 3,
      operation: SET,
    };
  }
  if ("addChatLabel" in mod || "removeChatLabel" in mod) {
    const labeled = "addChatLabel" in mod;
    const labelId = labeled ? mod.addChatLabel.labelId : mod.removeChatLabel.labelId;
    return {
      syncAction: { timestamp: now, labelAssociationAction: { labeled } },
      index: [LABEL_JID, labelId, jid],
      type: "regular",
      apiVersion: 3,
      operation: SET,
    };
  }
  return {
    syncAction: { timestamp: now, markChatAsReadAction: { read: !!mod.markRead } },
    index: ["markChatAsRead", jid],
    type: "regular_low",
    apiVersion: 3,
    operation: SET,
  };
}

export { makeLtHash } from "./lt-hash";
export type { LtHash } from "./lt-hash";
export type { SyncActionValue, ExternalBlobReference } from "./proto";
export { decodeAppStateSyncKeyShare } from "./proto";
export type { AppStateSyncKey } from "./proto";
