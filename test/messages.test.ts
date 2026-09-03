// Camada de mensagem (src/messages.ts) ponta a ponta, SEM socket: um "usuário"
// (parte Signal crua) cifra um <message><enc pkmsg>, a camada decifra e emite
// `messages.upsert` + manda <receipt>; depois `sendText` responde cifrado e o
// usuário decifra de volta.

import { memoryAuthState } from "../src/auth/state";
import { crypto } from "../src/crypto";
import { Emitter } from "../src/events/emitter";
import {
  node,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  type BinaryNode,
} from "../src/frame/node";
import {
  makeCurve,
  makeSignalStorage,
  prefixKey,
  initOutgoing,
  encrypt as sigEncrypt,
  decryptWhisperMessage,
  decryptPreKeyWhisperMessage,
  type PreKeyBundle,
  type SignalDeps,
} from "../src/signal/index";
import { createMessagesLayer } from "../src/messages";
import { encodeE2EMessage, decodeE2EMessage, messageText } from "../src/proto/e2e-message";
import {
  SenderKeyRecord,
  createSenderKeyDistribution,
  groupEncrypt,
  groupDecrypt,
  processSenderKeyDistribution,
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

// --- sendText com opts: quote + menções + efêmera ---
sent.length = 0;
{
  await layer.sendText(USER_JID, "responde aí", {
    quoted: { key: { remoteJid: USER_JID, fromMe: false, id: "m1" }, message: { conversation: "pergunta" } },
    mentions: [USER_JID],
    ephemeralExpiration: 86400,
  });
  const m = sent.find((n) => n.tag === "message");
  const enc = getBinaryNodeChild(m, "enc");
  const clear = decodeE2EMessage(
    unpad(await decryptWhisperMessage(userDeps, "bot.0", enc!.content as Uint8Array)),
  );
  const ci = clear.extendedTextMessage?.contextInfo;
  ok("opts: virou extendedTextMessage", clear.extendedTextMessage?.text === "responde aí");
  ok("opts: quote stanzaId", ci?.stanzaId === "m1");
  ok("opts: quotedMessage", ci?.quotedMessage?.conversation === "pergunta");
  ok("opts: menção", ci?.mentionedJid?.[0] === USER_JID);
  ok("opts: efêmera", ci?.expiration === 86400);
}

// --- sendAlbum: container + filhos com messageAssociation ---
sent.length = 0;
{
  const img = (cap: string) => ({ imageMessage: { caption: cap, mediaKey: new Uint8Array(32) } });
  const { albumId, ids } = await layer.sendAlbum(USER_JID, [img("um"), img("dois"), img("três")]);
  ok("album: devolve albumId + 3 ids", !!albumId && ids.length === 3);
  const msgs = sent.filter((n) => n.tag === "message");
  ok("album: 4 <message> (1 container + 3)", msgs.length === 4);

  const container = decodeE2EMessage(
    unpad(await decryptWhisperMessage(userDeps, "bot.0", getBinaryNodeChild(msgs[0], "enc")!.content as Uint8Array)),
  );
  ok("album: container tem albumMessage(3 imgs)", container.albumMessage?.expectedImageCount === 3 && !container.albumMessage?.expectedVideoCount);

  const child = decodeE2EMessage(
    unpad(await decryptWhisperMessage(userDeps, "bot.0", getBinaryNodeChild(msgs[1], "enc")!.content as Uint8Array)),
  );
  ok("album: filho aponta pro container", child.messageContextInfo?.messageAssociation?.parentMessageKey?.id === albumId && child.messageContextInfo?.messageAssociation?.associationType === 1);
  ok("album: filho mantém a imagem", child.imageMessage?.caption === "um");
}

// --- editMessage: protocolMessage MESSAGE_EDIT + edit="1" ---
sent.length = 0;
{
  const origKey = { remoteJid: USER_JID, fromMe: true, id: "BOT_MSG_1" };
  await layer.editMessage(USER_JID, origKey, "texto corrigido");
  const m = sent.find((n) => n.tag === "message");
  ok("editMessage: <message edit=1>", m?.attrs.edit === "1");
  ok("editMessage: id = id da original", m?.attrs.id === "BOT_MSG_1");
  const enc = getBinaryNodeChild(m, "enc");
  const clear = decodeE2EMessage(
    unpad(await decryptWhisperMessage(userDeps, "bot.0", enc!.content as Uint8Array)),
  );
  ok("editMessage: protocolMessage type 14", clear.protocolMessage?.type === 14);
  ok("editMessage: key aponta pra original", clear.protocolMessage?.key?.id === "BOT_MSG_1");
  ok("editMessage: editedMessage tem o novo texto", clear.protocolMessage?.editedMessage?.conversation === "texto corrigido");
  ok("editMessage: timestampMs presente", typeof clear.protocolMessage?.timestampMs === "number");
}

// --- deleteMessage: protocolMessage REVOKE ---
sent.length = 0;
{
  await layer.deleteMessage(USER_JID, { remoteJid: USER_JID, fromMe: true, id: "BOT_MSG_2" });
  const m = sent.find((n) => n.tag === "message");
  ok("deleteMessage: sem edit attr", m?.attrs.edit === undefined);
  const enc = getBinaryNodeChild(m, "enc");
  const clear = decodeE2EMessage(
    unpad(await decryptWhisperMessage(userDeps, "bot.0", enc!.content as Uint8Array)),
  );
  ok("deleteMessage: protocolMessage type 0 (REVOKE)", (clear.protocolMessage?.type ?? 0) === 0);
  ok("deleteMessage: key da mensagem a apagar", clear.protocolMessage?.key?.id === "BOT_MSG_2");
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

  // --- ENVIO EM GRUPO ponta a ponta ---------------------------------
  // O bot já conhece USER_JID como peer do GROUP (o SKDM avulso acima).
  sent.length = 0;
  await layer.sendMessage(GROUP, { conversation: "resposta no grupo" });

  const gmsg = sent.find((n) => n.tag === "message" && n.attrs.to === GROUP);
  ok("envio grupo: <message to=grupo type=text>", !!gmsg && gmsg.attrs.type === "text");
  const parts = getBinaryNodeChild(gmsg, "participants");
  const toNode = getBinaryNodeChildren(parts, "to")[0];
  ok("envio grupo: <participants><to jid=usuário>", toNode?.attrs.jid === USER_JID);
  const pwEnc = getBinaryNodeChild(toNode, "enc");
  ok("envio grupo: enc pairwise (pkmsg|msg)", pwEnc?.attrs.type === "pkmsg" || pwEnc?.attrs.type === "msg");
  const skEnc = getBinaryNodeChildren(gmsg, "enc").find((e) => e.attrs.type === "skmsg");
  ok("envio grupo: <enc type=skmsg> com conteúdo", !!skEnc && skEnc.content instanceof Uint8Array);

  // lado do usuário: processa o SKDM do bot e decifra o skmsg
  const botToUserRec = new SenderKeyRecord();
  const pwPlain = unpad(await decryptWhisperMessage(userDeps, "bot.0", pwEnc!.content as Uint8Array));
  const botSkdm = decodeE2EMessage(pwPlain).senderKeyDistributionMessage;
  ok(
    "envio grupo: pairwise carrega o SKDM do bot",
    !!botSkdm?.axolotlSenderKeyDistributionMessage && botSkdm.groupId === GROUP,
  );
  processSenderKeyDistribution(botToUserRec, botSkdm!.axolotlSenderKeyDistributionMessage!);
  const clearG = decodeE2EMessage(unpad(groupDecrypt(C, botToUserRec, skEnc!.content as Uint8Array)));
  ok("envio grupo: usuário decifra a resposta do bot", clearG.conversation === "resposta no grupo", JSON.stringify(clearG));

  // 2ª mensagem no mesmo grupo: NÃO re-distribui o SKDM
  sent.length = 0;
  await layer.sendMessage(GROUP, { conversation: "segunda" });
  const g2msg = sent.find((n) => n.tag === "message" && n.attrs.to === GROUP);
  ok("envio grupo: 2ª msg sem <participants>", !getBinaryNodeChild(g2msg, "participants"));
  const sk2 = getBinaryNodeChildren(g2msg, "enc").find((e) => e.attrs.type === "skmsg");
  const clearG2 = decodeE2EMessage(unpad(groupDecrypt(C, botToUserRec, sk2!.content as Uint8Array)));
  ok("envio grupo: usuário decifra a 2ª (mesma cadeia)", clearG2.conversation === "segunda");
}

// --- cold-send: sem sessão + query → busca bundle, abre X3DH, manda pkmsg ---
{
  const coldAuth = memoryAuthState();
  coldAuth.creds.me = { id: "5511777770000@s.whatsapp.net" };
  const coldSent: BinaryNode[] = [];
  let fetchAsked: BinaryNode | undefined;

  // "parte remota" com quem o cold bot nunca falou
  const remoteAuth = memoryAuthState();
  const remoteDeps: SignalDeps = { c: C, curve: makeCurve(C), storage: makeSignalStorage(remoteAuth) };
  const remoteOtk = C.generateX25519();
  const REMOTE = "5511555554444@s.whatsapp.net";

  const query = async (n: BinaryNode): Promise<BinaryNode> => {
    fetchAsked = n;
    // responde o <iq xmlns=encrypt> com o bundle da parte remota (device 0)
    const be = (x: number, len: number) => {
      const a = new Uint8Array(len);
      let r = x;
      for (let i = len - 1; i >= 0; i--) { a[i] = r & 0xff; r = Math.floor(r / 256); }
      return a;
    };
    return node("iq", { type: "result", id: n.attrs.id ?? "1" }, [
      node("list", {}, [
        node("user", { jid: REMOTE }, [
          node("registration", {}, be(remoteAuth.creds.registrationId, 4)),
          node("type", {}, Uint8Array.from([5])),
          node("identity", {}, remoteAuth.creds.signedIdentityKey.publicKey),
          node("skey", {}, [
            node("id", {}, be(remoteAuth.creds.signedPreKey.keyId, 3)),
            node("value", {}, remoteAuth.creds.signedPreKey.keyPair.publicKey),
            node("signature", {}, remoteAuth.creds.signedPreKey.signature),
          ]),
          node("key", {}, [node("id", {}, be(4141, 3)), node("value", {}, remoteOtk.publicKey)]),
        ]),
      ]),
    ]);
  };
  await remoteAuth.keys.set({ "pre-key": { "4141": { public: remoteOtk.publicKey, private: remoteOtk.privateKey } } });

  const coldLayer = createMessagesLayer({
    events: new Emitter(),
    auth: coldAuth,
    crypto: C,
    sendNode: (n) => coldSent.push(n),
    genId: (() => { let i = 0; return () => `cold-${i++}`; })(),
    query,
  });

  const left = await coldLayer.assertSessions([REMOTE]);
  ok("cold-send: assertSessions abriu a sessão (nada sobrou)", left.length === 0, JSON.stringify(left));
  ok("cold-send: perguntou <iq xmlns=encrypt> get", fetchAsked?.attrs.xmlns === "encrypt" && fetchAsked?.attrs.type === "get");

  await coldLayer.sendText(REMOTE, "oi, primeira vez");
  const coldMsg = coldSent.find((n) => n.tag === "message");
  const enc = getBinaryNodeChildren(coldMsg, "enc")[0];
  ok("cold-send: mandou <message><enc type=pkmsg>", enc?.attrs.type === "pkmsg");

  // a parte remota decifra o pkmsg → prova que o X3DH fechou dos dois lados
  const clear = decodeE2EMessage(
    unpad(await decryptPreKeyWhisperMessage(remoteDeps, coldAddr(coldAuth), enc!.content as Uint8Array)),
  );
  ok("cold-send: parte remota decifra o texto", clear.conversation === "oi, primeira vez", JSON.stringify(clear));
}

function coldAddr(a: ReturnType<typeof memoryAuthState>): string {
  const u = a.creds.me!.id.split("@")[0]!.split(":")[0];
  return `${u}.0`;
}

function bundleIq(remote: ReturnType<typeof memoryAuthState>, jid: string, otkPub: Uint8Array, id: string): BinaryNode {
  const be = (x: number, len: number) => {
    const a = new Uint8Array(len);
    let r = x;
    for (let i = len - 1; i >= 0; i--) { a[i] = r & 0xff; r = Math.floor(r / 256); }
    return a;
  };
  return node("iq", { type: "result", id }, [
    node("list", {}, [
      node("user", { jid }, [
        node("registration", {}, be(remote.creds.registrationId, 4)),
        node("type", {}, Uint8Array.from([5])),
        node("identity", {}, remote.creds.signedIdentityKey.publicKey),
        node("skey", {}, [
          node("id", {}, be(remote.creds.signedPreKey.keyId, 3)),
          node("value", {}, remote.creds.signedPreKey.keyPair.publicKey),
          node("signature", {}, remote.creds.signedPreKey.signature),
        ]),
        node("key", {}, [node("id", {}, be(9191, 3)), node("value", {}, otkPub)]),
      ]),
    ]),
  ]);
}

// --- envio em grupo com groupDevices: fana o SKDM p/ device sem sessão -----
{
  const G = "999000111@g.us";
  const gdAuth = memoryAuthState();
  gdAuth.creds.me = { id: "5511333330000@s.whatsapp.net" };
  const gdSent: BinaryNode[] = [];

  const NEW = "5511222221111@s.whatsapp.net"; // membro que nunca falou
  const newAuth = memoryAuthState();
  const newDeps: SignalDeps = { c: C, curve: makeCurve(C), storage: makeSignalStorage(newAuth) };
  const newOtk = C.generateX25519();
  await newAuth.keys.set({ "pre-key": { "9191": { public: newOtk.publicKey, private: newOtk.privateKey } } });

  const query = async (n: BinaryNode) => bundleIq(newAuth, NEW, newOtk.publicKey, n.attrs.id ?? "1");
  let askedGroup = "";
  const groupDevices = async (jid: string) => { askedGroup = jid; return [NEW]; };

  const gdLayer = createMessagesLayer({
    events: new Emitter(), auth: gdAuth, crypto: C,
    sendNode: (x) => gdSent.push(x),
    genId: (() => { let i = 0; return () => `gd-${i++}`; })(),
    query, groupDevices,
  });

  await gdLayer.sendMessage(G, { conversation: "oi grupo" });

  ok("grupo+groupDevices: resolveu os devices do grupo", askedGroup === G);
  const gm = gdSent.find((x) => x.tag === "message" && x.attrs.to === G);
  const to = getBinaryNodeChildren(getBinaryNodeChild(gm, "participants"), "to")[0];
  ok("grupo+groupDevices: SKDM fanou p/ o membro novo (cold-send)", to?.attrs.jid === NEW);
  ok("grupo+groupDevices: enc pkmsg (sessão recém-aberta)", getBinaryNodeChild(to, "enc")?.attrs.type === "pkmsg");
  ok("grupo+groupDevices: <enc type=skmsg> presente", getBinaryNodeChildren(gm, "enc").some((e) => e.attrs.type === "skmsg"));

  // o membro novo decifra: SKDM + skmsg
  const rec = new SenderKeyRecord();
  const pw = unpad(await decryptPreKeyWhisperMessage(newDeps, coldAddr(gdAuth), getBinaryNodeChild(to, "enc")!.content as Uint8Array));
  const skdm = decodeE2EMessage(pw).senderKeyDistributionMessage;
  processSenderKeyDistribution(rec, skdm!.axolotlSenderKeyDistributionMessage!);
  const sk = getBinaryNodeChildren(gm, "enc").find((e) => e.attrs.type === "skmsg");
  const clear = decodeE2EMessage(unpad(groupDecrypt(C, rec, sk!.content as Uint8Array)));
  ok("grupo+groupDevices: membro novo decifra o texto", clear.conversation === "oi grupo", JSON.stringify(clear));
}

// --- canal (@newsletter): <plaintext> sem Signal → messages.upsert ---------
{
  const CHAN = "120363000000000001@newsletter";
  const plain = encodeE2EMessage({ conversation: "aviso do canal" });
  const stanza = node(
    "message",
    { from: CHAN, id: "n1", t: "1700001234", server_id: "42", notify: "Meu Canal" },
    [node("plaintext", {}, plain)],
  );
  const before = upserts.length;
  await layer.handleMessageStanza(stanza);
  const u = upserts[upserts.length - 1];
  ok("canal: emitiu messages.upsert", upserts.length === before + 1);
  ok("canal: remoteJid = jid do canal", u?.messages?.[0]?.key?.remoteJid === CHAN);
  ok("canal: texto do <plaintext>", u?.messages?.[0]?.message?.conversation === "aviso do canal");
  ok("canal: newsletterServerId = server_id", u?.messages?.[0]?.newsletterServerId === 42);
  ok("canal: manda <receipt> de entrega", sent.some((n) => n.tag === "receipt" && n.attrs.id === "n1"));
}

// --- status (status@broadcast): fan-out por sender key --------------------
{
  // `layer` (bot) já abriu sessão com USER_JID ao processar o pkmsg lá em cima.
  sent.length = 0;
  const r = await layer.sendStatus({ conversation: "meu status" }, [USER_JID]);
  ok("status: cifrou para 1 destinatário", r.sentTo === 1);
  const stMsg = sent.find((n) => n.tag === "message" && n.attrs.to === "status@broadcast");
  ok("status: <message to=status@broadcast>", !!stMsg);
  const parts = getBinaryNodeChildren(getBinaryNodeChild(stMsg, "participants"), "to");
  ok("status: <participants><to jid=USER><enc></to>", parts[0]?.attrs.jid === USER_JID &&
    getBinaryNodeChild(parts[0], "enc") !== undefined);
  ok("status: <enc type=skmsg> no corpo", getBinaryNodeChildren(stMsg, "enc").some((e) => e.attrs.type === "skmsg"));

  let threw = "";
  try { await layer.sendStatus({ conversation: "x" }, []); } catch (e) { threw = (e as Error).message; }
  ok("status: lista vazia lança", threw.includes("destinatários"), threw);
}

// --- onEncryptNotification NÃO faz loop de upload de pré-chave -------------
{
  const pkAuth = memoryAuthState();
  pkAuth.creds.me = { id: "5511444440000@s.whatsapp.net" };
  const pkSent: BinaryNode[] = [];
  let countValue = "50";
  const query = async (n: BinaryNode): Promise<BinaryNode> => {
    if (getBinaryNodeChild(n, "count")) {
      return node("iq", { type: "result", id: n.attrs.id ?? "1" }, [node("count", { value: countValue })]);
    }
    return node("iq", { type: "result", id: n.attrs.id ?? "1" });
  };
  const pkLayer = createMessagesLayer({
    events: new Emitter(), auth: pkAuth, crypto: C,
    sendNode: (x) => pkSent.push(x),
    genId: (() => { let i = 0; return () => `pk-${i++}`; })(),
    query,
  });

  const upserts0 = pkSent.length;
  // servidor ainda tem 50 pré-chaves → não sobe nada
  await pkLayer.onEncryptNotification();
  ok("encrypt-notif: count alto → NÃO sobe pré-chave", !pkSent.some((n) => n.tag === "iq" && n.attrs.xmlns === "encrypt" && n.attrs.type === "set"));

  // agora o servidor diz que só tem 3 → sobe UMA vez
  countValue = "3";
  await pkLayer.onEncryptNotification();
  const uploads1 = pkSent.filter((n) => n.tag === "iq" && n.attrs.xmlns === "encrypt" && n.attrs.type === "set").length;
  ok("encrypt-notif: count baixo → sobe pré-chave", uploads1 === 1);

  // segunda notificação logo em seguida → rate-limit, NÃO sobe de novo
  await pkLayer.onEncryptNotification();
  const uploads2 = pkSent.filter((n) => n.tag === "iq" && n.attrs.xmlns === "encrypt" && n.attrs.type === "set").length;
  ok("encrypt-notif: 2ª em seguida → rate-limit (sem 2º upload)", uploads2 === 1);
  void upserts0;
}

// --- auto-heal: sessão pairwise dessincronizada é apagada após N falhas -----
{
  // o bot tem sessão com USER_JID (do pkmsg lá no começo). Simula o par
  // mandando `<enc type=msg>` que não decifra (Bad MAC) — 3x seguidas.
  const ADDR = "5511999999999.0";
  const had = await botAuth.keys.get("session", [ADDR]);
  ok("auto-heal: bot começa COM sessão", !!had[ADDR]);

  const garbageMsg = () =>
    node("message", { from: USER_JID, id: `bad-${Math.random()}`, t: "1700009999" }, [
      node("enc", { v: "2", type: "msg" }, C.randomBytes(48)),
    ]);

  await layer.handleMessageStanza(garbageMsg());
  await layer.handleMessageStanza(garbageMsg());
  const mid = await botAuth.keys.get("session", [ADDR]);
  ok("auto-heal: 2 falhas ainda NÃO apagam", !!mid[ADDR]);

  await layer.handleMessageStanza(garbageMsg());
  const after = await botAuth.keys.get("session", [ADDR]);
  ok("auto-heal: 3ª falha apaga a sessão", !after[ADDR]);
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
