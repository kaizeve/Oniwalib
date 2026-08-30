// Reações e "apagar para todos" — o codec (roundtrip puro) e a camada de
// mensagem (src/messages.ts) emitindo `messages.reaction` / `messages.delete`
// em vez de `messages.upsert`, mais `sendReaction` cifrando de volta. Mesmo
// esquema do messages.test: um "usuário" Signal cru fala com a camada.

import { memoryAuthState } from "../src/auth/state";
import { crypto } from "../src/crypto";
import { Emitter } from "../src/events/emitter";
import { node, getBinaryNodeChild, type BinaryNode } from "../src/frame/node";
import {
  makeCurve,
  makeSignalStorage,
  prefixKey,
  initOutgoing,
  encrypt as sigEncrypt,
  decryptWhisperMessage,
  type PreKeyBundle,
  type SignalDeps,
} from "../src/signal/index";
import { createMessagesLayer } from "../src/messages";
import { encodeE2EMessage, decodeE2EMessage } from "../src/proto/e2e-message";

const C = crypto();
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
const unpad = (e: Uint8Array) => e.subarray(0, e.length - e[e.length - 1]!);

// --- 1. codec: roundtrip puro ---------------------------------------
{
  const key = { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, id: "ABC123", participant: "x@s.whatsapp.net" };
  const round = decodeE2EMessage(
    encodeE2EMessage({ reactionMessage: { key, text: "❤️", senderTimestampMs: 1730000000123 } }),
  );
  ok("reaction: key roundtrip", JSON.stringify(round.reactionMessage?.key) === JSON.stringify(key));
  ok("reaction: text roundtrip", round.reactionMessage?.text === "❤️");
  ok("reaction: senderTimestampMs roundtrip", round.reactionMessage?.senderTimestampMs === 1730000000123);

  const removed = decodeE2EMessage(encodeE2EMessage({ reactionMessage: { key, text: "" } }));
  ok("reaction: text vazio = reação removida", removed.reactionMessage?.text === "");

  const revoke = decodeE2EMessage(encodeE2EMessage({ protocolMessage: { key, type: 0 } }));
  ok("protocol: REVOKE (type 0) roundtrip, key preservada", revoke.protocolMessage?.type === 0 && revoke.protocolMessage?.key?.id === "ABC123");

  const eph = decodeE2EMessage(encodeE2EMessage({ protocolMessage: { key, type: 3 } }));
  ok("protocol: type != 0 preservado", eph.protocolMessage?.type === 3);
}

// --- 2. camada: recebe reação e revoke ------------------------------
const USER_JID = "5511999999999@s.whatsapp.net";
const botAuth = memoryAuthState();
botAuth.creds.me = { id: "5511888888888@s.whatsapp.net" };
const sent: BinaryNode[] = [];
const events = new Emitter();
const layer = createMessagesLayer({
  events,
  auth: botAuth,
  crypto: C,
  sendNode: (n) => sent.push(n),
  genId: (() => {
    let i = 0;
    return () => `bot-${i++}`;
  })(),
});

const userAuth = memoryAuthState();
const userDeps: SignalDeps = { c: C, curve: makeCurve(C), storage: makeSignalStorage(userAuth) };

const otkId = 77;
{
  const kp = C.generateX25519();
  await botAuth.keys.set({ "pre-key": { [String(otkId)]: { public: kp.publicKey, private: kp.privateKey } } });
  const bundle: PreKeyBundle = {
    registrationId: botAuth.creds.registrationId,
    identityKey: prefixKey(botAuth.creds.signedIdentityKey.publicKey),
    signedPreKey: {
      keyId: botAuth.creds.signedPreKey.keyId,
      publicKey: prefixKey(botAuth.creds.signedPreKey.keyPair.publicKey),
      signature: botAuth.creds.signedPreKey.signature,
    },
    preKey: { keyId: otkId, publicKey: prefixKey(kp.publicKey) },
  };
  await initOutgoing(userDeps, "bot.0", bundle);
}

const upserts: any[] = [];
const reactions: any[] = [];
const deletes: any[] = [];
events.on("messages.upsert", (u) => upserts.push(u));
events.on("messages.reaction", (r) => reactions.push(r));
events.on("messages.delete", (d) => deletes.push(d));

const sendFromUser = async (msg: Parameters<typeof encodeE2EMessage>[0], id: string) => {
  const plain = encodeE2EMessage(msg);
  const padded = new Uint8Array(plain.length + 3);
  padded.set(plain);
  padded.fill(3, plain.length);
  const enc = await sigEncrypt(userDeps, "bot.0", padded);
  await layer.handleMessageStanza(
    node("message", { from: USER_JID, id, t: "1700000000" }, [
      node("enc", { v: "2", type: enc.type === 3 ? "pkmsg" : "msg" }, enc.body),
    ]),
  );
};

const reactedKey = { remoteJid: USER_JID, fromMe: true, id: "target-1" };
await sendFromUser({ reactionMessage: { key: reactedKey, text: "👍", senderTimestampMs: 1700000000000 } }, "r1");

ok("reação: NÃO virou messages.upsert", upserts.length === 0);
ok("reação: emitiu messages.reaction", reactions.length === 1);
ok("reação: key = mensagem reagida", reactions[0]?.key?.id === "target-1" && reactions[0]?.key?.fromMe === true);
ok("reação: reaction.text", reactions[0]?.reaction?.text === "👍");
ok("reação: reaction.key = stanza de quem reagiu", reactions[0]?.reaction?.key?.id === "r1" && reactions[0]?.reaction?.key?.remoteJid === USER_JID);
ok("reação: mandou <receipt> de entrega", sent.some((n) => n.tag === "receipt" && n.attrs.id === "r1"));

await sendFromUser({ protocolMessage: { key: { remoteJid: USER_JID, fromMe: false, id: "target-2" }, type: 0 } }, "d1");
ok("revoke: NÃO virou messages.upsert", upserts.length === 0);
ok("revoke: emitiu messages.delete", deletes.length === 1 && deletes[0]?.keys?.[0]?.id === "target-2");

// --- 3. sendReaction cifra de volta -------------------------------
sent.length = 0;
await layer.sendReaction(USER_JID, reactedKey, "🔥");
const reply = sent.find((n) => n.tag === "message");
ok("sendReaction emitiu <message>", !!reply);
const encChild = getBinaryNodeChild(reply, "enc");
ok("sendReaction: <message> tem <enc>", !!encChild && encChild.content instanceof Uint8Array);
{
  const clear = decodeE2EMessage(unpad(await decryptWhisperMessage(userDeps, "bot.0", encChild!.content as Uint8Array)));
  ok("sendReaction: usuário decifra a reação", clear.reactionMessage?.text === "🔥");
  ok("sendReaction: key da mensagem reagida preservada", clear.reactionMessage?.key?.id === "target-1");
  ok("sendReaction: senderTimestampMs preenchido", typeof clear.reactionMessage?.senderTimestampMs === "number" && clear.reactionMessage!.senderTimestampMs! > 0);
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/reaction [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
