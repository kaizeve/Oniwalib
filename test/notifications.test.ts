// Camada de notificações (src/notifications.ts) — puro. <notification> de
// foto de perfil e de recado (bio) viram `contacts.update`.

import { Emitter } from "../src/events/emitter";
import { node } from "../src/frame/node";
import { utf8Encode } from "../src/frame/buffer";
import { createNotificationsLayer } from "../src/notifications";

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

const JID = "5511999999999@s.whatsapp.net";
const events = new Emitter();
const got: any[] = [];
events.on("contacts.update", (u) => got.push(u));
function last() { return got[got.length - 1]; }

const layer = createNotificationsLayer({ events });

// --- foto de perfil ---------------------------------------------------
let handled = layer.handleNotification(
  node("notification", { from: JID, type: "picture" }, [node("set", { id: "1" })]),
);
ok("picture <set> tratado", handled === true);
ok("picture <set> → imgUrl changed", last()?.[0]?.id === JID && last()?.[0]?.imgUrl === "changed");

layer.handleNotification(
  node("notification", { from: JID, type: "picture" }, [node("delete", {})]),
);
ok("picture <delete> → imgUrl removed", last()?.[0]?.imgUrl === "removed");

handled = layer.handleNotification(node("notification", { from: JID, type: "picture" }, []));
ok("picture sem set/delete → não tratado", handled === false);

// --- recado / bio ---------------------------------------------------
got.length = 0;
layer.handleNotification(
  node("notification", { from: JID, type: "status" }, [node("set", {}, "curtindo a vida")]),
);
ok("status <set> string → contacts.update status", last()?.[0]?.id === JID && last()?.[0]?.status === "curtindo a vida");

layer.handleNotification(
  node("notification", { from: JID, type: "status" }, [
    node("set", {}, utf8Encode("bytes também")),
  ]),
);
ok("status <set> bytes → decodifica", last()?.[0]?.status === "bytes também");

handled = layer.handleNotification(node("notification", { from: JID, type: "status" }, []));
ok("status sem <set> → não tratado", handled === false);

// --- ignorados ----------------------------------------------------
got.length = 0;
ok("type desconhecido → false", layer.handleNotification(node("notification", { from: JID, type: "devices" })) === false);
ok("sem from → false", layer.handleNotification(node("notification", { type: "picture" }, [node("set", {})])) === false);
ok("nada emitido pros ignorados", got.length === 0);

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/notifications [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
