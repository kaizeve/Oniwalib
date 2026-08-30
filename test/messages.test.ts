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
