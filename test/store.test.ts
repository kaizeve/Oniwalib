// Store em memória (src/store): liga nos eventos e mantém chats/contatos/
// mensagens/presença; serializa e reidrata.

import { makeInMemoryStore } from "../src/store";
import { Emitter } from "../src/events/emitter";

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

const A = "5511999@s.whatsapp.net";
const G = "120363000@g.us";

{
  const ev = new Emitter();
  const store = makeInMemoryStore();
  const unbind = store.bind(ev);

  // history set popula chats + contatos
  ev.emit("messaging-history.set", {
    chats: [
      { id: A, name: "Fulano", messageCount: 3, unreadCount: 2, pinned: 1699999999, conversationTimestamp: 1700000000 },
      { id: G, name: "Grupo", messageCount: 0, archived: true },
    ] as any,
    contacts: [{ id: A, notify: "Fulano F" }],
  });
  ok("history: 2 chats", store.chats.size === 2);
  ok("history: chat A com unread e pinned", store.chats.get(A)?.unreadCount === 2 && store.chats.get(A)?.pinned === 1699999999);
  ok("history: chat G arquivado", store.chats.get(G)?.archived === true);
  ok("history: contato A", store.contacts.get(A)?.notify === "Fulano F");

  // messages.upsert grava a mensagem e bumpa o chat
  ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      { key: { remoteJid: A, fromMe: false, id: "M1" }, message: { conversation: "oi" }, messageTimestamp: 1700000100, pushName: "Fulano F" },
      { key: { remoteJid: A, fromMe: false, id: "M2" }, message: { conversation: "tudo bem?" }, messageTimestamp: 1700000200 },
    ],
  });
  ok("upsert: 2 mensagens no chat A", store.messages.get(A)?.size === 2);
  ok("upsert: loadMessage", store.loadMessage(A, "M1")?.message !== undefined);
  ok("upsert: recentMessages ordena", store.recentMessages(A).map((m) => m.key.id).join(",") === "M1,M2");
  ok("upsert: conversationTimestamp atualizado", store.chats.get(A)?.conversationTimestamp === 1700000200);

  // messages.update troca o conteúdo (edição)
  ev.emit("messages.update", [
    { key: { remoteJid: A, fromMe: false, id: "M1" }, update: { message: { conversation: "oi (editado)" } } },
  ]);
  ok("update: conteúdo trocado", (store.loadMessage(A, "M1")?.message as any)?.conversation === "oi (editado)");

  // messages.delete remove
  ev.emit("messages.delete", { keys: [{ remoteJid: A, fromMe: false, id: "M2" }] });
  ok("delete: sobrou 1", store.messages.get(A)?.size === 1);

  // chats.update / contacts.update
  ev.emit("chats.update", [{ id: A, unreadCount: 0 }]);
  ok("chats.update: unread zerado", store.chats.get(A)?.unreadCount === 0);
  ev.emit("contacts.update", [{ id: A, status: "disponível" }]);
  ok("contacts.update: status", store.contacts.get(A)?.status === "disponível");

  // presence
  ev.emit("presence.update", { id: A, presences: { [A]: { lastKnownPresence: "composing" } } });
  ok("presence: guardada", store.presences.get(A)?.[A]?.lastKnownPresence === "composing");

  // grupo: fetchGroupMetadata cacheia; group-participants.update invalida
  let fetches = 0;
  const fetcher = async () => {
    fetches++;
    return { id: G, subject: "Grupo", participants: [], addressingMode: "pn", announce: false, restrict: false, joinApprovalMode: false, isCommunity: false, isCommunityAnnounce: false, size: 0 } as any;
  };
  await store.fetchGroupMetadata(G, fetcher);
  await store.fetchGroupMetadata(G, fetcher);
  ok("groupMetadata: cacheado (1 fetch)", fetches === 1);
  ev.emit("group-participants.update", { id: G, participants: ["x@s.whatsapp.net"], action: "add" });
  await store.fetchGroupMetadata(G, fetcher);
  ok("groupMetadata: refetch após participante mudar", fetches === 2);

  // serialização
  const snap = store.toJSON();
  ok("toJSON: chats+contacts+messages", snap.chats.length === 2 && snap.contacts.length >= 1 && snap.messages.length === 1);

  const store2 = makeInMemoryStore();
  store2.fromJSON(snap);
  ok("fromJSON: reidrata chats", store2.chats.get(A)?.name === "Fulano");
  ok("fromJSON: reidrata mensagem", store2.loadMessage(A, "M1") !== undefined);

  // unbind para de ouvir
  unbind();
  ev.emit("chats.update", [{ id: A, unreadCount: 99 }]);
  ok("unbind: não escuta mais", store.chats.get(A)?.unreadCount === 0);
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/store [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
