// Camada de presença (src/presence.ts) — puro, sem cripto nem socket. Um
// `sendNode` que empilha nodes + um Emitter que empilha eventos.

import { Emitter } from "../src/events/emitter";
import { node, type BinaryNode } from "../src/frame/node";
import { createPresenceLayer } from "../src/presence";

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

const ME = "5511888888888:3@s.whatsapp.net";
const CONTACT = "5511999999999@s.whatsapp.net";
const GROUP = "12345-67890@g.us";

const sent: BinaryNode[] = [];
const events = new Emitter();
const updates: any[] = [];
events.on("presence.update", (u) => updates.push(u));
const last = () => updates[updates.length - 1];

let gid = 0;
const layer = createPresenceLayer({
  events,
  sendNode: (n) => sent.push(n),
  genId: () => `id-${gid++}`,
  meId: () => ME,
});

// --- recebendo <presence> ------------------------------------------------
layer.handlePresence(node("presence", { from: CONTACT, type: "unavailable", last: "1700000000" }));
ok("unavailable → lastKnownPresence", last()?.presences?.[CONTACT]?.lastKnownPresence === "unavailable");
ok("unavailable → lastSeen do attr last", last()?.presences?.[CONTACT]?.lastSeen === 1700000000);
ok("presence.update.id = jid", last()?.id === CONTACT);

layer.handlePresence(node("presence", { from: CONTACT }));
ok("sem type → available", last()?.presences?.[CONTACT]?.lastKnownPresence === "available");
ok("available sem last → lastSeen undefined", last()?.presences?.[CONTACT]?.lastSeen === undefined);

layer.handlePresence(node("presence", { from: CONTACT, last: "deny" }));
ok("last=deny → lastSeen undefined", last()?.presences?.[CONTACT]?.lastSeen === undefined);

layer.handlePresence(node("presence", { from: GROUP, participant: CONTACT, type: "available" }));
ok("grupo: id = grupo, chave = participant", last()?.id === GROUP && !!last()?.presences?.[CONTACT]);

updates.length = 0;
layer.handlePresence(node("presence", {})); // sem from → ignora
ok("presence sem from é ignorado", updates.length === 0);

// --- recebendo <chatstate> --------------------------------------------
layer.handleChatState(node("chatstate", { from: CONTACT }, [node("composing", {})]));
ok("composing → lastKnownPresence composing", last()?.presences?.[CONTACT]?.lastKnownPresence === "composing");

layer.handleChatState(node("chatstate", { from: CONTACT }, [node("composing", { media: "audio" })]));
ok("composing media=audio → recording", last()?.presences?.[CONTACT]?.lastKnownPresence === "recording");

layer.handleChatState(node("chatstate", { from: CONTACT }, [node("paused", {})]));
ok("paused → available", last()?.presences?.[CONTACT]?.lastKnownPresence === "available");

layer.handleChatState(node("chatstate", { from: GROUP, participant: CONTACT }, [node("composing", {})]));
ok("grupo chatstate: id = grupo, chave = participant", last()?.id === GROUP && !!last()?.presences?.[CONTACT]);

updates.length = 0;
layer.handleChatState(node("chatstate", { from: CONTACT })); // sem filhos
ok("chatstate sem filhos é ignorado", updates.length === 0);

// --- enviando presença ------------------------------------------------
sent.length = 0;
layer.sendPresenceUpdate("available");
ok("sendPresenceUpdate available → <presence type=available> sem to", sent[0]?.tag === "presence" && sent[0]?.attrs.type === "available" && !sent[0]?.attrs.to);

layer.sendPresenceUpdate("unavailable");
ok("sendPresenceUpdate unavailable", sent[sent.length-1]?.attrs.type === "unavailable");

sent.length = 0;
layer.sendPresenceUpdate("composing", CONTACT);
ok("composing → <chatstate to from>", sent[0]?.tag === "chatstate" && sent[0]?.attrs.to === CONTACT && sent[0]?.attrs.from === ME);
ok("composing → filho <composing>", Array.isArray(sent[0]?.content) && (sent[0]!.content as BinaryNode[])[0]?.tag === "composing");

sent.length = 0;
layer.sendPresenceUpdate("recording", CONTACT);
{
  const child = (sent[0]?.content as BinaryNode[])?.[0];
  ok("recording → filho <composing media=audio>", child?.tag === "composing" && child?.attrs.media === "audio");
}

sent.length = 0;
layer.sendPresenceUpdate("paused", CONTACT);
ok("paused → filho <paused>", (sent[0]?.content as BinaryNode[])?.[0]?.tag === "paused");

{
  let threw = "";
  try {
    layer.sendPresenceUpdate("composing");
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("composing sem toJid lança", threw.includes("toJid"), threw);
}

// --- subscribe ------------------------------------------------------
sent.length = 0;
layer.subscribePresence(CONTACT);
ok("subscribePresence → <presence type=subscribe to id>", sent[0]?.tag === "presence" && sent[0]?.attrs.type === "subscribe" && sent[0]?.attrs.to === CONTACT && !!sent[0]?.attrs.id);

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/presence [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
