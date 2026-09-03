// History sync — o device primário manda, num `protocolMessage`
// `historySyncNotification`, um ponteiro para um blob CIFRADO e COMPRIMIDO
// (`md-msg-hist`, HKDF info "WhatsApp History Keys", depois zlib-inflate) que
// contém um proto `HistorySync` gigante: conversas (chats), pushnames, mapa
// número↔lid, etc.
//
// A oniwalib decodifica um SUBCONJUNTO útil: dá pra montar a lista de chats
// (nome, não-lido, fixado, arquivado, mudo, timestamp) e o roster de nomes —
// sem portar o `WebMessageInfo` inteiro (a mensagem em si fica como contagem).
//
// Números de campo do WAProto (`message HistorySync` / `Conversation` /
// `Pushname` / `PhoneNumberToLIDMapping`), estáveis.

import { Reader } from "../proto/wire";

function s(v: number | Uint8Array | undefined): string | undefined {
  return v instanceof Uint8Array ? utf8(v) : undefined;
}
function n(v: number | Uint8Array | undefined): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function bool(v: number | Uint8Array | undefined): boolean {
  return typeof v === "number" && v !== 0;
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

export const HISTORY_SYNC_TYPE: Record<number, string> = {
  0: "INITIAL_BOOTSTRAP",
  1: "INITIAL_STATUS_V3",
  2: "FULL",
  3: "RECENT",
  4: "PUSH_NAME",
  5: "NON_BLOCKING_DATA",
  6: "ON_DEMAND",
};

export interface HistoryChat {
  id: string;
  name?: string;
  displayName?: string;
  /** número de mensagens que vieram nesta conversa (não decodificadas). */
  messageCount: number;
  unreadCount?: number;
  readOnly?: boolean;
  archived?: boolean;
  markedAsUnread?: boolean;
  /** `pinned` do WhatsApp é um número (ordem/época); >0 = fixado. */
  pinned?: number;
  muteEndTime?: number;
  conversationTimestamp?: number;
  lastMessageTimestamp?: number;
  ephemeralExpiration?: number;
  lidJid?: string;
  pnJid?: string;
  username?: string;
}

export interface HistorySyncResult {
  syncType?: number;
  syncTypeName?: string;
  progress?: number;
  chunkOrder?: number;
  chats: HistoryChat[];
  pushnames: Array<{ id: string; pushname?: string }>;
  lidMappings: Array<{ pn: string; lid: string }>;
}

function decodeConversation(buf: Uint8Array): HistoryChat {
  const f = new Reader(buf).fields();
  return {
    id: s(f.get(1)?.[0]) ?? "",
    messageCount: (f.get(2) ?? []).length,
    lastMessageTimestamp: n(f.get(5)?.[0]),
    unreadCount: n(f.get(6)?.[0]),
    readOnly: bool(f.get(7)?.[0]),
    ephemeralExpiration: n(f.get(9)?.[0]),
    conversationTimestamp: n(f.get(12)?.[0]),
    name: s(f.get(13)?.[0]),
    archived: bool(f.get(16)?.[0]),
    markedAsUnread: bool(f.get(19)?.[0]),
    pinned: n(f.get(24)?.[0]),
    muteEndTime: n(f.get(25)?.[0]),
    displayName: s(f.get(38)?.[0]),
    pnJid: s(f.get(39)?.[0]),
    lidJid: s(f.get(42)?.[0]),
    username: s(f.get(43)?.[0]),
  };
}

/** Decodifica um blob `HistorySync` JÁ descomprimido (zlib-inflate feito antes). */
export function decodeHistorySync(buf: Uint8Array): HistorySyncResult {
  const f = new Reader(buf).fields();
  const syncType = n(f.get(1)?.[0]);
  return {
    syncType,
    syncTypeName: syncType !== undefined ? HISTORY_SYNC_TYPE[syncType] : undefined,
    chunkOrder: n(f.get(5)?.[0]),
    progress: n(f.get(6)?.[0]),
    chats: (f.get(2) ?? []).map((c) => decodeConversation(c as Uint8Array)),
    pushnames: (f.get(7) ?? []).map((p) => {
      const pf = new Reader(p as Uint8Array).fields();
      return { id: s(pf.get(1)?.[0]) ?? "", pushname: s(pf.get(2)?.[0]) };
    }),
    lidMappings: (f.get(15) ?? [])
      .map((m) => {
        const mf = new Reader(m as Uint8Array).fields();
        return { pn: s(mf.get(1)?.[0]) ?? "", lid: s(mf.get(2)?.[0]) ?? "" };
      })
      .filter((x) => x.pn && x.lid),
  };
}
