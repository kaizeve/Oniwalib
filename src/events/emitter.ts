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
  /** Presença de um contato/participante mudou (online, digitando, gravando…). */
  "presence.update": { id: string; presences: Record<string, PresenceData> };
  /** Mudou foto de perfil, recado (bio/about) ou nome de um contato. */
  "contacts.update": ContactUpdate[];
  "node.recv": BinaryNode;
  "node.send": BinaryNode;
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
