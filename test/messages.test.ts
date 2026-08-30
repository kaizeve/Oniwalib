// Camada de mensagem (src/messages.ts) ponta a ponta, SEM socket: um "usuário"
// (parte Signal crua) cifra um <message><enc pkmsg>, a camada decifra e emite
// `messages.upsert` + manda <receipt>; depois `sendText` responde cifrado e o
// usuário decifra de volta.

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
import { encodeE2EMessage, decodeE2EMessage, messageText } from "../src/proto/e2e-message";
import {
  SenderKeyRecord,
  createSenderKeyDistribution,
  groupEncrypt,
} from "../src/signal/sender-key";

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
const str = (u: Uint8Array) => String.fromCharCode(...u);
const unpad = (e: Uint8Array) => e.subarray(0, e.length - e[e.length - 1]!);

const USER_JID = "5511999999999@s.whatsapp.net";

// --- bot ---
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

// --- usuário (parte Signal crua) ---
const userAuth = memoryAuthState();
const userDeps: SignalDeps = {
  c: C,
  curve: makeCurve(C),
  storage: makeSignalStorage(userAuth),
};

// bundle do bot: creds do bot + uma one-time prekey no cofre do bot
const otkId = 55;
{
  const kp = C.generateX25519();
  await botAuth.keys.set({
    "pre-key": { [String(otkId)]: { public: kp.publicKey, private: kp.privateKey } },
  });
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

// usuário manda "!ping" cifrado
const upserts: any[] = [];
events.on("messages.upsert", (u) => upserts.push(u));

{
  const plain = encodeE2EMessage({ conversation: "!ping" });
  const padded = new Uint8Array(plain.length + 3);
  padded.set(plain);
  padded.fill(3, plain.length);
  const enc = await sigEncrypt(userDeps, "bot.0", padded);
  ok("usuário produz pkmsg", enc.type === 3);

  const stanza = node(
    "message",
    { from: USER_JID, id: "m1", t: "1700000000", notify: "Fulano" },
    [node("enc", { v: "2", type: "pkmsg" }, enc.body)],
  );
  await layer.handleMessageStanza(stanza);
}

ok("emitiu messages.upsert", upserts.length === 1);
ok(
  "texto decifrado = !ping",
  upserts[0]?.messages?.[0]?.message?.conversation === "!ping",
  JSON.stringify(upserts[0]?.messages?.[0]?.message),
);
ok("pushName repassado", upserts[0]?.messages?.[0]?.pushName === "Fulano");
ok("key.remoteJid = jid do usuário", upserts[0]?.messages?.[0]?.key?.remoteJid === USER_JID);
ok("messageTimestamp veio do `t`", upserts[0]?.messages?.[0]?.messageTimestamp === 1700000000);

const receipt = sent.find((n) => n.tag === "receipt");
ok("mandou <receipt> de entrega", !!receipt && receipt.attrs.to === USER_JID && receipt.attrs.id === "m1");

// --- bot responde ---
sent.length = 0;
await layer.sendText(USER_JID, "pong 🏓");

const reply = sent.find((n) => n.tag === "message");
ok("sendText emitiu <message>", !!reply);
const encChild = getBinaryNodeChild(reply, "enc");
ok("<message> tem <enc>", !!encChild && encChild.content instanceof Uint8Array);
ok("<enc> é msg (bot já tem sessão)", encChild?.attrs.type === "msg");

{
  const body = encChild!.content as Uint8Array;
  const clear = decodeE2EMessage(unpad(await decryptWhisperMessage(userDeps, "bot.0", body)));
  ok("usuário decifra a resposta", clear.conversation === "pong 🏓", str(unpad(new Uint8Array(0))) + JSON.stringify(clear));
}

// --- bot responde com botões (sendMessage) ---
sent.length = 0;
await layer.sendMessage(USER_JID, {
  buttonsMessage: {
    contentText: "toque",
    buttons: [{ buttonId: "!ping", buttonText: { displayText: "🏓" }, type: 1 }],
  },
});
{
  const enc2 = getBinaryNodeChild(sent.find((n) => n.tag === "message"), "enc");
  const clear = decodeE2EMessage(
    unpad(await decryptWhisperMessage(userDeps, "bot.0", enc2!.content as Uint8Array)),
  );
  ok("sendMessage cifra buttonsMessage", clear.buttonsMessage?.buttons?.[0]?.buttonId === "!ping");
}

// sendText sem sessão → erro claro
{
  let threw = "";
  try {
    await layer.sendText("5510000000000@s.whatsapp.net", "oi");
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("sendText sem sessão lança", threw.includes("sem sessão"), threw);
}

// --- skmsg de grupo sem estado → retry receipt com <keys> ---
sent.length = 0;
{
  const GROUP = "12345-67890@g.us";
  const SENDER = "5511777777777@s.whatsapp.net";
  const junk = new Uint8Array(80);
  junk.fill(9);
  junk[0] = 0x33; // byte de versão plausível
  const stanza = node(
    "message",
    { from: GROUP, participant: SENDER, id: "g1", t: "1700000001" },
    [node("enc", { v: "2", type: "skmsg" }, junk)],
  );
  const nextPk = botAuth.creds.nextPreKeyId;
  await layer.handleMessageStanza(stanza);

  const receipt = sent.find((n) => n.tag === "receipt" && n.attrs.type === "retry");
  ok("mandou <receipt type=retry>", !!receipt);
  ok("retry: to = grupo, participant = remetente", receipt?.attrs.to === GROUP && receipt?.attrs.participant === SENDER);
  const retry = getBinaryNodeChild(receipt, "retry");
  ok("retry: count=1", retry?.attrs.count === "1");
  const keys = getBinaryNodeChild(receipt, "keys");
  ok("retry: tem <keys>", !!keys);
  ok("retry: <keys> traz type/identity/key/skey", ["type", "identity", "key", "skey"].every((t) => !!getBinaryNodeChild(keys, t)));
  ok("retry: consumiu uma pré-chave nova", botAuth.creds.nextPreKeyId === nextPk + 1);

  // segundo retry do mesmo id → count sobe
  sent.length = 0;
  await layer.handleMessageStanza(stanza);
  const r2 = getBinaryNodeChild(sent.find((n) => n.tag === "receipt" && n.attrs.type === "retry"), "retry");
  ok("retry: count=2 no reenvio", r2?.attrs.count === "2");
}

// --- LEITURA DE GRUPO ponta a ponta -----------------------------------
// SKDM avulso (stanza 1:1 do remetente, groupId dentro) → depois um <skmsg>
// no grupo → o bot decifra e emite o texto.
sent.length = 0;
upserts.length = 0;
{
  const GROUP = "999888777@g.us";
  // O "remetente" é o mesmo usuário que já tem sessão pairwise com o bot.
  const senderRec = new SenderKeyRecord();
  const skdmBytes = createSenderKeyDistribution(C, senderRec);

  // 1) SKDM cifrado 1:1 para o bot (from = usuário, NÃO o grupo).
  const skdmMsg = encodeE2EMessage({
    senderKeyDistributionMessage: {
      groupId: GROUP,
      axolotlSenderKeyDistributionMessage: skdmBytes,
    },
  });
  const padded = new Uint8Array(skdmMsg.length + 5);
  padded.set(skdmMsg);
  padded.fill(5, skdmMsg.length);
  const skdmEnc = await sigEncrypt(userDeps, "bot.0", padded);
  await layer.handleMessageStanza(
    node("message", { from: USER_JID, id: "sk1", t: "1700000010" }, [
      node("enc", { v: "2", type: skdmEnc.type === 3 ? "pkmsg" : "msg" }, skdmEnc.body),
    ]),
  );
  ok("SKDM avulso não vira upsert", upserts.length === 0);

  // 2) mensagem de grupo cifrada com sender key.
  const groupPlain = encodeE2EMessage({ conversation: "oi galera do grupo" });
  const gp = new Uint8Array(groupPlain.length + 7);
  gp.set(groupPlain);
  gp.fill(7, groupPlain.length);
  const skCiphertext = groupEncrypt(C, senderRec, gp);
  await layer.handleMessageStanza(
    node("message", { from: GROUP, participant: USER_JID, id: "g2", t: "1700000011" }, [
      node("enc", { v: "2", type: "skmsg" }, skCiphertext),
    ]),
  );

  const up = upserts.find((u) => u.messages?.[0]?.key?.id === "g2");
  ok("grupo: emitiu upsert", !!up);
  ok("grupo: texto decifrado", messageText(up?.messages?.[0]?.message) === "oi galera do grupo", JSON.stringify(up?.messages?.[0]?.message));
  ok("grupo: key.remoteJid = grupo", up?.messages?.[0]?.key?.remoteJid === GROUP);
  ok("grupo: key.participant = remetente", up?.messages?.[0]?.key?.participant === USER_JID);
  ok("grupo: sem retry (decifrou de primeira)", !sent.some((n) => n.attrs?.type === "retry"));
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/messages [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
