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
// `SenderKeyRecord` e deciframos o segundo. RESPONDER em grupo (criar o nosso
// sender key + distribuir via USync/cold-send) continua sendo fase 2.
//
// O que a fase 1 ainda NÃO faz: enviar em grupo, retry receipts, USync, mídia.

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
        !msg.listResponseMessage;
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
            const plain = unpad(groupDecrypt(c, rec, body));
            await storeSenderKey(skName, rec);
            deliver(plain);
            return;
          }

          const plain = unpad(await decryptEnc(type, addr, body));
          await absorbSkdm(deliver(plain));
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
