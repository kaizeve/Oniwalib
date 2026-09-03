// Superfície de eventos da lib. Nomes e formas espelham a Baileys para quem já
// conhece, mas o mapa de tipos é próprio.
//
// Implementação mínima e sem dependência: um mapa de listeners. Troca por
// `EventEmitter` do `node:events` quando a cobertura dele no RTS estiver
// confirmada (verificação da Fase 0).

import type { BinaryNode } from "../frame/node";

export interface OniwalibEvents {
  "connection.update": {
    connection?: "connecting" | "open" | "close";
    lastDisconnect?: { error: Error; date: Date };
    qr?: string;
    pairingCode?: string;
    /** `true` no `connection.update` logo após um pareamento por QR concluído. */
    isNewLogin?: boolean;
  };
  "creds.update": Record<string, unknown>;
  "messages.upsert": {
    type: "notify" | "append";
    messages: Array<{
      key: MessageKey;
      message?: unknown;
      /** Carimbo do servidor (`t`), em segundos unix, quando a stanza traz. */
      messageTimestamp?: number;
      pushName?: string;
      /** Só em canal (`@newsletter`): id da mensagem dentro do canal (`server_id`). */
      newsletterServerId?: number;
    }>;
  };
  "messages.receipt": { key: MessageKey; receipt: "delivery" | "read" | "played" };
  /** Alguém reagiu a uma mensagem (ou tirou a reação, `text` vazio). `key` é a
   *  mensagem reagida; `reaction.key` é a stanza de reação de quem reagiu. */
  "messages.reaction": {
    key: MessageKey;
    reaction: { text?: string; senderTimestampMs?: number; key: MessageKey };
  };
  /** "Apagar para todos" (protocolMessage REVOKE). */
  "messages.delete": { keys: MessageKey[] };
  /** Mensagem alterada — edição (protocolMessage MESSAGE_EDIT), estrela, etc.
   *  `update.message` traz o novo conteúdo quando é edição. */
  "messages.update": Array<{
    key: MessageKey;
    update: { message?: unknown; editedTimestamp?: number; starred?: boolean };
  }>;
  /** Presença de um contato/participante mudou (online, digitando, gravando…). */
  "presence.update": { id: string; presences: Record<string, PresenceData> };
  /** Mudou foto de perfil, recado (bio/about) ou nome de um contato. */
  "contacts.update": ContactUpdate[];
  /** Contato novo/rebatizado — vindo do app-state sync (`contactAction`). */
  "contacts.upsert": Array<{ id: string; name?: string; notify?: string }>;
  /** Um chat mudou por app-state sync: `mute`, `pin`, `archive`, `unreadCount`… */
  "chats.update": Array<{ id: string } & Record<string, unknown>>;
  /** Chats removidos (app-state `deleteChatAction`). */
  "chats.delete": string[];
  /** Metadata de um grupo mudou (assunto, descrição, `announce`/`restrict`…). */
  "groups.update": Array<{ id: string } & Record<string, unknown>>;
  /** Entrou/saiu/virou admin alguém num grupo. */
  "group-participants.update": {
    id: string;
    author?: string;
    participants: string[];
    action: "add" | "remove" | "promote" | "demote" | "modify";
  };
  /** Alguém votou numa enquete. O voto vem CIFRADO — decifre com
   *  `decryptPollVote` (de `src/polls`) usando a `pollEncKey` que você guardou
   *  ao criar a enquete (`messageContextInfo.messageSecret`). */
  "poll.update": {
    /** key da mensagem de CRIAÇÃO da enquete. */
    pollCreationKey: MessageKey;
    /** quem votou. */
    voterJid: string;
    vote: { encPayload?: Uint8Array; encIv?: Uint8Array };
    senderTimestampMs?: number;
  };
  /** Uma chamada (voz/vídeo) — oferta, aceite, ou fim. */
  "call": WACall[];
  /** A blocklist da conta mudou. `action` ausente = lista completa (no fetch
   *  inicial ou num `<notification type="blocklist">` de dump). */
  "blocklist.update": { blocklist: string[]; action?: "add" | "remove" };
  /** History sync — chega em pedaços após o pareamento. `chats` é a lista de
   *  conversas (nome/não-lido/fixado/arquivado/mudo); `contacts` os pushnames.
   *  `syncType`: INITIAL_BOOTSTRAP / RECENT / FULL / PUSH_NAME… */
  "messaging-history.set": {
    chats: import("../history").HistoryChat[];
    contacts: Array<{ id: string; notify?: string }>;
    /** Mensagens do histórico (achatadas de todas as conversas do chunk),
     *  ordenadas por tempo crescente. Vazio se o blob não trouxe corpo. */
    messages: import("../history").HistoryMessage[];
    syncType?: string;
    progress?: number;
    /** `true` no último chunk (progress 100). */
    isLatest?: boolean;
  };
  "node.recv": BinaryNode;
  "node.send": BinaryNode;
}

export interface WACall {
  chatId: string;
  from: string;
  id: string;
  /** `offer` chegou uma chamada · `accept`/`reject`/`timeout`/`terminate` fim. */
  status: "offer" | "ringing" | "accept" | "reject" | "timeout" | "terminate";
  date: Date;
  isVideo?: boolean;
  isGroup?: boolean;
  groupJid?: string;
  /** Quem originou (em grupo pode diferir de `from`). */
  offline?: boolean;
}

export interface MessageKey {
  remoteJid: string;
  fromMe: boolean;
  id: string;
  participant?: string;
}

export type WAPresence =
  | "unavailable"
  | "available"
  | "composing"
  | "recording"
  | "paused";

export interface PresenceData {
  lastKnownPresence: WAPresence;
  /** Último "visto por último", em segundos unix. Ausente se o contato esconde. */
  lastSeen?: number;
}

export interface ContactUpdate {
  id: string;
  /** `"changed"` = trocou a foto, `"removed"` = tirou. */
  imgUrl?: "changed" | "removed";
  /** Novo texto de recado (bio/about). */
  status?: string;
  name?: string;
}

type Handler<K extends keyof OniwalibEvents> = (payload: OniwalibEvents[K]) => void;

export class Emitter {
  private map = new Map<string, Set<Handler<never>>>();

  on<K extends keyof OniwalibEvents>(event: K, handler: Handler<K>): () => void {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => set!.delete(handler as Handler<never>);
  }

  once<K extends keyof OniwalibEvents>(event: K, handler: Handler<K>): void {
    const off = this.on(event, (p) => {
      off();
      handler(p);
    });
  }

  emit<K extends keyof OniwalibEvents>(event: K, payload: OniwalibEvents[K]): void {
    const set = this.map.get(event);
    if (!set) {
      return;
    }
    for (const h of set) {
      (h as Handler<K>)(payload);
    }
  }

  removeAll(): void {
    this.map.clear();
  }
}
