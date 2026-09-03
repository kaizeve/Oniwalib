// History sync (src/history): decodifica um proto HistorySync (subconjunto).
// Monta o blob com o Writer e confere o que a lib extrai.

import { decodeHistorySync, HISTORY_SYNC_TYPE } from "../src/history";
import { nodeAdapter as c } from "../src/crypto/node-adapter";
import { Writer } from "../src/proto/wire";
import { encodeE2EMessage } from "../src/proto/e2e-message";

let pass = 0;
let fail = 0;
const fails: string[] = [];
const ok = (n: string, cond: boolean, d = "") => {
  if (cond) pass++;
  else {
    fail++;
    fails.push(n + (d ? ` — ${d}` : ""));
  }
};

// Conversation { id=1, messages=2 (rep), lastMsgTimestamp=5, unreadCount=6,
//   readOnly=7, conversationTimestamp=12, name=13, archived=16,
//   markedAsUnread=19, pinned=24, muteEndTime=25, displayName=38, lidJid=42 }
function conversation(o: {
  id: string; name?: string; unread?: number; msgs?: number; pinned?: number;
  archived?: boolean; muteEndTime?: number; ts?: number; lidJid?: string;
}): Uint8Array {
  const w = new Writer();
  w.string(1, o.id);
  for (let i = 0; i < (o.msgs ?? 0); i++) w.message(2, new Writer().uint(2, i + 1)); // HistorySyncMsg dummy
  if (o.ts) w.uint(12, o.ts);
  if (o.unread) w.uint(6, o.unread);
  if (o.name) w.string(13, o.name);
  if (o.archived) w.boolF(16, true);
  if (o.pinned) w.uint(24, o.pinned);
  if (o.muteEndTime) w.uint(25, o.muteEndTime);
  if (o.lidJid) w.string(42, o.lidJid);
  return w.finish();
}
function pushname(id: string, name: string): Uint8Array {
  return new Writer().string(1, id).string(2, name).finish();
}
function lidMap(pn: string, lid: string): Uint8Array {
  return new Writer().string(1, pn).string(2, lid).finish();
}

// HistorySync { syncType=1, conversations=2 (rep), chunkOrder=5, progress=6,
//   pushnames=7 (rep), phoneNumberToLidMappings=15 (rep) }
{
  const w = new Writer();
  w.uint(1, 3);
  w.bytes(2, conversation({ id: "111@g.us", name: "Grupo A", unread: 4, msgs: 10, pinned: 1699999999, ts: 1700000000 }));
  w.bytes(2, conversation({ id: "5511999@s.whatsapp.net", name: "Fulano", archived: true, msgs: 3, muteEndTime: 1800000000, lidJid: "123@lid" }));
  w.bytes(2, conversation({ id: "5511888@s.whatsapp.net", msgs: 0 }));
  w.uint(5, 2); // chunkOrder
  w.uint(6, 75); // progress
  w.bytes(7, pushname("5511999@s.whatsapp.net", "Fulano da Silva"));
  w.bytes(7, pushname("5511888@s.whatsapp.net", "Beltrano"));
  w.bytes(15, lidMap("5511999@s.whatsapp.net", "123@lid"));
  const buf = w.finish();

  const h = decodeHistorySync(buf);
  ok("syncType 3 (RECENT)", h.syncType === 3 && h.syncTypeName === "RECENT");
  ok("chunkOrder", h.chunkOrder === 2);
  ok("progress", h.progress === 75);
  ok("3 chats", h.chats.length === 3);

  const g = h.chats[0]!;
  ok("chat: id", g.id === "111@g.us");
  ok("chat: name", g.name === "Grupo A");
  ok("chat: unreadCount", g.unreadCount === 4);
  ok("chat: messageCount = qtd de <messages>", g.messageCount === 10);
  ok("chat: pinned", g.pinned === 1699999999);
  ok("chat: conversationTimestamp", g.conversationTimestamp === 1700000000);
  ok("chat: não arquivado", g.archived === false);

  const f2 = h.chats[1]!;
  ok("chat2: archived", f2.archived === true);
  ok("chat2: muteEndTime", f2.muteEndTime === 1800000000);
  ok("chat2: lidJid", f2.lidJid === "123@lid");

  ok("chat3: messageCount 0", h.chats[2]?.messageCount === 0);

  ok("2 pushnames", h.pushnames.length === 2);
  ok("pushname id+nome", h.pushnames[0]?.id === "5511999@s.whatsapp.net" && h.pushnames[0]?.pushname === "Fulano da Silva");

  ok("1 lidMapping", h.lidMappings.length === 1);
  ok("lidMapping pn+lid", h.lidMappings[0]?.pn === "5511999@s.whatsapp.net" && h.lidMappings[0]?.lid === "123@lid");
}

// --- withMessages: decodifica o corpo (WebMessageInfo) ---------
{
  // MessageKey { remoteJid=1, fromMe=2, id=3 }
  const mkKey = (id: string, fromMe: boolean) =>
    new Writer().string(1, "111@g.us").boolF(2, fromMe).string(3, id).finish();
  // WebMessageInfo { key=1, message=2, messageTimestamp=3, status=4, pushName=19, starred=17 }
  const wmi = (id: string, text: string, ts: number, fromMe = false) =>
    new Writer()
      .bytes(1, mkKey(id, fromMe))
      .bytes(2, encodeE2EMessage({ conversation: text }))
      .uint(3, ts)
      .uint(4, 3)
      .string(19, "Alguém")
      .finish();
  // HistorySyncMsg { message=1 (WebMessageInfo) }
  const hsm = (b: Uint8Array) => new Writer().bytes(1, b).finish();

  const conv = new Writer()
    .string(1, "111@g.us")
    .bytes(2, hsm(wmi("W1", "primeira", 1700000001)))
    .bytes(2, hsm(wmi("W2", "segunda", 1700000002, true)))
    .finish();
  const buf = new Writer().uint(1, 2).bytes(2, conv).finish();

  const lite = decodeHistorySync(buf);
  ok("sem withMessages: messages undefined", lite.chats[0]?.messages === undefined && lite.chats[0]?.messageCount === 2);

  const full = decodeHistorySync(buf, { withMessages: true });
  const msgs = full.chats[0]?.messages ?? [];
  ok("withMessages: 2 mensagens", msgs.length === 2);
  ok("withMessages: key.id + fromMe", msgs[0]?.key?.id === "W1" && msgs[0]?.key?.fromMe === false && msgs[1]?.key?.fromMe === true);
  ok("withMessages: conteúdo decodificado", (msgs[0]?.message as any)?.conversation === "primeira");
  ok("withMessages: timestamp + status + pushName", msgs[0]?.messageTimestamp === 1700000001 && msgs[0]?.status === 3 && msgs[0]?.pushName === "Alguém");
}

// vazio / desconhecido
{
  const h = decodeHistorySync(new Uint8Array(0));
  ok("blob vazio → sem chats", h.chats.length === 0 && h.pushnames.length === 0);
  ok("syncType undefined", h.syncType === undefined);
}

// HISTORY_SYNC_TYPE mapa
{
  ok("tipo 0 = INITIAL_BOOTSTRAP", HISTORY_SYNC_TYPE[0] === "INITIAL_BOOTSTRAP");
  ok("tipo 4 = PUSH_NAME", HISTORY_SYNC_TYPE[4] === "PUSH_NAME");
}

// inflate do adapter (deflate → inflate round-trip)
{
  const original = c.randomBytes(200);
  // zlib deflate via node:zlib no lado do teste
  const zlib = require("node:zlib");
  const compressed = new Uint8Array(zlib.deflateSync(original));
  ok("inflate existe no node-adapter", typeof c.inflate === "function");
  const back = c.inflate!(compressed);
  ok("inflate desfaz o deflate", back.length === 200 && back.every((b, i) => b === original[i]));
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/history [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
