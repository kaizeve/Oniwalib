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
import { node, getBinaryNodeChild, getBinaryNodeChildren, type BinaryNode } from "./frame/node";
import { jidDecode, isJidGroup, isJidNewsletter, isJidUser, isLidUser } from "./frame/jid";
import { utf8Decode } from "./frame/buffer";
import { encodeSignedDeviceIdentity, type ADVSignedDeviceIdentity } from "./proto/adv";
import {
  makeCurve,
  makeSignalStorage,
  encrypt as signalEncrypt,
  decryptWhisperMessage,
  decryptPreKeyWhisperMessage,
  initOutgoing,
  type SignalDeps,
  type LidStore,
} from "./signal/index";
import { buildPreKeyUploadNode, buildPreKeyFetchNode, parsePreKeyBundles } from "./signal/prekeys";
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
import { buildPollCreation } from "./polls";

export interface MessagesLayerOptions {
  events: Emitter;
  auth: AuthenticationState;
  crypto: Crypto;
  /** Envia um node cru na conexão ativa. */
  sendNode: (n: BinaryNode) => void;
  /** Gera um id de stanza único. */
  genId: () => string;
  /** Faz um `<iq>` e resolve no `<iq type=result>` de mesmo id. Sem isto,
   *  `assertSessions` (cold-send) não funciona — só dá pra responder quem já
   *  mandou mensagem. */
  query?: (n: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>;
  /** Devolve todos os device-jids dos participantes de um grupo (metadata +
   *  USYNC, cacheado). Se fornecido, `sendGroupMessage` fana o SKDM pra todos,
   *  não só pros que já têm sessão. */
  groupDevices?: (groupJid: string) => Promise<string[]>;
  /** Resolve todos os device-jids de uma lista de números (USYNC). Se
   *  fornecido, `sendStatus` fana o SKDM pra CADA device de cada destinatário
   *  — como a Baileys — em vez de só o device primário. Sem isto o cliente
   *  recebe o `skmsg` sem a sender key e mostra "sua versão não é compatível". */
  statusDevices?: (jids: string[]) => Promise<string[]>;
  /** Mapa número↔lid. Se fornecido, `sendStatus` resolve destinatários `@lid`
   *  para o número (que é o que o `statusJidList` espera) e as stanzas de
   *  entrada alimentam o mapa. */
  lid?: LidStore;
  /** Persiste `auth.creds` (após upload de pré-chaves). */
  saveCreds?: () => void | Promise<void>;
}

/** Opções comuns de envio: resposta citada, menções, mensagem temporária. */
export interface SendOptions {
  /** Cita uma mensagem: o cliente do outro lado mostra o "quote" em cima. */
  quoted?: { key: MessageKey; message?: E2EMessage };
  /** jids a @-mencionar (destacam e notificam). */
  mentions?: string[];
  /** Segundos de mensagem temporária (0 desliga). */
  ephemeralExpiration?: number;
  /** Marca como encaminhada. */
  forwarded?: boolean;
}

export interface MessagesLayer {
  handleMessageStanza(stanza: BinaryNode): Promise<void>;
  sendText(jid: string, text: string, opts?: SendOptions): Promise<{ id: string }>;
  /** Cifra e envia um `Message` qualquer (texto, botões, lista, …). `extra.id`
   *  força o id do `<message>`; `extra.editAttr` põe `edit="1"` (edição). */
  sendMessage(
    jid: string,
    msg: E2EMessage,
    extra?: { id?: string; editAttr?: boolean; opts?: SendOptions },
  ): Promise<{ id: string }>;
  /** Álbum: manda o container e cada mídia ligada a ele. Devolve os ids. */
  sendAlbum(
    jid: string,
    items: E2EMessage[],
    opts?: SendOptions,
  ): Promise<{ albumId: string; ids: string[] }>;
  /** Edita uma mensagem já enviada (só as nossas). `key` é a mensagem original;
   *  `newText` o novo texto. Vira um `protocolMessage` MESSAGE_EDIT (type 14). */
  editMessage(jid: string, key: MessageKey, newText: string): Promise<{ id: string }>;
  /** Apaga uma mensagem para todos (revoke). `key` é a mensagem a apagar. */
  deleteMessage(jid: string, key: MessageKey): Promise<{ id: string }>;
  /** Cria uma enquete. `selectableCount` 1 = escolha única, >1 = múltipla.
   *  Devolve o id da mensagem e a `pollEncKey` — GUARDE a chave: é ela que
   *  decifra os votos (`poll.update` → `decryptPollVote`). */
  sendPoll(
    jid: string,
    name: string,
    options: string[],
    selectableCount?: number,
  ): Promise<{ id: string; pollEncKey: Uint8Array }>;
  /** Garante que há sessão pairwise com cada `jid` (com device): para os que
   *  faltam, busca o bundle (`<iq xmlns="encrypt">`) e roda o X3DH. Precisa de
   *  `query`. Devolve os jids que ficaram SEM sessão (device fora do ar etc.). */
  assertSessions(jids: string[]): Promise<string[]>;
  /** Posta um status (`status@broadcast`). `recipients` é a lista de quem vai
   *  ver (JIDs de usuário / lid). Abre sessão com quem falta. Devolve o id e
   *  para quantos foi cifrado. */
  sendStatus(msg: E2EMessage, recipients: string[]): Promise<{ id: string; sentTo: number }>;
  /** Reage a uma mensagem. `emoji` vazio (`""`) remove a reação. */
  sendReaction(jid: string, key: MessageKey, emoji: string): Promise<{ id: string }>;
  uploadPreKeys(range?: number): Promise<void>;
  /** Servidor avisou que o estoque de pré-chaves baixou. */
  onEncryptNotification(): Promise<void>;
}

const S_WHATSAPP_NET = "@s.whatsapp.net";
const PREKEY_UPLOAD_COUNT = 30;
/** Se o servidor ainda tem pelo menos isto de pré-chave, não sobe mais. */
const PREKEY_LOW_WATERMARK = 10;
/** Intervalo mínimo entre uploads disparados por `<notification type=encrypt>`.
 *  Sem isto, uma tempestade de notificações incha o `auth.owl` (ids nas milhares)
 *  e trava o bot — foi o bug que derrubou o oni-bot em 2026-09-02. */
const PREKEY_UPLOAD_MIN_INTERVAL_MS = 10 * 60 * 1000;

export function createMessagesLayer(opts: MessagesLayerOptions): MessagesLayer {
  const { events, auth, crypto: c, sendNode, genId, query, groupDevices, statusDevices, lid } =
    opts;
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

  // Auto-heal de sessão pairwise dessincronizada. Depois de um re-pareamento ou
  // de mensagens perdidas, os dois lados podem ficar com sessões que não casam:
  // o par manda `<enc type=msg>` (acha que a sessão está viva) e aqui só dá
  // `Bad MAC` / "nenhuma sessão serviu", num loop que nunca cura sozinho. Ao
  // acumular `SESSION_HEAL_THRESHOLD` falhas seguidas desse tipo para um mesmo
  // endereço, a gente APAGA a sessão local — o próximo `pkmsg` do par reabre o
  // X3DH do zero. Identidade (TOFU) e sender keys ficam. Zera no primeiro
  // decrypt que der certo.
  const SESSION_HEAL_THRESHOLD = 3;
  const decryptFailStreak = new Map<string, number>();
  const looksLikeDesync = (m: string) =>
    m.includes("Bad MAC") || m.includes("nenhuma sessão serviu") || m.includes("No session record");

  async function healSession(addr: string): Promise<void> {
    decryptFailStreak.delete(addr);
    try {
      await auth.keys.set({ session: { [addr]: null } });
    } catch {
      return;
    }
    // eslint-disable-next-line no-console
    console.log(
      `messages: sessão com ${addr} apagada após ${SESSION_HEAL_THRESHOLD} falhas seguidas — ` +
        `aguardando o par reabrir (pkmsg)`,
    );
  }

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

    // CANAL (`@newsletter`): a mensagem NÃO é Signal — vem em `<plaintext>` com
    // o `proto.Message` cru (sem pad). Decodifica direto e emite `messages.upsert`.
    // O `newsletter_server_id` (`a.server_id`) é o id da mensagem no canal — útil
    // para reações/views depois; por ora vai no lugar do `id`.
    if (isJidNewsletter(from)) {
      const pt = getBinaryNodeChild(stanza, "plaintext");
      const bytes =
        pt?.content instanceof Uint8Array
          ? pt.content
          : stanza.content instanceof Uint8Array
            ? stanza.content
            : undefined;
      if (bytes && bytes.length > 0) {
        try {
          const msg = decodeE2EMessage(bytes);
          events.emit("messages.upsert", {
            type: "notify",
            messages: [
              {
                key: { remoteJid: from, fromMe: false, id: a.id },
                message: msg,
                messageTimestamp: a.t ? Number(a.t) : undefined,
                pushName: a.notify,
                ...(a.server_id ? { newsletterServerId: Number(a.server_id) } : {}),
              },
            ],
          });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(`messages: canal ${from} — plaintext ilegível:`, (e as Error).message);
        }
      }
      sendDeliveryReceipt(stanza);
      return;
    }

    const isGroup = isJidGroup(from);
    const author = a.participant || from;

    // número↔lid: quando o endereçamento é lid, a stanza traz o `@lid` no
    // `participant`/`from` e o número no atributo `*_pn` ao lado. Registra o par
    // (o store ignora o que não casar).
    if (lid) {
      void lid.remember(a.participant_pn, a.participant);
      void lid.remember(a.sender_pn ?? a.peer_recipient_pn, isGroup ? undefined : from);
      void lid.remember(a.recipient_pn, a.recipient);
    }
    const fromMe = isGroup
      ? sameUser(a.participant, auth.creds.me?.id)
      : sameUser(from, auth.creds.me?.id) && !!a.recipient;

    // conversa 1:1 de OUTRA pessoa → ela falou COM o bot: entra no roster
    // (audiência de status), persistido. Grupo e mensagem nossa não contam.
    if (lid && !isGroup && !fromMe) {
      void lid.noteContact(from);
      void lid.noteContact(a.sender_pn ?? a.peer_recipient_pn);
    }
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

      // Edição de mensagem (protocolMessage MESSAGE_EDIT, type 14).
      if (
        msg.protocolMessage &&
        msg.protocolMessage.type === 14 &&
        msg.protocolMessage.key &&
        msg.protocolMessage.editedMessage
      ) {
        events.emit("messages.update", [
          {
            key: toMsgKey(msg.protocolMessage.key, chatId),
            update: {
              message: msg.protocolMessage.editedMessage,
              editedTimestamp: msg.protocolMessage.timestampMs,
            },
          },
        ]);
        return msg;
      }

      // Voto em enquete (pollUpdateMessage) — vem cifrado; sai por `poll.update`.
      if (msg.pollUpdateMessage?.pollCreationMessageKey && msg.pollUpdateMessage.vote) {
        events.emit("poll.update", {
          pollCreationKey: toMsgKey(msg.pollUpdateMessage.pollCreationMessageKey, chatId),
          voterJid: author,
          vote: msg.pollUpdateMessage.vote,
          senderTimestampMs: msg.pollUpdateMessage.senderTimestampMs,
        });
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
          decryptFailStreak.delete(addr); // decifrou → sessão sã
          await absorbSkdm(deliver(ptPair));
        } catch (err) {
          const emsg = (err as Error).message;
          events.emit("messages.upsert", {
            type: "notify",
            messages: [{ key: baseKey, message: undefined, messageTimestamp }],
          });
          // eslint-disable-next-line no-console
          console.error(`messages: falha ao decifrar <enc type=${type}> de ${author}: ${emsg}`);

          // Sessão pairwise dessincronizada: conta as falhas seguidas e, no
          // limite, apaga a sessão para o próximo pkmsg do par reabrir.
          if (type === "msg" && looksLikeDesync(emsg)) {
            const n = (decryptFailStreak.get(addr) ?? 0) + 1;
            decryptFailStreak.set(addr, n);
            if (n >= SESSION_HEAL_THRESHOLD) await healSession(addr);
          }

          await sendRetryReceipt(stanza);
        }
      });
    }

    sendDeliveryReceipt(stanza);
  }

  async function sendText(
    jid: string,
    text: string,
    opts?: SendOptions,
  ): Promise<{ id: string }> {
    // com opções (quote/menção/efêmera) o texto vira extendedTextMessage, que é
    // quem carrega o contextInfo.
    const msg: E2EMessage = hasOpts(opts)
      ? { extendedTextMessage: { text } }
      : { conversation: text };
    return sendMessage(jid, msg, opts ? { opts } : undefined);
  }

  function hasOpts(o?: SendOptions): boolean {
    return !!o && (!!o.quoted || !!(o.mentions && o.mentions.length) || !!o.ephemeralExpiration || !!o.forwarded);
  }

  /** Aplica `SendOptions` no contextInfo da sub-mensagem primária. Muta `msg`. */
  function applyOpts(msg: E2EMessage, opts?: SendOptions): E2EMessage {
    if (!hasOpts(opts)) return msg;
    const ci: NonNullable<E2EMessage["extendedTextMessage"]>["contextInfo"] = {};
    if (opts!.quoted) {
      ci.stanzaId = opts!.quoted.key.id;
      ci.participant = opts!.quoted.key.participant ?? opts!.quoted.key.remoteJid;
      ci.remoteJid = opts!.quoted.key.remoteJid;
      if (opts!.quoted.message) ci.quotedMessage = opts!.quoted.message;
    }
    if (opts!.mentions?.length) ci.mentionedJid = opts!.mentions;
    if (opts!.ephemeralExpiration) ci.expiration = opts!.ephemeralExpiration;
    if (opts!.forwarded) ci.isForwarded = true;

    const holder =
      msg.extendedTextMessage ??
      msg.imageMessage ??
      msg.videoMessage ??
      msg.audioMessage ??
      msg.documentMessage ??
      msg.stickerMessage ??
      msg.albumMessage;
    if (holder) {
      holder.contextInfo = { ...(holder.contextInfo ?? {}), ...ci };
    } else if (msg.conversation !== undefined) {
      // conversation não tem contextInfo — promove p/ extendedTextMessage
      msg.extendedTextMessage = { text: msg.conversation, contextInfo: ci };
      delete msg.conversation;
    }
    return msg;
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

  // Cold-send: abre sessão pairwise com quem nunca falou conosco. Para cada jid
  // (com device) sem sessão, busca o bundle e roda o X3DH. Devolve os que ainda
  // ficaram sem sessão (bundle indisponível / device fora do ar).
  async function assertSessions(jids: string[]): Promise<string[]> {
    const safeAddr = (jid: string): string | undefined => {
      try {
        return signalAddress(jid);
      } catch {
        return undefined;
      }
    };

    const missing: string[] = [];
    for (const jid of jids) {
      const addr = safeAddr(jid);
      if (!addr) continue;
      const s = await deps.storage.loadSession(addr);
      if (!s || !s.getOpenSession()) missing.push(jid);
    }
    if (missing.length === 0) return [];
    if (!query) {
      throw new Error("assertSessions: sem `query` configurada — não dá para buscar o bundle de pré-chaves");
    }

    const res = await query(buildPreKeyFetchNode(missing));
    const parsed = parsePreKeyBundles(res);
    const byAddr = new Map<string, (typeof parsed)[string]>();
    for (const [bjid, bundle] of Object.entries(parsed)) {
      const a = safeAddr(bjid);
      if (a) byAddr.set(a, bundle);
    }

    const stillMissing: string[] = [];
    for (const jid of missing) {
      const addr = safeAddr(jid)!;
      const bundle = byAddr.get(addr);
      if (!bundle) {
        stillMissing.push(jid);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await serial(async () => {
        try {
          await initOutgoing(deps, addr, bundle);
        } catch (e) {
          stillMissing.push(jid);
          // eslint-disable-next-line no-console
          console.error(`messages: X3DH com ${jid} falhou:`, (e as Error).message);
        }
      });
    }
    return stillMissing;
  }

  async function sendMessage(
    jid: string,
    msg: E2EMessage,
    extra?: { id?: string; editAttr?: boolean; opts?: SendOptions },
  ): Promise<{ id: string }> {
    if (extra?.opts) applyOpts(msg, extra.opts);
    if (isJidNewsletter(jid)) return sendNewsletterMessage(jid, msg, extra);
    if (isJidGroup(jid)) return sendGroupMessage(jid, msg, extra);

    const addr = signalAddress(jid);
    const pre = await deps.storage.loadSession(addr);
    if ((!pre || !pre.getOpenSession()) && query) {
      await assertSessions([jid]);
    }

    return serial(async () => {
      const existing = await deps.storage.loadSession(addr);
      if (!existing || !existing.getOpenSession()) {
        throw new Error(
          `sendMessage: sem sessão com ${jid} e não consegui abrir uma` +
            (query ? " (bundle de pré-chaves indisponível)" : " (sem `query` para cold-send)"),
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

      const id = extra?.id ?? genId();
      const mAttrs: Record<string, string> = { id, to: jid, type: "text" };
      if (extra?.editAttr) mAttrs.edit = "1";
      sendNode(node("message", mAttrs, content));
      return { id };
    });
  }

  async function editMessage(
    jid: string,
    key: MessageKey,
    newText: string,
  ): Promise<{ id: string }> {
    return sendMessage(
      jid,
      {
        protocolMessage: {
          key: {
            remoteJid: key.remoteJid,
            fromMe: key.fromMe,
            id: key.id,
            participant: key.participant,
          },
          type: 14, // MESSAGE_EDIT
          editedMessage: { conversation: newText },
          timestampMs: Date.now(),
        },
      },
      { id: key.id, editAttr: true },
    );
  }

  async function sendPoll(
    jid: string,
    name: string,
    options: string[],
    selectableCount = 1,
  ): Promise<{ id: string; pollEncKey: Uint8Array }> {
    if (options.length < 2) throw new Error("sendPoll: precisa de pelo menos 2 opções");
    const { message, pollEncKey } = buildPollCreation(c, name, options, selectableCount);
    const { id } = await sendMessage(jid, message);
    return { id, pollEncKey };
  }

  // CANAL (`@newsletter`): não é Signal. `<message to=jid type=text>
  //   <plaintext>{proto.Message cru}</plaintext></message>`. Texto e MÍDIA
  // (a mídia já foi cifrada+subida pelo `media.build*`, só entra no proto).
  async function sendNewsletterMessage(
    jid: string,
    msg: E2EMessage,
    extra?: { id?: string; editAttr?: boolean },
  ): Promise<{ id: string }> {
    const id = extra?.id ?? genId();
    const mAttrs: Record<string, string> = { id, to: jid, type: "text" };
    if (extra?.editAttr) mAttrs.edit = "1";
    sendNode(
      node("message", mAttrs, [node("plaintext", {}, encodeE2EMessage(msg))]),
    );
    return { id };
  }

  async function sendAlbum(
    jid: string,
    items: E2EMessage[],
    opts?: SendOptions,
  ): Promise<{ albumId: string; ids: string[] }> {
    const media = items.filter((m) => m.imageMessage || m.videoMessage);
    if (media.length < 2) throw new Error("sendAlbum: precisa de pelo menos 2 imagens/vídeos");
    const imageCount = media.filter((m) => m.imageMessage).length;
    const videoCount = media.filter((m) => m.videoMessage).length;

    const { id: albumId } = await sendMessage(
      jid,
      { albumMessage: { expectedImageCount: imageCount, expectedVideoCount: videoCount } },
      opts ? { opts } : undefined,
    );

    const parentMessageKey: MessageKey = { remoteJid: jid, fromMe: true, id: albumId };

    const ids: string[] = [];
    for (const item of media) {
      const withAssoc: E2EMessage = {
        ...item,
        messageContextInfo: {
          ...(item.messageContextInfo ?? {}),
          messageAssociation: { associationType: 1, parentMessageKey },
        },
      };
      // eslint-disable-next-line no-await-in-loop
      const r = await sendMessage(jid, withAssoc);
      ids.push(r.id);
    }
    return { albumId, ids };
  }

  async function deleteMessage(jid: string, key: MessageKey): Promise<{ id: string }> {
    return sendMessage(jid, {
      protocolMessage: {
        key: {
          remoteJid: key.remoteJid,
          fromMe: key.fromMe,
          id: key.id,
          participant: key.participant,
        },
        type: 0, // REVOKE
      },
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
  async function sendGroupMessage(
    groupJid: string,
    msg: E2EMessage,
    extra?: { id?: string; editAttr?: boolean; opts?: SendOptions },
  ): Promise<{ id: string }> {
    // FORA do `serial`: se há resolvedor de devices do grupo (client.ts —
    // metadata + USYNC, com cache), abre sessão com todo device de todo membro
    // antes de fanar o SKDM. Sem isso, só alcança quem já tem sessão pairwise.
    let extraJids: string[] = [];
    if (groupDevices) {
      try {
        extraJids = await groupDevices(groupJid);
        if (extraJids.length) await assertSessions(extraJids);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`messages: grupo ${groupJid} — não resolvi os devices:`, (e as Error).message);
        extraJids = [];
      }
    }

    return serial(async () => {
      const meId = auth.creds.me?.id;
      if (!meId) throw new Error("sendGroupMessage: sem creds.me");
      const recName = `${groupJid}::${signalAddress(meId)}`;
      const rec = await loadSenderKey(recName);
      const skdm = createSenderKeyDistribution(c, rec); // idempotente
      const skCipher = groupEncrypt(c, rec, pad(encodeE2EMessage(msg)));
      await storeSenderKey(recName, rec);

      // Candidatos = cache em memória ∪ store durável ∪ devices resolvidos agora.
      const mem = await loadPeerMem(groupJid);
      const candidates = new Map<string, string>(); // addr -> jid
      for (const [a2, j2] of groupPeers.get(groupJid) ?? []) candidates.set(a2, j2);
      for (const j2 of [...Object.keys(mem), ...extraJids]) {
        try {
          candidates.set(signalAddress(j2), j2);
        } catch {
          /* jid estranho — ignora */
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

      const id = extra?.id ?? genId();
      const attrs: Record<string, string> = { id, to: groupJid, type: "text" };
      if (addressingMode) attrs.addressing_mode = addressingMode;
      if (extra?.editAttr) attrs.edit = "1";
      sendNode(node("message", attrs, content));
      return { id };
    });
  }

  // STATUS (`status@broadcast`) — mesma mecânica de sender key do grupo, mas o
  // "grupo" é `status@broadcast` e os destinatários são uma lista explícita (a
  // Baileys pede `statusJidList`). Abre sessão com quem falta via cold-send.
  async function sendStatus(
    msg: E2EMessage,
    recipients: string[],
  ): Promise<{ id: string; sentTo: number }> {
    const STATUS = "status@broadcast";
    const meId = auth.creds.me?.id;
    if (!meId) throw new Error("sendStatus: sem creds.me");

    // O `statusJidList` do WhatsApp é lista de NÚMERO. Um destinatário `@lid` só
    // serve se a gente já pareou o número dele (stanza de grupo / metadata) —
    // senão o cold-send não abre sessão e o status sai pra ninguém.
    const seen = new Set<string>();
    const targets: string[] = [];
    const unresolved: string[] = [];
    for (const r of recipients) {
      let jid: string | undefined;
      if (isJidUser(r)) jid = r;
      else if (isLidUser(r)) {
        // eslint-disable-next-line no-await-in-loop
        jid = (lid ? await lid.toPn(r) : undefined) ?? r;
        if (!isJidUser(jid)) unresolved.push(r);
      }
      if (!jid || seen.has(jid)) continue;
      seen.add(jid);
      targets.push(jid);
    }
    if (unresolved.length) {
      // eslint-disable-next-line no-console
      console.log(
        `sendStatus: ${unresolved.length} destinatário(s) sem número conhecido, ` +
          `tentando como lid: ${unresolved.join(", ")}`,
      );
    }
    if (targets.length === 0) throw new Error("sendStatus: lista de destinatários vazia");

    // A Baileys manda o SKDM do status pra CADA device de cada destinatário
    // (USYNC), não só o primário — senão o cliente recebe o `skmsg` sem a
    // sender key e renderiza "sua versão não é compatível".
    let deviceJids = targets;
    if (statusDevices) {
      try {
        const resolved = await statusDevices(targets);
        if (resolved.length) deviceJids = resolved;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(
          `sendStatus: não resolvi os devices, uso só o primário: ${(e as Error).message}`,
        );
      }
    }

    if (query) {
      try {
        await assertSessions(deviceJids);
      } catch {
        /* segue com quem já tem sessão */
      }
    }

    return serial(async () => {
      const recName = `${STATUS}::${signalAddress(meId)}`;
      const rec = await loadSenderKey(recName);
      const skdm = createSenderKeyDistribution(c, rec);
      const skCipher = groupEncrypt(c, rec, pad(encodeE2EMessage(msg)));
      await storeSenderKey(recName, rec);

      const skdmPlain = pad(
        encodeE2EMessage({
          senderKeyDistributionMessage: {
            groupId: STATUS,
            axolotlSenderKeyDistributionMessage: skdm,
          },
        }),
      );

      const toNodes: BinaryNode[] = [];
      let anyPkmsg = false;
      for (const jid of deviceJids) {
        let addr: string;
        try {
          addr = signalAddress(jid);
        } catch {
          continue;
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          const { type, body } = await signalEncrypt(deps, addr, skdmPlain);
          toNodes.push(
            node("to", { jid }, [
              node("enc", { v: "2", type: type === 3 ? "pkmsg" : "msg" }, body),
            ]),
          );
          if (type === 3) anyPkmsg = true;
        } catch {
          /* sem sessão com esse device */
        }
      }
      if (toNodes.length === 0) {
        throw new Error("sendStatus: nenhum destinatário com sessão (tente `assertSessions` antes)");
      }

      const content: BinaryNode[] = [
        node("participants", {}, toNodes),
        node("enc", { v: "2", type: "skmsg" }, skCipher),
      ];
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
      // status@broadcast é sempre pn-endereçado (statusJidList é número) — a
      // Baileys não põe addressing_mode aqui. `type` segue o conteúdo.
      const mediatype = msg.imageMessage ? "image" : msg.videoMessage ? "video" : undefined;
      const attrs: Record<string, string> = {
        id,
        to: STATUS,
        type: mediatype ? "media" : "text",
      };
      if (mediatype) attrs.mediatype = mediatype;
      sendNode(node("message", attrs, content));
      return { id, sentTo: toNodes.length };
    });
  }

  let lastPreKeyUpload = 0;
  let preKeyTopUpInFlight = false;

  async function uploadPreKeys(range = PREKEY_UPLOAD_COUNT): Promise<void> {
    return serial(async () => {
      const { node: iq, update, count } = await buildPreKeyUploadNode(auth, range, c);
      Object.assign(auth.creds, update);
      iq.attrs.id = genId();
      sendNode(iq);
      lastPreKeyUpload = Date.now();
      await opts.saveCreds?.();
      // eslint-disable-next-line no-console
      console.log(`messages: ${count} pré-chaves enviadas (próxima id ${auth.creds.nextPreKeyId})`);
    });
  }

  /** `<iq get xmlns=encrypt><count/></iq>` → quantas pré-chaves 1:1 o servidor
   *  ainda tem nossas. `undefined` se não deu pra perguntar. */
  async function queryPreKeyCount(): Promise<number | undefined> {
    if (!query) return undefined;
    try {
      const res = await query(
        node("iq", { to: S_WHATSAPP_NET, type: "get", xmlns: "encrypt" }, [node("count", {})]),
      );
      const cnt = getBinaryNodeChild(res, "count");
      const raw =
        cnt?.attrs.value ??
        res.attrs.value ??
        (cnt?.content instanceof Uint8Array
          ? utf8Decode(cnt.content)
          : typeof cnt?.content === "string"
            ? cnt.content
            : undefined);
      const n = raw === undefined ? NaN : Number(raw);
      return Number.isFinite(n) ? n : undefined;
    } catch {
      return undefined;
    }
  }

  // Servidor avisou que o estoque baixou. NÃO sobe cegamente — isso era um loop:
  // pergunta o `<count>` primeiro, respeita um intervalo mínimo, e um guard de
  // "já tem uma reposição em andamento" (duas chamadas quase juntas — pós-
  // `<success>` + notificação real — passavam as duas antes de qualquer upload).
  async function onEncryptNotification(): Promise<void> {
    if (preKeyTopUpInFlight) return;
    if (Date.now() - lastPreKeyUpload < PREKEY_UPLOAD_MIN_INTERVAL_MS) return;
    preKeyTopUpInFlight = true;
    try {
      const remaining = await queryPreKeyCount();
      if (remaining !== undefined) {
        // eslint-disable-next-line no-console
        console.log(`messages: servidor tem ${remaining} pré-chave(s) nossas`);
      }
      if (remaining !== undefined && remaining >= PREKEY_LOW_WATERMARK) return;
      await uploadPreKeys();
    } finally {
      preKeyTopUpInFlight = false;
    }
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
    sendAlbum,
    editMessage,
    deleteMessage,
    sendPoll,
    assertSessions,
    sendStatus,
    sendReaction,
    uploadPreKeys,
    onEncryptNotification,
  };
}
