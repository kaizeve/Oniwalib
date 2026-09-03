// Camada de blocklist (src/blocklist): <iq xmlns="blocklist"> + notification.

import { createBlocklistLayer, parseBlocklist } from "../src/blocklist";
import { getBinaryNodeChild, node, type BinaryNode } from "../src/frame/node";
import { Emitter } from "../src/events/emitter";

let pass = 0;
let fail = 0;
const fails: string[] = [];
const ok = (n: string, c: boolean, d = "") => {
  if (c) pass++;
  else {
    fail++;
    fails.push(n + (d ? ` — ${d}` : ""));
  }
};

const A = "5511111111111@s.whatsapp.net";
const B = "5522222222222@s.whatsapp.net";

let sent: BinaryNode | undefined;
let reply: BinaryNode;
const query = async (n: BinaryNode): Promise<BinaryNode> => {
  sent = n;
  return reply;
};

// --- fetch ------------------------------------------------------
{
  const ev = new Emitter();
  const updates: any[] = [];
  ev.on("blocklist.update", (u) => updates.push(u));
  const bl = createBlocklistLayer({ query, events: ev });

  reply = node("iq", { type: "result" }, [
    node("blocklist", {}, [node("item", { jid: A }), node("item", { jid: B })]),
  ]);
  const list = await bl.fetchBlocklist();
  ok("iq get xmlns blocklist to @s.whatsapp.net", sent?.attrs.type === "get" && sent?.attrs.xmlns === "blocklist" && sent?.attrs.to === "@s.whatsapp.net");
  ok("parseia 2 jids", list.length === 2 && list[0] === A && list[1] === B);
  ok("emite blocklist.update sem action", updates[0]?.blocklist.length === 2 && updates[0]?.action === undefined);

  // parseBlocklist também aceita <list>
  ok("parseBlocklist com <list>", parseBlocklist(node("iq", {}, [node("list", {}, [node("item", { jid: A })])])).length === 1);
}

// --- block / unblock -----------------------------------------
{
  const ev = new Emitter();
  const updates: any[] = [];
  ev.on("blocklist.update", (u) => updates.push(u));
  const bl = createBlocklistLayer({ query, events: ev });
  reply = node("iq", { type: "result" });

  await bl.updateBlockStatus(A, "block");
  ok("iq set", sent?.attrs.type === "set" && sent?.attrs.xmlns === "blocklist");
  ok("<item action=block jid>", getBinaryNodeChild(sent, "item")?.attrs.action === "block" && getBinaryNodeChild(sent, "item")?.attrs.jid === A);
  ok("emite update action=add", updates[0]?.action === "add" && updates[0]?.blocklist[0] === A);

  await bl.updateBlockStatus(A, "unblock");
  ok("emite update action=remove", updates[1]?.action === "remove");
}

// --- notification -------------------------------------------
{
  const ev = new Emitter();
  const updates: any[] = [];
  ev.on("blocklist.update", (u) => updates.push(u));
  const bl = createBlocklistLayer({ query, events: ev });

  const inc = bl.handleBlocklistNotification(
    node("notification", { type: "blocklist" }, [node("item", { jid: A, action: "add" })]),
  );
  ok("notification incremental reconhecida", inc === true);
  ok("update com action=add", updates[0]?.action === "add" && updates[0]?.blocklist[0] === A);

  const dump = bl.handleBlocklistNotification(
    node("notification", { type: "blocklist" }, [node("item", { jid: A }), node("item", { jid: B })]),
  );
  ok("notification dump reconhecida", dump === true);
  ok("update dump sem action, 2 jids", updates[1]?.action === undefined && updates[1]?.blocklist.length === 2);

  ok("type errado → false", bl.handleBlocklistNotification(node("notification", { type: "outro" }, [])) === false);
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/blocklist [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
