// Blocklist da conta. `<iq xmlns="blocklist">` — igual ao
// `@whiskeysockets/baileys` (`Socket/messages-recv.js` + `Socket/socket.js`):
//
//   fetch:   <iq to="@s.whatsapp.net" type="get" xmlns="blocklist"/>
//            → <blocklist><item jid="…@s.whatsapp.net"/> …</blocklist>
//   toggle:  <iq to="@s.whatsapp.net" type="set" xmlns="blocklist">
//              <item action="block|unblock" jid="…"/></iq>
//   push:    <notification type="blocklist"><item action="add|remove" jid="…"/></notification>

import { getBinaryNodeChild, getBinaryNodeChildren, node, type BinaryNode } from "../frame/node";
import type { Emitter } from "../events/emitter";

const S_WHATSAPP_NET = "@s.whatsapp.net";

export interface BlocklistLayerOptions {
  query: (n: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>;
  events: Emitter;
}

export interface BlocklistLayer {
  /** Lista atual de jids bloqueados. Também emite `blocklist.update`. */
  fetchBlocklist(): Promise<string[]>;
  /** Bloqueia ou desbloqueia um número. */
  updateBlockStatus(jid: string, action: "block" | "unblock"): Promise<void>;
  /** Trata um `<notification type="blocklist">`. `true` se reconheceu. */
  handleBlocklistNotification(stanza: BinaryNode): boolean;
}

export function parseBlocklist(iqResult: BinaryNode): string[] {
  const list = getBinaryNodeChild(iqResult, "blocklist") ?? getBinaryNodeChild(iqResult, "list");
  return getBinaryNodeChildren(list, "item")
    .map((n) => n.attrs.jid)
    .filter((j): j is string => !!j);
}

export function createBlocklistLayer(o: BlocklistLayerOptions): BlocklistLayer {
  const { query, events } = o;

  async function fetchBlocklist(): Promise<string[]> {
    const res = await query(
      node("iq", { to: S_WHATSAPP_NET, type: "get", xmlns: "blocklist" }),
    );
    const blocklist = parseBlocklist(res);
    events.emit("blocklist.update", { blocklist });
    return blocklist;
  }

  async function updateBlockStatus(
    jid: string,
    action: "block" | "unblock",
  ): Promise<void> {
    await query(
      node("iq", { to: S_WHATSAPP_NET, type: "set", xmlns: "blocklist" }, [
        node("item", { action, jid }),
      ]),
    );
    events.emit("blocklist.update", {
      blocklist: [jid],
      action: action === "block" ? "add" : "remove",
    });
  }

  function handleBlocklistNotification(stanza: BinaryNode): boolean {
    if (stanza.attrs.type !== "blocklist") return false;
    const items = getBinaryNodeChildren(stanza, "item");
    if (!items.length) return false;
    // o dump vem sem `action` nos <item>; o incremental traz add/remove
    const withAction = items.filter((i) => i.attrs.action);
    if (withAction.length) {
      for (const it of withAction) {
        if (!it.attrs.jid) continue;
        events.emit("blocklist.update", {
          blocklist: [it.attrs.jid],
          action: it.attrs.action === "add" ? "add" : "remove",
        });
      }
    } else {
      events.emit("blocklist.update", {
        blocklist: items.map((i) => i.attrs.jid).filter((j): j is string => !!j),
      });
    }
    return true;
  }

  return { fetchBlocklist, updateBlockStatus, handleBlocklistNotification };
}
