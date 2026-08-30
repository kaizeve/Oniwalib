// Camada de notificações — o análogo do `handleNotification` da Baileys, no
// mínimo dos tipos que mexem no perfil de um contato:
//
//   type="picture"  <set/> ou <delete/>  → contacts.update { imgUrl }
//   type="status"   <set>bio</set>       → contacts.update { status }
//
// Os demais tipos (`devices`, `account_sync`, `encrypt`, …) não são tratados
// aqui — `encrypt` é do `messages.ts` (repor pré-chaves) e o resto o `client.ts`
// só ackeia. `handleNotification` devolve `true` quando reconheceu o tipo.

import type { Emitter } from "./events/emitter";
import { getBinaryNodeChild, type BinaryNode } from "./frame/node";
import { utf8Decode } from "./frame/buffer";

export interface NotificationsLayerOptions {
  events: Emitter;
}

export interface NotificationsLayer {
  handleNotification(stanza: BinaryNode): boolean;
}

function textOf(n: BinaryNode | undefined): string | undefined {
  if (!n) return undefined;
  if (typeof n.content === "string") return n.content;
  if (n.content instanceof Uint8Array) return utf8Decode(n.content);
  return undefined;
}

export function createNotificationsLayer(opts: NotificationsLayerOptions): NotificationsLayer {
  const { events } = opts;

  function handleNotification(stanza: BinaryNode): boolean {
    const jid = stanza.attrs.from;
    if (!jid) return false;

    switch (stanza.attrs.type) {
      case "picture": {
        const set = getBinaryNodeChild(stanza, "set");
        const del = getBinaryNodeChild(stanza, "delete");
        if (!set && !del) return false;
        events.emit("contacts.update", [{ id: jid, imgUrl: set ? "changed" : "removed" }]);
        return true;
      }
      case "status": {
        const txt = textOf(getBinaryNodeChild(stanza, "set"));
        if (txt === undefined) return false;
        events.emit("contacts.update", [{ id: jid, status: txt }]);
        return true;
      }
      default:
        return false;
    }
  }

  return { handleNotification };
}
