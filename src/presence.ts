// Camada de presença — o análogo do trecho de presença do `messages-recv` +
// `sendPresenceUpdate`/`presenceSubscribe` da Baileys.
//
//   handlePresence(node)     <presence from type? last?> → emite presence.update
//                            ("online" / "visto por último").
//   handleChatState(node)    <chatstate from><composing|paused .../></chatstate>
//                            → emite presence.update ("digitando" / "gravando").
//   sendPresenceUpdate(t,to) anuncia a NOSSA presença: available/unavailable é
//                            global (sem `to`); composing/recording/paused é por
//                            chat (exige `to`).
//   subscribePresence(jid)   pede ao servidor pra receber a presença de `jid`
//                            (sem isso o servidor não manda os <presence> dele).
//
// Stanzas de presença NÃO levam <ack> (a Baileys também não ackeia).

import type { Emitter, PresenceData, WAPresence } from "./events/emitter";
import { node, type BinaryNode } from "./frame/node";

export type { WAPresence, PresenceData } from "./events/emitter";

export interface PresenceLayerOptions {
  events: Emitter;
  sendNode: (n: BinaryNode) => void;
  genId: () => string;
  /** JID do nosso device (para o `from` do <chatstate>). */
  meId: () => string | undefined;
}

export interface PresenceLayer {
  handlePresence(stanza: BinaryNode): void;
  handleChatState(stanza: BinaryNode): void;
  sendPresenceUpdate(type: WAPresence, toJid?: string): void;
  subscribePresence(jid: string): void;
}

export function createPresenceLayer(opts: PresenceLayerOptions): PresenceLayer {
  const { events, sendNode, genId, meId } = opts;

  const emit = (id: string, participant: string, data: PresenceData): void => {
    events.emit("presence.update", { id, presences: { [participant]: data } });
  };

  function handlePresence(stanza: BinaryNode): void {
    const a = stanza.attrs;
    if (!a.from) return;
    // Em grupo, `from` é o grupo e `participant` é quem mudou; em 1:1 os dois
    // são o mesmo contato.
    emit(a.from, a.participant || a.from, {
      lastKnownPresence: a.type === "unavailable" ? "unavailable" : "available",
      lastSeen: a.last && a.last !== "deny" ? Number(a.last) : undefined,
    });
  }

  function handleChatState(stanza: BinaryNode): void {
    const a = stanza.attrs;
    if (!a.from || !Array.isArray(stanza.content)) return;
    const first = stanza.content[0];
    if (!first) return;
    let type = first.tag as WAPresence;
    if (type === "paused") type = "available";
    else if (first.attrs?.media === "audio") type = "recording";
    emit(a.from, a.participant || a.from, { lastKnownPresence: type });
  }

  function sendPresenceUpdate(type: WAPresence, toJid?: string): void {
    if (type === "available" || type === "unavailable") {
      sendNode(node("presence", { type }));
      return;
    }
    if (!toJid) {
      throw new Error("sendPresenceUpdate: composing/recording/paused exigem um toJid");
    }
    const child = type === "recording" ? "composing" : type;
    const childAttrs = type === "recording" ? { media: "audio" } : {};
    const attrs: Record<string, string> = { to: toJid };
    const me = meId();
    if (me) attrs.from = me;
    sendNode(node("chatstate", attrs, [node(child, childAttrs)]));
  }

  function subscribePresence(jid: string): void {
    sendNode(node("presence", { to: jid, id: genId(), type: "subscribe" }));
  }

  return { handlePresence, handleChatState, sendPresenceUpdate, subscribePresence };
}
