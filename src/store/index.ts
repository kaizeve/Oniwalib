// Store em memória — o que a comunidade mais reclamou de ter sumido na Baileys
// v7 (`makeInMemoryStore`). Liga-se aos eventos da oni e mantém chats, contatos,
// mensagens, presença e metadata de grupo consultáveis. Serializa/reidrata pra
// persistir num arquivo.
//
//   const store = makeInMemoryStore();
//   store.bind(conn.events);
//   ...
//   store.chats.get("55...@s.whatsapp.net")
//   store.loadMessage("55...@s.whatsapp.net", "3EB0...")
//   fs.writeFileSync("store.json", JSON.stringify(store.toJSON()));
//
// NÃO é pra produção com histórico gigante (guardar tudo em RAM é desperdício —
// o próprio README da Baileys avisa). É a conveniência de DX pra bots pequenos e
// pra desenvolvimento.

import type { Emitter, MessageKey, PresenceData } from "../events/emitter";
import type { HistoryChat } from "../history";
import type { GroupMetadata } from "../groups";

export interface StoreChat {
  id: string;
  name?: string;
  unreadCount?: number;
  archived?: boolean;
  pinned?: number | null;
  muteEndTime?: number | null;
  conversationTimestamp?: number;
  readOnly?: boolean;
  ephemeralExpiration?: number;
}

export interface StoreContact {
  id: string;
  name?: string;
  notify?: string;
  /** recado (about/bio), se um `contacts.update` trouxe. */
  status?: string;
  imgUrl?: string;
}

export interface StoreMessage {
  key: MessageKey;
  message?: unknown;
  messageTimestamp?: number;
  pushName?: string;
}

export interface InMemoryStore {
  chats: Map<string, StoreChat>;
  contacts: Map<string, StoreContact>;
  /** jid → (id da mensagem → mensagem). */
  messages: Map<string, Map<string, StoreMessage>>;
  presences: Map<string, Record<string, PresenceData>>;
  groupMetadata: Map<string, GroupMetadata>;

  /** Assina os eventos de uma conexão. Devolve uma função pra desassinar. */
  bind(events: Emitter): () => void;
  /** Última mensagem conhecida de um chat com aquele id. */
  loadMessage(jid: string, id: string): StoreMessage | undefined;
  /** As `n` mensagens mais recentes de um chat (ordem crescente de tempo). */
  recentMessages(jid: string, n?: number): StoreMessage[];
  /** Injeta um resolvedor de metadata de grupo — o store cacheia o resultado e
   *  o mantém fresco com `groups.update` / `group-participants.update`. */
  fetchGroupMetadata(jid: string, fetcher: (jid: string) => Promise<GroupMetadata>): Promise<GroupMetadata>;

  toJSON(): StoreSnapshot;
  fromJSON(snap: StoreSnapshot): void;
}

export interface StoreSnapshot {
  chats: StoreChat[];
  contacts: StoreContact[];
  messages: Array<{ jid: string; items: StoreMessage[] }>;
}

function fromHistoryChat(h: HistoryChat): StoreChat {
  return {
    id: h.id,
    name: h.name ?? h.displayName,
    unreadCount: h.unreadCount,
    archived: h.archived,
    pinned: h.pinned && h.pinned > 0 ? h.pinned : null,
    muteEndTime: h.muteEndTime && h.muteEndTime > 0 ? h.muteEndTime : null,
    conversationTimestamp: h.conversationTimestamp,
    readOnly: h.readOnly,
    ephemeralExpiration: h.ephemeralExpiration,
  };
}

export function makeInMemoryStore(): InMemoryStore {
  const chats = new Map<string, StoreChat>();
  const contacts = new Map<string, StoreContact>();
  const messages = new Map<string, Map<string, StoreMessage>>();
  const presences = new Map<string, Record<string, PresenceData>>();
  const groupMetadata = new Map<string, GroupMetadata>();

  const chatBucket = (jid: string): Map<string, StoreMessage> => {
    let b = messages.get(jid);
    if (!b) messages.set(jid, (b = new Map()));
    return b;
  };
  const upsertContact = (c: Partial<StoreContact> & { id: string }): void => {
    const prev = contacts.get(c.id);
    contacts.set(c.id, { ...(prev ?? { id: c.id }), ...c });
  };
  const upsertChat = (c: Partial<StoreChat> & { id: string }): void => {
    const prev = chats.get(c.id);
    chats.set(c.id, { ...(prev ?? { id: c.id }), ...c });
  };

  function bind(events: Emitter): () => void {
    const offs: Array<() => void> = [];

    offs.push(
      events.on("messaging-history.set", ({ chats: hc, contacts: hcont, messages: hmsgs }) => {
        for (const ch of hc) upsertChat(fromHistoryChat(ch));
        for (const ct of hcont) upsertContact({ id: ct.id, notify: ct.notify });
        for (const m of hmsgs ?? []) {
          const jid = m.key?.remoteJid;
          if (!jid || !m.key?.id) continue;
          chatBucket(jid).set(m.key.id, {
            key: m.key as MessageKey,
            message: m.message,
            messageTimestamp: m.messageTimestamp,
            pushName: m.pushName,
          });
        }
      }),
    );
    offs.push(
      events.on("chats.update", (updates) => {
        for (const u of updates) upsertChat(u as StoreChat);
      }),
    );
    offs.push(
      events.on("chats.delete", (ids) => {
        for (const id of ids) {
          chats.delete(id);
          messages.delete(id);
        }
      }),
    );
    offs.push(
      events.on("contacts.upsert", (list) => {
        for (const c of list) upsertContact({ id: c.id, name: c.name, notify: c.notify });
      }),
    );
    offs.push(
      events.on("contacts.update", (list) => {
        for (const c of list) {
          const patch: Partial<StoreContact> & { id: string } = { id: c.id };
          if (c.name !== undefined) patch.name = c.name;
          if (c.status !== undefined) patch.status = c.status;
          if (c.imgUrl === "removed") patch.imgUrl = undefined;
          upsertContact(patch);
        }
      }),
    );
    offs.push(
      events.on("messages.upsert", ({ messages: msgs }) => {
        for (const m of msgs) {
          if (!m.key.remoteJid || !m.key.id) continue;
          chatBucket(m.key.remoteJid).set(m.key.id, {
            key: m.key,
            message: m.message,
            messageTimestamp: m.messageTimestamp,
            pushName: m.pushName,
          });
          upsertChat({
            id: m.key.remoteJid,
            conversationTimestamp: m.messageTimestamp,
          });
          if (m.pushName && m.key.participant) {
            upsertContact({ id: m.key.participant, notify: m.pushName });
          } else if (m.pushName && !m.key.fromMe) {
            upsertContact({ id: m.key.remoteJid, notify: m.pushName });
          }
        }
      }),
    );
    offs.push(
      events.on("messages.update", (updates) => {
        for (const u of updates) {
          if (!u.key.remoteJid || !u.key.id) continue;
          const b = messages.get(u.key.remoteJid);
          const prev = b?.get(u.key.id);
          if (prev && u.update.message) prev.message = u.update.message;
        }
      }),
    );
    offs.push(
      events.on("messages.delete", ({ keys }) => {
        for (const k of keys) {
          if (k.remoteJid && k.id) messages.get(k.remoteJid)?.delete(k.id);
        }
      }),
    );
    offs.push(
      events.on("presence.update", ({ id, presences: p }) => {
        presences.set(id, { ...(presences.get(id) ?? {}), ...p });
      }),
    );
    offs.push(
      events.on("groups.update", (updates) => {
        for (const u of updates) {
          const prev = groupMetadata.get(u.id);
          if (prev) groupMetadata.set(u.id, { ...prev, ...(u as Partial<GroupMetadata>) });
        }
      }),
    );
    offs.push(
      events.on("group-participants.update", ({ id }) => {
        // a composição mudou → invalida o cache; quem quiser refetch chama
        // fetchGroupMetadata de novo
        groupMetadata.delete(id);
      }),
    );

    return () => {
      for (const off of offs) off();
    };
  }

  function loadMessage(jid: string, id: string): StoreMessage | undefined {
    return messages.get(jid)?.get(id);
  }

  function recentMessages(jid: string, n = 25): StoreMessage[] {
    const b = messages.get(jid);
    if (!b) return [];
    return [...b.values()]
      .sort((a, c) => (a.messageTimestamp ?? 0) - (c.messageTimestamp ?? 0))
      .slice(-n);
  }

  async function fetchGroupMetadata(
    jid: string,
    fetcher: (jid: string) => Promise<GroupMetadata>,
  ): Promise<GroupMetadata> {
    const hit = groupMetadata.get(jid);
    if (hit) return hit;
    const meta = await fetcher(jid);
    groupMetadata.set(jid, meta);
    return meta;
  }

  function toJSON(): StoreSnapshot {
    return {
      chats: [...chats.values()],
      contacts: [...contacts.values()],
      messages: [...messages.entries()].map(([jid, b]) => ({ jid, items: [...b.values()] })),
    };
  }
  function fromJSON(snap: StoreSnapshot): void {
    for (const c of snap.chats ?? []) chats.set(c.id, c);
    for (const c of snap.contacts ?? []) contacts.set(c.id, c);
    for (const { jid, items } of snap.messages ?? []) {
      const b = chatBucket(jid);
      for (const it of items) if (it.key.id) b.set(it.key.id, it);
    }
  }

  return {
    chats,
    contacts,
    messages,
    presences,
    groupMetadata,
    bind,
    loadMessage,
    recentMessages,
    fetchGroupMetadata,
    toJSON,
    fromJSON,
  };
}
