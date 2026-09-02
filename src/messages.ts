// A camada de mensagem — a cola entre a máquina de estados do WhatsApp
// (`client.ts`) e a camada Signal (`signal/`). É o análogo do
// `decrypt-wa-message` + trecho de `messages-send` da Baileys, no mínimo da
// fase 1: conversa 1:1 em texto.
//
//   handleMessageStanza(node)  decifra cada <enc> (pkmsg/msg/skmsg), tira o
//                              padding, decodifica o `Message`, emite
//                              `messages.upsert`, e manda o <receipt> de entrega.
//   sendText(jid, text)        cifra um `Message{conversation}` e envia
//                              `<message><enc>`. Precisa de sessão já aberta
//                              (responder quem mandou) — cold-send é fase 2.
//   uploadPreKeys()            sobe 30 pré-chaves; chamado no <success> e quando
//                              o servidor avisa que o estoque baixou.
//
// GRUPOS (LEITURA): a stanza de grupo traz dois <enc> — um pairwise
// (pkmsg/msg) com o `SenderKeyDistributionMessage` que inicia/roda a cadeia do
// remetente, e um `skmsg` com o conteúdo. Processamos o primeiro, guardamos o
// `SenderKeyRecord` e deciframos o segundo.
//
// GRUPOS (ESCRITA): `sendMessage` num jid `@g.us` cria o NOSSO sender key,
// cifra o conteúdo em `skmsg`, e distribui o SKDM 1:1 para cada participante
// com quem já temos sessão pairwise (os que mandaram o SKDM deles). Sem USync
// nem metadata do grupo — quem nunca falou no grupo desde que o bot conectou
// não recebe o nosso sender key até (re)aparecer.
//
// O que ainda NÃO faz: USync/cold-send (bundle de quem nunca falou), mídia.

import type { Emitter } from "./events/emitter";
import type { AuthenticationState } from "./auth/state";
import type { Crypto } from "./crypto/types";
import { node, getBinaryNodeChildren, type BinaryNode } from "./frame/node";
import { jidDecode, isJidGroup } from "./frame/jid";
import { encodeSignedDeviceIdentity, type ADVSignedDeviceIdentity } from "./proto/adv";
import {
  makeCurve,
  makeSignalStorage,
  encrypt as signalEncrypt,
  decryptWhisperMessage,
  decryptPreKeyWhisperMessage,
  type SignalDeps,
} from "./signal/index";
import { buildPreKeyUploadNode } from "./signal/prekeys";
import {
  SenderKeyRecord,
  processSenderKeyDistribution,
  groupDecrypt,
  createSenderKeyDistribution,
  groupEncrypt,
} from "./signal/sender-key";
import {
  decodeE2EMessage,
  encodeE2EMessage,
  type E2EMessage,
  type E2EMessageKey,
} from "./proto/e2e-message";
import type { MessageKey } from "./events/emitter";

export interface MessagesLayerOptions {
  events: Emitter;
  auth: AuthenticationState;
  crypto: Crypto;
  /** Envia um node cru na conexão ativa. */
  sendNode: (n: BinaryNode) => void;
  /** Gera um id de stanza único. */
  genId: () => string;
  /** Persiste `auth.creds` (após upload de pré-chaves). */
  saveCreds?: () => void | Promise<void>;
}

export interface MessagesLayer {
  handleMessageStanza(stanza: BinaryNode): Promise<void>;
  sendText(jid: string, text: string): Promise<{ id: string }>;
  /** Cifra e envia um `Message` qualquer (texto, botões, lista, …). */
  sendMessage(jid: string, msg: E2EMessage): Promise<{ id: string }>;
  /** Reage a uma mensagem. `emoji` vazio (`""`) remove a reação. */
  sendReaction(jid: string, key: MessageKey, emoji: string): Promise<{ id: string }>;
  uploadPreKeys(range?: number): Promise<void>;
  /** Servidor avisou que o estoque de pré-chaves baixou. */
  onEncryptNotification(): Promise<void>;
}

const PREKEY_UPLOAD_COUNT = 30;

export function createMessagesLayer(opts: MessagesLayerOptions): MessagesLayer {
  const { events, auth, crypto: c, sendNode, genId } = opts;
  const deps: SignalDeps = {
    c,
    curve: makeCurve(c),
    storage: makeSignalStorage(auth),
  };

  // Serializa TODAS as operações Signal — o Double Ratchet muta estado
  // compartilhado (o record) e não é reentrante.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  // Participantes de grupo com quem temos sessão pairwise — para eles a gente
  // consegue distribuir o NOSSO sender key ao responder no grupo. Cache em
  // memória (grupo -> addr -> jid); a fonte durável é `sender-key-memory`, que
  // guarda por grupo um mapa jid -> "já tem o nosso SKDM atual?" (à la Baileys).
  const groupPeers = new Map<string, Map<string, string>>();

  type PeerMem = Record<string, boolean>;
  const loadPeerMem = async (groupId: string): Promise<PeerMem> => {
    const { [groupId]: raw } = await auth.keys.get("sender-key-memory", [groupId]);
    return (raw as PeerMem) ?? {};
  };
  const savePeerMem = (groupId: string, mem: PeerMem): Promise<void> =>
    auth.keys.set({ "sender-key-memory": { [groupId]: mem } });

  // Registra `jid` como participante alcançável de `groupId` — só se de fato há
  // sessão pairwise (senão não dá pra mandar o SKDM). Persiste com flag `false`
  // (= conhecido, ainda sem o nosso SKDM).
  async function rememberGroupPeer(groupId: string, jid: string): Promise<void> {
    let addr: string;
    try {
      addr = signalAddress(jid);
    } catch {
      return; // jid sem user (server, etc.)
    }
    const sess = await deps.storage.loadSession(addr);
    if (!sess || !sess.getOpenSession()) return;
    let m = groupPeers.get(groupId);
    if (!m) {
      m = new Map();
      groupPeers.set(groupId, m);
    }
    if (m.get(addr) === jid) return;
    m.set(addr, jid);
    const mem = await loadPeerMem(groupId);
    if (!(jid in mem)) {
      mem[jid] = false;
      await savePeerMem(groupId, mem);
    }
  }

  const meUser = () => jidDecode(auth.creds.me?.id)?.user;
  const sameUser = (a?: string, b?: string) => {
    if (!a || !b) return false;
    const da = jidDecode(a);
    const db = jidDecode(b);
    return !!da?.user && da.user === db?.user;
  };

  function signalAddress(jid: string): string {
    const d = jidDecode(jid);
    if (!d || !d.user) throw new Error("messages: jid inválido: " + jid);
    const dt = d.domainType ?? 0;
    const user = dt !== 0 ? `${d.user}_${dt}` : d.user;
    return `${user}.${d.device ?? 0}`;
  }

  function unpad(e: Uint8Array): Uint8Array {
    if (e.length === 0) throw new Error("unpad: bytes vazios");
    const pad = e[e.length - 1]!;
    if (pad === 0 || pad > e.length) throw new Error(`unpad: ${e.length} bytes, pad diz ${pad}`);
    return e.subarray(0, e.length - pad);
  }
  function pad(msg: Uint8Array): Uint8Array {
    const padLen = (c.randomBytes(1)[0]! & 0x0f) + 1;
    const out = new Uint8Array(msg.length + padLen);
    out.set(msg);
    out.fill(padLen, msg.length);
    return out;
  }

  const sendDeliveryReceipt = (stanza: BinaryNode) => {
    const a = stanza.attrs;
    if (!a.id || !a.from) return;
    const attrs: Record<string, string> = { id: a.id, to: a.from };
    if (a.participant) attrs.participant = a.participant;
    try {
      sendNode(node("receipt", attrs));
    } catch {
      /* conexão caiu — ignora */
    }
  };

  const be = (n: number, len: number): Uint8Array => {
    const out = new Uint8Array(len);
    let r = n;
    for (let i = len - 1; i >= 0; i--) {
      out[i] = r & 0xff;
      r = Math.floor(r / 256);
    }
    return out;
  };

  // Uma pré-chave nova, avulsa (não entra no `<list>` de upload) — vai no
  // `<keys>` do retry para o remetente reabrir a sessão pairwise.
  async function mintRetryPreKey(): Promise<{ id: number; pub: Uint8Array }> {
    const id = auth.creds.nextPreKeyId;
    const kp = c.generateX25519();
    await auth.keys.set({
      "pre-key": { [String(id)]: { public: kp.publicKey, private: kp.privateKey } },
    });
    auth.creds.nextPreKeyId = id + 1;
    auth.creds.firstUnuploadedPreKeyId = Math.max(auth.creds.firstUnuploadedPreKeyId, id + 1);
    await opts.saveCreds?.();
    return { id, pub: kp.publicKey };
  }

  // Falhou ao decifrar → pede pro remetente reenviar. Leva `<registration>` e o
  // bloco `<keys>` (tipo, identidade, uma pré-chave nova, a signed pre-key e a
  // device-identity) — é o que o remetente precisa para reabrir a sessão
  // pairwise e reenviar, inclusive o SKDM de uma distribuição de grupo que a
  // gente nunca recebeu. Espelha `sendRetryRequest` da Baileys.
  const retryCounts = new Map<string, number>();
  const KEY_BUNDLE_TYPE = Uint8Array.from([5]);
  const sendRetryReceipt = async (stanza: BinaryNode): Promise<void> => {
    const a = stanza.attrs;
    if (!a.id || !a.from) return;
    const count = (retryCounts.get(a.id) ?? 0) + 1;
    if (count > 5) return;
    retryCounts.set(a.id, count);

    const attrs: Record<string, string> = { id: a.id, type: "retry", to: a.from };
    if (a.participant) attrs.participant = a.participant;
    if (a.recipient) attrs.recipient = a.recipient;

    const content: BinaryNode[] = [
      node("retry", { count: String(count), id: a.id, t: a.t ?? "0", v: "1" }),
      node("registration", {}, be(auth.creds.registrationId, 4)),
    ];

    try {
      const pk = await mintRetryPreKey();
      const sp = auth.creds.signedPreKey;
      const keysChildren: BinaryNode[] = [
        node("type", {}, KEY_BUNDLE_TYPE),
        node("identity", {}, auth.creds.signedIdentityKey.publicKey),
        node("key", {}, [node("id", {}, be(pk.id, 3)), node("value", {}, pk.pub)]),
        node("skey", {}, [
          node("id", {}, be(sp.keyId, 3)),
          node("value", {}, sp.keyPair.publicKey),
          node("signature", {}, sp.signature),
        ]),
      ];
      if (auth.creds.account) {
        keysChildren.push(
          node(
            "device-identity",
            {},
            encodeSignedDeviceIdentity(auth.creds.account as ADVSignedDeviceIdentity, true),
          ),
        );
      }
      content.push(node("keys", {}, keysChildren));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("messages: não consegui montar <keys> do retry:", (e as Error).message);
    }

    try {
      sendNode(node("receipt", attrs, content));
    } catch {
      /* conexão caiu — ignora */
    }
  };

  async function decryptEnc(type: string, addr: string, body: Uint8Array): Promise<Uint8Array> {
    if (type === "pkmsg") return decryptPreKeyWhisperMessage(deps, addr, body);
    if (type === "msg") return decryptWhisperMessage(deps, addr, body);
    throw new Error(`tipo de <enc> não suportado na fase 1: ${type}`);
  }

  async function handleMessageStanza(stanza: BinaryNode): Promise<void> {
    const a = stanza.attrs;
    const from = a.from;
    if (!from || !a.id) {
      sendDeliveryReceipt(stanza);
      return;
    }

    const isGroup = isJidGroup(from);
    const author = a.participant || from;
    const fromMe = isGroup
      ? sameUser(a.participant, auth.creds.me?.id)
      : sameUser(from, auth.creds.me?.id) && !!a.recipient;
    const chatId = isGroup ? from : fromMe ? a.recipient! : from;
    const addr = signalAddress(author);
    const skName = `${from}::${addr}`;
    // `t` do servidor, em segundos unix. Quem recebe usa para medir o atraso
    // WhatsApp→bot (o `!ping` reporta isso como latência).
    const messageTimestamp = a.t ? Number(a.t) : undefined;

    const encNodes = getBinaryNodeChildren(stanza, "enc").filter(
      (n) => n.content instanceof Uint8Array,
    );
    // pairwise antes de skmsg: o pkmsg/msg traz o SenderKeyDistributionMessage
    // que o skmsg precisa para decifrar.
    encNodes.sort((x, y) => rank(x.attrs.type) - rank(y.attrs.type));

    const baseKey: MessageKey = {
      remoteJid: chatId,
      fromMe,
      id: a.id,
      ...(a.participant ? { participant: a.participant } : {}),
    };

    // Decodifica o plaintext e emite `messages.upsert` — a menos que a mensagem
    // seja só um SenderKeyDistributionMessage (plumbing de grupo, sem conteúdo).
    const deliver = (plain: Uint8Array): E2EMessage => {
      let msg: E2EMessage = decodeE2EMessage(plain);
      if (msg.deviceSentMessage?.message) msg = msg.deviceSentMessage.message;

      // Reação: não é uma mensagem de chat — sai por `messages.reaction`.
      if (msg.reactionMessage?.key) {
        const r = msg.reactionMessage;
        events.emit("messages.reaction", {
          key: toMsgKey(r.key, chatId),
          reaction: { text: r.text, senderTimestampMs: r.senderTimestampMs, key: baseKey },
        });
        return msg;
      }

      // "Apagar para todos" (protocolMessage REVOKE, type 0).
      if (msg.protocolMessage && (msg.protocolMessage.type ?? 0) === 0 && msg.protocolMessage.key) {
        events.emit("messages.delete", { keys: [toMsgKey(msg.protocolMessage.key, chatId)] });
        return msg;
      }

      const bareSkdm =
        !!msg.senderKeyDistributionMessage &&
        !msg.conversation &&
        !msg.extendedTextMessage &&
        !msg.buttonsMessage &&
        !msg.listMessage &&
        !msg.buttonsResponseMessage &&
        !msg.listResponseMessage &&
        !msg.interactiveMessage &&
        !msg.interactiveResponseMessage &&
        !msg.templateButtonReplyMessage &&
        !msg.reactionMessage;
      if (!bareSkdm) {
        events.emit("messages.upsert", {
          type: "notify",
          messages: [{ key: baseKey, message: msg, messageTimestamp, pushName: a.notify }],
        });
      }
      return msg;
    };

    // Guarda a cadeia de um SenderKeyDistributionMessage. Ele chega ou junto do
    // `skmsg` (stanza de grupo, `groupId` = a própria stanza), ou avulso numa
    // stanza 1:1 do remetente (aí o `groupId` vem DENTRO do SKDM).
    const absorbSkdm = async (msg: E2EMessage): Promise<void> => {
      const skdm = msg.senderKeyDistributionMessage;
      if (!skdm?.axolotlSenderKeyDistributionMessage) return;
      const groupId = isGroup ? from : skdm.groupId;
      if (!groupId) return;
      const name = `${groupId}::${addr}`;
      const rec = await loadSenderKey(name);
      processSenderKeyDistribution(rec, skdm.axolotlSenderKeyDistributionMessage);
      await storeSenderKey(name, rec);
      // Temos sessão pairwise com quem mandou este SKDM → ele entra na lista de
      // quem recebe o NOSSO sender key quando formos responder no grupo.
      await rememberGroupPeer(groupId, author);
    };

    // Uma stanza por vez: os ratchets mutam estado e não são reentrantes.
    for (const enc of encNodes) {
      const type = enc.attrs.type ?? "msg";
      const body = enc.content as Uint8Array;
      // eslint-disable-next-line no-await-in-loop
      await serial(async () => {
        try {
          if (type === "skmsg") {
            const rec = await loadSenderKey(skName);
            const ptGroup = unpad(groupDecrypt(c, rec, body));
            await storeSenderKey(skName, rec);
            deliver(ptGroup);
            // Lemos este participante → se já temos sessão pairwise com ele,
            // registra como alcançável (sobrevive ao restart via store).
            await rememberGroupPeer(from, author);
            return;
          }

          const ptPair = unpad(await decryptEnc(type, addr, body));
          await absorbSkdm(deliver(ptPair));
        } catch (err) {
          events.emit("messages.upsert", {
            type: "notify",
            messages: [{ key: baseKey, message: undefined, messageTimestamp }],
          });
          // eslint-disable-next-line no-console
          console.error(
            `messages: falha ao decifrar <enc type=${type}> de ${author}: ${(err as Error).message}`,
          );
          await sendRetryReceipt(stanza);
        }
      });
    }

    sendDeliveryReceipt(stanza);
  }

  async function sendText(jid: string, text: string): Promise<{ id: string }> {
    return sendMessage(jid, { conversation: text });
  }

  async function sendReaction(
    jid: string,
    key: MessageKey,
    emoji: string,
  ): Promise<{ id: string }> {
    return sendMessage(jid, {
      reactionMessage: {
        key: {
          remoteJid: key.remoteJid,
          fromMe: key.fromMe,
          id: key.id,
          participant: key.participant,
        },
        text: emoji,
        senderTimestampMs: Date.now(),
      },
    });
  }

  async function sendMessage(jid: string, msg: E2EMessage): Promise<{ id: string }> {
    if (isJidGroup(jid)) return sendGroupMessage(jid, msg);
    return serial(async () => {
      const addr = signalAddress(jid);
      const existing = await deps.storage.loadSession(addr);
      if (!existing || !existing.getOpenSession()) {
        throw new Error(
          `sendMessage: sem sessão com ${jid}. Na fase 1 dá para responder quem já ` +
            `mandou mensagem; cold-send (buscar bundle) é fase 2.`,
        );
      }

      const plaintext = pad(encodeE2EMessage(msg));
      const { type, body } = await signalEncrypt(deps, addr, plaintext);
      const encType = type === 3 ? "pkmsg" : "msg";

      const content: BinaryNode[] = [node("enc", { v: "2", type: encType }, body)];
      if (type === 3 && auth.creds.account) {
        content.push(
          node(
            "device-identity",
            {},
            encodeSignedDeviceIdentity(auth.creds.account as ADVSignedDeviceIdentity, true),
          ),
        );
      }

      const id = genId();
      sendNode(node("message", { id, to: jid, type: "text" }, content));
      return { id };
    });
  }

  // Responder num GRUPO. Sem USync/metadata do grupo (fase 3): distribui o
  // nosso sender key só para os participantes com quem já temos sessão pairwise
  // (os que mandaram o SKDM deles). Estrutura da stanza espelha a Baileys:
  //   <message to="G@g.us" type="text">
  //     <participants><to jid=D><enc pkmsg|msg>{SKDM}</enc></to>…</participants>
  //     <enc type="skmsg">{groupEncrypt(conteúdo)}</enc>
  //     <device-identity/>            (só se algum <enc> foi pkmsg)
  //   </message>
  // Quem ainda não recebeu o nosso SKDM não decifra até (re)aparecer — mesma
  // limitação que a leitura de grupo tem hoje.
  async function sendGroupMessage(groupJid: string, msg: E2EMessage): Promise<{ id: string }> {
    return serial(async () => {
      const meId = auth.creds.me?.id;
      if (!meId) throw new Error("sendGroupMessage: sem creds.me");
      const recName = `${groupJid}::${signalAddress(meId)}`;
      const rec = await loadSenderKey(recName);
      const skdm = createSenderKeyDistribution(c, rec); // idempotente
      const skCipher = groupEncrypt(c, rec, pad(encodeE2EMessage(msg)));
      await storeSenderKey(recName, rec);

      // Candidatos = cache em memória ∪ o que está no store durável.
      const mem = await loadPeerMem(groupJid);
      const candidates = new Map<string, string>(); // addr -> jid
      for (const [a2, j2] of groupPeers.get(groupJid) ?? []) candidates.set(a2, j2);
      for (const j2 of Object.keys(mem)) {
        try {
          candidates.set(signalAddress(j2), j2);
        } catch {
          /* jid estranho no store — ignora */
        }
      }

      const skdmPlain = pad(
        encodeE2EMessage({
          senderKeyDistributionMessage: {
            groupId: groupJid,
            axolotlSenderKeyDistributionMessage: skdm,
          },
        }),
      );

      const toNodes: BinaryNode[] = [];
      let anyPkmsg = false;
      let addressingMode: string | undefined;
      for (const [addr, jid] of candidates) {
        if (jid.endsWith("@lid")) addressingMode = "lid";
        if (mem[jid] === true) continue; // já tem o nosso SKDM atual
        try {
          // eslint-disable-next-line no-await-in-loop
          const { type, body } = await signalEncrypt(deps, addr, skdmPlain);
          toNodes.push(
            node("to", { jid }, [node("enc", { v: "2", type: type === 3 ? "pkmsg" : "msg" }, body)]),
          );
          if (type === 3) anyPkmsg = true;
          mem[jid] = true;
        } catch {
          /* sem sessão com esse device — não dá pra distribuir agora */
        }
      }
      await savePeerMem(groupJid, mem);
      // eslint-disable-next-line no-console
      console.log(
        `messages: grupo ${groupJid} — SKDM p/ ${toNodes.length} device(s), ` +
          `${candidates.size} conhecido(s)`,
      );

      const content: BinaryNode[] = [];
      if (toNodes.length) content.push(node("participants", {}, toNodes));
      content.push(node("enc", { v: "2", type: "skmsg" }, skCipher));
      if (anyPkmsg && auth.creds.account) {
        content.push(
          node(
            "device-identity",
            {},
            encodeSignedDeviceIdentity(auth.creds.account as ADVSignedDeviceIdentity, true),
          ),
        );
      }

      const id = genId();
      const attrs: Record<string, string> = { id, to: groupJid, type: "text" };
      if (addressingMode) attrs.addressing_mode = addressingMode;
      sendNode(node("message", attrs, content));
      return { id };
    });
  }

  async function uploadPreKeys(range = PREKEY_UPLOAD_COUNT): Promise<void> {
    return serial(async () => {
      const { node: iq, update, count } = await buildPreKeyUploadNode(auth, range, c);
      Object.assign(auth.creds, update);
      iq.attrs.id = genId();
      sendNode(iq);
      await opts.saveCreds?.();
      // eslint-disable-next-line no-console
      console.log(`messages: ${count} pré-chaves enviadas (próxima id ${auth.creds.nextPreKeyId})`);
    });
  }

  async function onEncryptNotification(): Promise<void> {
    await uploadPreKeys();
  }

  // pkmsg(3) e msg(1) antes de skmsg(9): o pairwise traz o SKDM que o skmsg usa.
  function rank(type?: string): number {
    return type === "skmsg" ? 9 : type === "pkmsg" ? 0 : 1;
  }

  // MessageKey do fio → MessageKey do evento, com o chat como fallback do jid.
  function toMsgKey(k: E2EMessageKey | undefined, fallbackJid: string): MessageKey {
    return {
      remoteJid: k?.remoteJid || fallbackJid,
      fromMe: !!k?.fromMe,
      id: k?.id || "",
      ...(k?.participant ? { participant: k.participant } : {}),
    };
  }

  async function loadSenderKey(name: string): Promise<SenderKeyRecord> {
    const { [name]: raw } = await auth.keys.get("sender-key", [name]);
    return raw ? SenderKeyRecord.deserialize(raw) : new SenderKeyRecord();
  }

  async function storeSenderKey(name: string, rec: SenderKeyRecord): Promise<void> {
    await auth.keys.set({ "sender-key": { [name]: rec.serialize() } });
  }

  void meUser;

  return {
    handleMessageStanza,
    sendText,
    sendMessage,
    sendReaction,
    uploadPreKeys,
    onEncryptNotification,
  };
}
