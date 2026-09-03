// Chamadas (voz/vídeo). O WhatsApp manda um `<call from=… id=…>` com UM filho
// que diz o quê: `<offer>`, `<accept>`, `<reject>`, `<terminate reason=…>`,
// `<preaccept>`, `<relaylatency>`. Espelha o `handleCall` do
// `@whiskeysockets/baileys` (`Socket/messages-recv.js`): normaliza pra um
// `WACall` e emite `call`.
//
// A oniwalib NÃO faz WebRTC — não dá pra atender. Mas dá pra saber que tocou e
// pra RECUSAR (`rejectCall`), que é o que um bot precisa.

import { getBinaryNodeChild, node, type BinaryNode } from "../frame/node";
import type { Emitter, WACall } from "../events/emitter";

export interface CallsLayerOptions {
  events: Emitter;
  sendNode: (n: BinaryNode) => void;
}

export interface CallsLayer {
  /** Trata um `<call>` de entrada. `true` se reconheceu. */
  handleCallNode(stanza: BinaryNode): boolean;
  /** Recusa uma chamada (manda `<call><reject/></call>`). */
  rejectCall(callId: string, callFrom: string): void;
}

function statusOf(tag: string, reason?: string): WACall["status"] {
  switch (tag) {
    case "offer":
    case "offer_notice":
      return "offer";
    case "accept":
      return "accept";
    case "preaccept":
      return "ringing";
    case "reject":
      return "reject";
    case "terminate":
      return reason === "timeout" ? "timeout" : "terminate";
    default:
      return "ringing";
  }
}

export function extractCall(stanza: BinaryNode): WACall | undefined {
  const from = stanza.attrs.from;
  if (!from) return undefined;
  const child = Array.isArray(stanza.content) ? stanza.content[0] : undefined;
  if (!child) return undefined;

  const a = child.attrs;
  const id = a["call-id"] ?? stanza.attrs.id ?? "";
  const creator = a["call-creator"] ?? a.from ?? from;
  const t = stanza.attrs.t;
  const date = new Date((t ? Number(t) : Date.now() / 1000) * 1000);

  const call: WACall = {
    chatId: from,
    from: creator,
    id,
    status: statusOf(child.tag, a.reason),
    date,
    offline: stanza.attrs.offline !== undefined,
  };

  if (child.tag === "offer" || child.tag === "offer_notice") {
    call.isVideo = !!getBinaryNodeChild(child, "video");
    const groupJid = a["group-jid"] ?? a["group_jid"];
    if (groupJid || a.type === "group") {
      call.isGroup = true;
      if (groupJid) call.groupJid = groupJid;
    }
  }
  return call;
}

export function createCallsLayer(o: CallsLayerOptions): CallsLayer {
  function handleCallNode(stanza: BinaryNode): boolean {
    const call = extractCall(stanza);
    if (!call) return false;
    o.events.emit("call", [call]);
    return true;
  }

  function rejectCall(callId: string, callFrom: string): void {
    try {
      o.sendNode(
        node("call", { to: callFrom }, [
          node("reject", {
            "call-id": callId,
            "call-creator": callFrom,
            count: "0",
          }),
        ]),
      );
    } catch {
      /* conexão caiu — ignora */
    }
  }

  return { handleCallNode, rejectCall };
}
