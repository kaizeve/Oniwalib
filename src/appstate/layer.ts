// App-state sync — camada de cliente: cola o núcleo (`./index`) ao socket, ao
// cofre de chaves e aos eventos. Espelha, no essencial, o `resyncAppState` /
// `appPatch` do `@whiskeysockets/baileys`.
//
//   ingestKeys()        guarda as chaves-mestras vindas do protocolMessage
//   resync()            <iq w:sync:app:state> → baixa patches/snapshot, decode,
//                       aplica mutações → eventos, persiste o LTHashState
//   pushPatch()         monta um patch (encodeSyncdPatch) e sobe
//   updateProfileName() atalho: push name (coleção critical_block)
//   chatModify()        atalho: mute / pin / archive / markRead

import type { Crypto } from "../crypto/types";
import type { Emitter } from "../events/emitter";
import type { AuthCreds, SignalKeyStore } from "../auth/state";
import { b64 } from "../auth/state";
import { node, type BinaryNode } from "../frame/node";
import {
  ALL_PATCH_NAMES,
  chatModificationToAppPatch,
  decodePatches,
  decodeSyncdSnapshot,
  encodeSyncdPatch,
  extractSyncdPatches,
  makeLtHash,
  newLTHashState,
  type ChatModification,
  type ChatMutation,
  type DownloadExternalBlob,
  type LTHashState,
  type LtHash,
  type WAPatchCreate,
  type WAPatchName,
} from "./index";

const S_WHATSAPP_NET = "@s.whatsapp.net";

export interface AppStateLayerOptions {
  query: (n: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>;
  keys: SignalKeyStore;
  crypto: Crypto;
  events: Emitter;
  creds: AuthCreds;
  saveCreds?: () => void | Promise<void>;
  downloadBlob: DownloadExternalBlob;
}

export interface AppStateLayer {
  ingestKeys(
    share: Array<{ keyId: Uint8Array; keyData: Uint8Array; timestamp?: number }>,
  ): Promise<void>;
  hasKeys(): boolean;
  /** Sincroniza as coleções pedidas (todas por padrão). Nunca lança — loga e
   *  segue; o caminho de leitura já verifica MAC internamente. */
  resync(names?: WAPatchName[]): Promise<void>;
  pushPatch(create: WAPatchCreate): Promise<void>;
  updateProfileName(name: string): Promise<void>;
  chatModify(mod: ChatModification, jid: string): Promise<void>;
}

export function createAppStateLayer(o: AppStateLayerOptions): AppStateLayer {
  const { query, keys, crypto: c, events, creds } = o;
  const lt: LtHash = makeLtHash(c);

  const getKey = async (idB64: string): Promise<Uint8Array | undefined> => {
    const { [idB64]: v } = await keys.get("app-state-sync-key", [idB64]);
    const rec = v as { keyData?: Uint8Array } | undefined;
    return rec?.keyData instanceof Uint8Array ? rec.keyData : undefined;
  };
  const deps = { crypto: c, getKey };

  async function ingestKeys(
    share: Array<{ keyId: Uint8Array; keyData: Uint8Array; timestamp?: number }>,
  ): Promise<void> {
    if (!share.length) return;
    const batch: Record<string, unknown> = {};
    let newest = "";
    for (const k of share) {
      const id = b64(k.keyId);
      batch[id] = { keyData: k.keyData, timestamp: k.timestamp ?? 0 };
      newest = id;
    }
    await keys.set({ "app-state-sync-key": batch });
    if (newest && creds.myAppStateKeyId !== newest) {
      creds.myAppStateKeyId = newest;
      await Promise.resolve(o.saveCreds?.()).catch(() => {});
      events.emit("creds.update", { myAppStateKeyId: newest });
    }
    // eslint-disable-next-line no-console
    console.log(`appstate: ${share.length} chave(s) de sync guardada(s) (id ${newest.slice(0, 12)}…)`);
  }

  function hasKeys(): boolean {
    return typeof creds.myAppStateKeyId === "string" && creds.myAppStateKeyId.length > 0;
  }

  async function loadState(name: WAPatchName): Promise<LTHashState> {
    const { [name]: v } = await keys.get("app-state-sync-version", [name]);
    const raw = v as Partial<LTHashState> | undefined;
    if (
      raw &&
      typeof raw.version === "number" &&
      raw.hash instanceof Uint8Array &&
      raw.hash.length === 128
    ) {
      return {
        version: raw.version,
        hash: raw.hash,
        indexValueMap: (raw.indexValueMap as LTHashState["indexValueMap"]) ?? {},
      };
    }
    return newLTHashState();
  }

  async function saveState(name: WAPatchName, state: LTHashState): Promise<void> {
    await keys.set({ "app-state-sync-version": { [name]: state } });
  }

  function applyMutations(map: Record<string, ChatMutation>): void {
    for (const key of Object.keys(map)) {
      try {
        processSyncAction(map[key]!);
      } catch {
        /* uma mutação zoada não derruba o resto */
      }
    }
  }

  function processSyncAction(m: ChatMutation): void {
    const [type, id, msgId, fromMe] = m.index;
    const v = m.syncAction.value;
    if (!v) return;

    if (v.pushNameSetting?.name) {
      const name = v.pushNameSetting.name;
      const me = (creds.me ?? {}) as { id?: string; name?: string };
      if (me.name !== name) {
        creds.me = { ...me, name };
        void Promise.resolve(o.saveCreds?.()).catch(() => {});
        events.emit("creds.update", { me: creds.me });
      }
      return;
    }
    if (v.contactAction && id) {
      events.emit("contacts.upsert", [{ id, name: v.contactAction.fullName }]);
      return;
    }
    if (v.muteAction && id) {
      events.emit("chats.update", [
        {
          id,
          muteEndTime: v.muteAction.muted ? v.muteAction.muteEndTimestamp ?? null : null,
        },
      ]);
      return;
    }
    if (v.pinAction && id) {
      events.emit("chats.update", [
        { id, pinned: v.pinAction.pinned ? m.syncAction.timestamp ?? 1 : null },
      ]);
      return;
    }
    if ((v.archiveChatAction || type === "archive") && id) {
      events.emit("chats.update", [{ id, archived: !!v.archiveChatAction?.archived }]);
      return;
    }
    if (v.markChatAsReadAction && id) {
      events.emit("chats.update", [
        { id, unreadCount: v.markChatAsReadAction.read ? 0 : -1 },
      ]);
      return;
    }
    if ((v.deleteChatAction || type === "deleteChat") && id) {
      events.emit("chats.delete", [id]);
      return;
    }
    if ((v.deleteMessageForMeAction || type === "deleteMessageForMe") && id && msgId) {
      events.emit("messages.delete", {
        keys: [{ remoteJid: id, id: msgId, fromMe: fromMe === "1" }],
      });
      return;
    }
    if (v.labelEditAction) {
      events.emit("labels.edit", {
        id: id ?? "",
        name: v.labelEditAction.name,
        color: v.labelEditAction.color,
        deleted: v.labelEditAction.deleted,
        predefinedId: v.labelEditAction.predefinedId,
      });
      return;
    }
    if (v.labelAssociationAction) {
      // index: ["label_jid", labelId, chatJid]  (chat) ou
      //        ["label_message", labelId, chatJid, msgId, ...]  (mensagem)
      const [, labelId, chatId, messageId] = m.index;
      events.emit("labels.association", {
        type: v.labelAssociationAction.labeled ? "add" : "remove",
        labelId: labelId ?? "",
        chatId,
        messageId,
      });
    }
  }

  async function resync(names: WAPatchName[] = ALL_PATCH_NAMES): Promise<void> {
    if (!hasKeys()) {
      // eslint-disable-next-line no-console
      console.log("appstate: sem chaves de sync ainda — o device primário ainda não as mandou");
      return;
    }
    try {
      const states: Record<string, LTHashState> = {};
      for (const name of names) states[name] = await loadState(name);

      const collections = names.map((name) =>
        node("collection", {
          name,
          version: String(states[name]!.version),
          return_snapshot: states[name]!.version === 0 ? "true" : "false",
        }),
      );
      const res = await query(
        node("iq", { to: S_WHATSAPP_NET, xmlns: "w:sync:app:state", type: "set" }, [
          node("sync", {}, collections),
        ]),
      );

      const extracted = await extractSyncdPatches(res, o.downloadBlob);
      let more = false;

      for (const name of names) {
        const col = extracted[name];
        if (!col) continue;
        let state = states[name]!;

        if (col.snapshot) {
          const snap = await decodeSyncdSnapshot(
            deps,
            lt,
            name,
            col.snapshot,
            undefined,
            true,
          );
          state = snap.state;
          applyMutations(snap.mutationMap);
        }
        if (col.patches.length) {
          const dec = await decodePatches(
            deps,
            lt,
            name,
            col.patches,
            state,
            o.downloadBlob,
            state.version,
            true,
          );
          state = dec.state;
          applyMutations(dec.mutationMap);
        }
        await saveState(name, state);
        if (col.hasMorePatches) more = true;
      }

      if (more) await resync(names);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("appstate: resync falhou:", (e as Error).message);
    }
  }

  async function pushPatch(create: WAPatchCreate): Promise<void> {
    if (!hasKeys()) throw new Error("appstate: sem chave de sync — não dá pra enviar patch ainda");
    const name = create.type;
    const state = await loadState(name);
    const { patch, state: next } = await encodeSyncdPatch(
      deps,
      lt,
      create,
      creds.myAppStateKeyId!,
      state,
    );

    await query(
      node("iq", { to: S_WHATSAPP_NET, xmlns: "w:sync:app:state", type: "set" }, [
        node("sync", {}, [
          node(
            "collection",
            { name, version: String(next.version - 1), return_snapshot: "false" },
            [node("patch", {}, patch)],
          ),
        ]),
      ]),
    );

    await saveState(name, next);
    // reflete localmente na hora (o servidor não devolve o patch de volta)
    applyMutations({
      [JSON.stringify(create.index)]: {
        index: create.index,
        syncAction: { value: syncInputToValue(create), timestamp: create.syncAction.timestamp },
      },
    });
  }

  function syncInputToValue(create: WAPatchCreate): ChatMutation["syncAction"]["value"] {
    const s = create.syncAction;
    return {
      pushNameSetting: s.pushNameSetting,
      muteAction: s.muteAction,
      pinAction: s.pinAction,
      archiveChatAction: s.archiveChatAction,
      markChatAsReadAction: s.markChatAsReadAction,
      labelAssociationAction: s.labelAssociationAction,
      labelEditAction: s.labelEditAction,
      timestamp: s.timestamp,
    };
  }

  async function updateProfileName(name: string): Promise<void> {
    await pushPatch(chatModificationToAppPatch({ pushNameSetting: name }, ""));
  }

  async function chatModify(mod: ChatModification, jid: string): Promise<void> {
    await pushPatch(chatModificationToAppPatch(mod, jid));
  }

  return { ingestKeys, hasKeys, resync, pushPatch, updateProfileName, chatModify };
}
