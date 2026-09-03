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
    messages: [{ key: { remoteJid: A, fromMe: false, id: "H1" }, message: { conversation: "oi do historico" }, messageTimestamp: 1699999000 }],
  });
  ok("history: 2 chats", store.chats.size === 2);
  ok("history: chat A com unread e pinned", store.chats.get(A)?.unreadCount === 2 && store.chats.get(A)?.pinned === 1699999999);
  ok("history: chat G arquivado", store.chats.get(G)?.archived === true);
  ok("history: contato A", store.contacts.get(A)?.notify === "Fulano F");
  ok("history: mensagem do histórico gravada", (store.loadMessage(A, "H1")?.message as any)?.conversation === "oi do historico");

  // messages.upsert grava a mensagem e bumpa o chat
  ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      { key: { remoteJid: A, fromMe: false, id: "M1" }, message: { conversation: "oi" }, messageTimestamp: 1700000100, pushName: "Fulano F" },
      { key: { remoteJid: A, fromMe: false, id: "M2" }, message: { conversation: "tudo bem?" }, messageTimestamp: 1700000200 },
    ],
  });
  ok("upsert: 3 mensagens no chat A (H1 + M1 + M2)", store.messages.get(A)?.size === 3);
  ok("upsert: loadMessage", store.loadMessage(A, "M1")?.message !== undefined);
  ok("upsert: recentMessages ordena", store.recentMessages(A).map((m) => m.key.id).join(",") === "H1,M1,M2");
  ok("upsert: conversationTimestamp atualizado", store.chats.get(A)?.conversationTimestamp === 1700000200);

  // messages.update troca o conteúdo (edição)
  ev.emit("messages.update", [
    { key: { remoteJid: A, fromMe: false, id: "M1" }, update: { message: { conversation: "oi (editado)" } } },
  ]);
  ok("update: conteúdo trocado", (store.loadMessage(A, "M1")?.message as any)?.conversation === "oi (editado)");

  // messages.delete remove
  ev.emit("messages.delete", { keys: [{ remoteJid: A, fromMe: false, id: "M2" }] });
  ok("delete: sobrou 2 (H1 + M1)", store.messages.get(A)?.size === 2);

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

  // poll.update → pollVotes + pollResults
  const iv = new Uint8Array([1, 2, 3]);
  ev.emit("poll.update", { pollCreationKey: { remoteJid: A, fromMe: true, id: "P1" }, voterJid: "v1@s.whatsapp.net", vote: { encPayload: new Uint8Array([9]), encIv: iv }, senderTimestampMs: 1 });
  ev.emit("poll.update", { pollCreationKey: { remoteJid: A, fromMe: true, id: "P1" }, voterJid: "v2@s.whatsapp.net", vote: { encPayload: new Uint8Array([8]), encIv: iv }, senderTimestampMs: 2 });
  ev.emit("poll.update", { pollCreationKey: { remoteJid: A, fromMe: true, id: "P1" }, voterJid: "v1@s.whatsapp.net", vote: { encPayload: new Uint8Array([7]), encIv: iv }, senderTimestampMs: 3 });
  ok("pollVotes: 2 eleitores (último voto de v1 prevalece)", store.pollVotes.get("P1")?.size === 2);
  const res = store.pollResults("P1", (voter) => (voter === "v1@s.whatsapp.net" ? ["Sim"] : ["Não"]));
  ok("pollResults: tally", res.tally.Sim === 1 && res.tally["Não"] === 1 && res.voters === 2);
  const res2 = store.pollResults("P1", () => undefined); // não decifrou nenhum
  ok("pollResults: votos que não decifram são ignorados", res2.voters === 0);

  // labels
  ev.emit("labels.edit", { id: "1", name: "Cliente", color: 2 });
  ev.emit("labels.edit", { id: "2", name: "Spam" });
  ev.emit("labels.association", { type: "add", labelId: "1", chatId: A });
  ev.emit("labels.association", { type: "add", labelId: "2", chatId: A });
  ev.emit("labels.association", { type: "remove", labelId: "2", chatId: A });
  ok("labels.edit: guardou 2", store.labels.size === 2 && store.labels.get("1")?.name === "Cliente");
  ok("labels.association: chat A tem só label 1", [...(store.chatLabels.get(A) ?? [])].join(",") === "1");
  ev.emit("labels.edit", { id: "2", deleted: true });
  ok("labels.edit deleted: sobrou 1", store.labels.size === 1);

  // serialização
  const snap = store.toJSON();
  ok("toJSON: chats+contacts+messages", snap.chats.length === 2 && snap.contacts.length >= 1 && snap.messages.length === 1 && snap.messages[0].items.length === 2);

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
