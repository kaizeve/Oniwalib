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
import { decodeE2EMessage, type E2EMessage, type E2EMessageKey } from "../proto/e2e-message";

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

export interface HistoryMessage {
  key?: E2EMessageKey;
  message?: E2EMessage;
  messageTimestamp?: number;
  /** WebMessageInfo.Status: 1 PENDING, 2 SERVER_ACK, 3 DELIVERY_ACK, 4 READ, 5 PLAYED. */
  status?: number;
  pushName?: string;
  starred?: boolean;
  labels?: string[];
}

export interface HistoryChat {
  id: string;
  name?: string;
  displayName?: string;
  /** número de mensagens que vieram nesta conversa. */
  messageCount: number;
  /** as mensagens em si, só se `decodeHistorySync(buf, { withMessages: true })`. */
  messages?: HistoryMessage[];
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

function decodeMessageKey(buf: Uint8Array | undefined): E2EMessageKey | undefined {
  if (!buf) return undefined;
  const f = new Reader(buf).fields();
  return {
    remoteJid: s(f.get(1)?.[0]),
    fromMe: typeof f.get(2)?.[0] === "number" ? f.get(2)![0] !== 0 : undefined,
    id: s(f.get(3)?.[0]),
    participant: s(f.get(4)?.[0]),
  };
}

// HistorySyncMsg { message = 1 (WebMessageInfo), msgOrderId = 2 }
// WebMessageInfo { key=1, message=2, messageTimestamp=3, status=4, pushName=19,
//   starred=17, labels=28 }
function decodeHistoryMessage(histSyncMsgBuf: Uint8Array): HistoryMessage {
  const wmiBuf = new Reader(histSyncMsgBuf).fields().get(1)?.[0];
  if (!(wmiBuf instanceof Uint8Array)) return {};
  const f = new Reader(wmiBuf).fields();
  const msgBytes = f.get(2)?.[0];
  return {
    key: decodeMessageKey(f.get(1)?.[0] instanceof Uint8Array ? (f.get(1)![0] as Uint8Array) : undefined),
    message: msgBytes instanceof Uint8Array ? decodeE2EMessage(msgBytes) : undefined,
    messageTimestamp: n(f.get(3)?.[0]),
    status: n(f.get(4)?.[0]),
    pushName: s(f.get(19)?.[0]),
    starred: bool(f.get(17)?.[0]),
    labels: (f.get(28) ?? [])
      .filter((x) => x instanceof Uint8Array)
      .map((x) => utf8(x as Uint8Array)),
  };
}

function decodeConversation(buf: Uint8Array, withMessages: boolean): HistoryChat {
  const f = new Reader(buf).fields();
  const rawMsgs = f.get(2) ?? [];
  return {
    id: s(f.get(1)?.[0]) ?? "",
    messageCount: rawMsgs.length,
    messages: withMessages
      ? rawMsgs
          .filter((m) => m instanceof Uint8Array)
          .map((m) => decodeHistoryMessage(m as Uint8Array))
      : undefined,
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

/** Decodifica um blob `HistorySync` JÁ descomprimido (zlib-inflate feito antes).
 *  `withMessages` decodifica também o corpo das mensagens de cada conversa
 *  (mais caro — o `WebMessageInfo` é grande); default só a contagem. */
export function decodeHistorySync(
  buf: Uint8Array,
  opts?: { withMessages?: boolean },
): HistorySyncResult {
  const withMessages = !!opts?.withMessages;
  const f = new Reader(buf).fields();
  const syncType = n(f.get(1)?.[0]);
  return {
    syncType,
    syncTypeName: syncType !== undefined ? HISTORY_SYNC_TYPE[syncType] : undefined,
    chunkOrder: n(f.get(5)?.[0]),
    progress: n(f.get(6)?.[0]),
    chats: (f.get(2) ?? []).map((c) => decodeConversation(c as Uint8Array, withMessages)),
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
