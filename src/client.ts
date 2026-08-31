// openWhatsApp — o driver de conexão. Junta `connectOni` (transporte + Noise) com
// a máquina de estados do WhatsApp Web: QR, pareamento, o restart 515, login já
// registrado, keepalive e acks. É o análogo do `makeWASocket` da Baileys, no
// mínimo necessário para: mostrar o QR, parear de verdade, e voltar autenticado
// (`<success>`).
//
// O QUE ISTO NÃO FAZ: decifrar `<message>` (libsignal — issue #5). Stanzas de
// mensagem chegam, são "ackadas" para o servidor não repetir, e repassadas cruas
// em `events.on("node.recv")`. Ler o texto exige a camada Signal.

import { Emitter, type MessageKey, type WAPresence } from "./events/emitter";
import { connectOni } from "./connect";
import { configureSuccessfulPairing } from "./pairing";
import { createMessagesLayer, type MessagesLayer } from "./messages";
import {
  createMediaLayer,
  type MediaLayer,
  type FetchLike,
  type AudioOptions,
  type ImageOptions,
  type VideoOptions,
  type DocumentOptions,
  type StickerOptions,
} from "./media";
import { createProfileLayer, type ProfileLayer } from "./profile";
import { createPresenceLayer, type PresenceLayer } from "./presence";
import { createNotificationsLayer, type NotificationsLayer } from "./notifications";
import type { E2EMessage } from "./proto/e2e-message";
import { crypto as defaultCrypto } from "./crypto";
import type { Crypto } from "./crypto/types";
import type { AuthenticationState } from "./auth/state";
import type { OniVersion } from "./version";
import type { ClientProfile } from "./profiles/index";
import type { Connector } from "./transport/types";
import type { NoiseSocket } from "./noise/socket";
import {
  node,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  type BinaryNode,
} from "./frame/node";
import { utf8Decode } from "./frame/buffer";

const S_WHATSAPP_NET = "@s.whatsapp.net";
const ACKABLE = new Set(["message", "receipt", "notification", "call", "ack"]);

// Códigos de `<failure>` / `<stream:error>` que são definitivos — não adianta
// reconectar (a sessão foi invalidada; precisa parear de novo).
const LOGOUT_CODES = new Set(["401", "403", "405", "conflict", "device_removed"]);

export interface OpenOptions {
  auth: AuthenticationState;
  /** Persiste `auth.creds`. Chamado após o pareamento e após cada `<success>`. */
  saveCreds?: () => void | Promise<void>;
  profile?: ClientProfile;
  /** Fixa a versão do protocolo (pula o fetch de `resolveOniVersion`). */
  version?: OniVersion;
  connector?: Connector;
  countryCode?: string;
  crypto?: Crypto;
  /** Cliente HTTP para upload de mídia. Default `globalThis.fetch`. Sem ele,
   *  `sendAudio` lança (o núcleo não assume um global de rede). */
  fetch?: FetchLike;
  /** ms entre pings de keepalive. Default 25000. */
  keepAliveMs?: number;
  /** Máx. de reconexões automáticas seguidas antes de desistir. Default 5. */
  maxRetries?: number;
  /** ms até trocar o QR pelo próximo ref. Default 60000 no 1º, 20000 depois. */
  qrTimeoutMs?: number;
  /** Timeout do connect do transporte, em ms. Default 20000. */
  connectTimeoutMs?: number;
}

export interface OniConnection {
  readonly events: Emitter;
  /** Envia um node cru na conexão ativa. Lança se não estiver aberta. */
  sendNode(n: BinaryNode): void;
  /** Cifra e envia um texto 1:1. Precisa de sessão Signal já aberta com `jid`
   *  (fase 1: responder quem mandou mensagem). Emite nada; devolve o id. */
  sendText(jid: string, text: string): Promise<{ id: string }>;
  /** Como `sendText`, mas com um `Message` inteiro — botões, lista, viewOnce… */
  sendMessage(jid: string, msg: E2EMessage): Promise<{ id: string }>;
  /** Cifra + sobe um anexo ao servidor de mídia e envia (1:1 ou grupo). Precisa
   *  de `fetch` (default `globalThis.fetch`) e de sessão Signal com `jid`. */
  sendAudio(jid: string, data: Uint8Array, opts?: AudioOptions): Promise<{ id: string }>;
  sendImage(jid: string, data: Uint8Array, opts?: ImageOptions): Promise<{ id: string }>;
  sendVideo(jid: string, data: Uint8Array, opts?: VideoOptions): Promise<{ id: string }>;
  sendDocument(jid: string, data: Uint8Array, opts?: DocumentOptions): Promise<{ id: string }>;
  sendSticker(jid: string, data: Uint8Array, opts?: StickerOptions): Promise<{ id: string }>;
  /** Troca a sua foto de perfil (JPEG, idealmente quadrado ~640px). */
  setProfilePicture(jpeg: Uint8Array): Promise<void>;
  /** Remove a sua foto de perfil. */
  removeProfilePicture(): Promise<void>;
  /** Define o seu recado / bio. */
  setBio(text: string): Promise<void>;
  /** Reage a uma mensagem (`emoji` vazio remove a reação). Precisa de sessão. */
  sendReaction(jid: string, key: MessageKey, emoji: string): Promise<{ id: string }>;
  /** Anuncia a nossa presença. `available`/`unavailable` é global; `composing`/
   *  `recording`/`paused` é por chat e exige `toJid`. */
  sendPresenceUpdate(type: WAPresence, toJid?: string): void;
  /** Pede ao servidor a presença de `jid` (senão os `<presence>` dele não vêm). */
  subscribePresence(jid: string): void;
  /** Fecha e não reconecta. */
  end(err?: Error): void;
  readonly state: "connecting" | "open" | "close";
}

export function openWhatsApp(opts: OpenOptions): OniConnection {
  const events = new Emitter();
  const c = opts.crypto ?? defaultCrypto();
  const { auth } = opts;
  const keepAliveMs = opts.keepAliveMs ?? 25000;
  const maxRetries = opts.maxRetries ?? 5;

  const idPrefix =
    Array.from(c.randomBytes(3), (b) => b.toString(16).padStart(2, "0")).join("") + "-";
  let tagCounter = 0;
  const genId = () => idPrefix + (tagCounter++).toString();

  let state: OniConnection["state"] = "connecting";
  let stopped = false;
  let retries = 0;
  let connecting = false;
  let expectRestart = false;

  let socket: NoiseSocket | undefined;
  let unbind: Array<() => void> = [];
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let qrTimer: ReturnType<typeof setTimeout> | undefined;

  // `<iq>` à espera de resposta, por id. Resolvido no `<iq type=result|error>`
  // com o mesmo id (ver `handleNode`), ou rejeitado no timeout / teardown.
  const pendingIq = new Map<
    string,
    { resolve: (n: BinaryNode) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const failPendingIq = (reason: string) => {
    for (const [, p] of pendingIq) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    pendingIq.clear();
  };

  const clearTimers = () => {
    if (keepAlive) clearInterval(keepAlive);
    if (qrTimer) clearTimeout(qrTimer);
    keepAlive = undefined;
    qrTimer = undefined;
  };

  const teardown = () => {
    clearTimers();
    failPendingIq("conexão reiniciada antes da resposta do <iq>");
    for (const off of unbind) off();
    unbind = [];
    try {
      socket?.close();
    } catch {
      /* já fechado */
    }
    socket = undefined;
  };

  const end = (err?: Error) => {
    if (stopped) return;
    stopped = true;
    state = "close";
    teardown();
    events.emit("connection.update", {
      connection: "close",
      lastDisconnect: err ? { error: err, date: new Date() } : undefined,
    });
  };

  const send = (n: BinaryNode) => {
    if (!socket || socket.status !== "open") {
      throw new Error(`sendNode: conexão em estado ${socket?.status ?? "idle"}`);
    }
    socket.sendNode(n);
  };

  // Envia um `<iq>` e resolve com o `<iq type=result>` de mesmo id. O
  // `handleNode` casa a resposta pelo id em `pendingIq`.
  const query = (n: BinaryNode, timeoutMs = 20000): Promise<BinaryNode> => {
    const id = n.attrs.id || genId();
    n.attrs.id = id;
    return new Promise<BinaryNode>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingIq.delete(id);
        reject(new Error(`iq ${id}: sem resposta em ${timeoutMs}ms`));
      }, timeoutMs);
      pendingIq.set(id, { resolve, reject, timer });
      try {
        send(n);
      } catch (e) {
        pendingIq.delete(id);
        clearTimeout(timer);
        reject(e as Error);
      }
    });
  };

  // Camada de mensagem (Signal): decifra <message>, cifra sendText, sobe
  // pré-chaves. Só faz sentido depois do <success>; antes disso `send` lança.
  const messages: MessagesLayer = createMessagesLayer({
    events,
    auth,
    crypto: c,
    sendNode: send,
    genId,
    saveCreds: opts.saveCreds,
  });
  let preKeysUploaded = false;

  // Camada de mídia: cifra + sobe o anexo (HTTP) e devolve o `Message` pronto,
  // que segue pelo mesmo `messages.sendMessage` (1:1 ou grupo).
  const media: MediaLayer = createMediaLayer({
    crypto: c,
    query,
    fetch: opts.fetch ?? (globalThis as { fetch?: FetchLike }).fetch,
  });

  // Perfil: foto e recado (bio). `<iq w:profile:picture>` / `<iq status>`.
  const profile: ProfileLayer = createProfileLayer({ query });

  // Presença (online/digitando) e notificações de perfil (foto/recado). Só
  // fazem sentido depois do <success>; antes disso `send` lança.
  const presence: PresenceLayer = createPresenceLayer({
    events,
    sendNode: send,
    genId,
    meId: () => auth.creds.me?.id,
  });
  const notifications: NotificationsLayer = createNotificationsLayer({ events });

  // --- handlers de stanza --------------------------------------------

  const sendAck = (stanza: BinaryNode) => {
    const a = stanza.attrs;
    if (!a.id || !a.from) return;
    const ack: Record<string, string> = { id: a.id, to: a.from, class: stanza.tag };
    if (a.participant) ack.participant = a.participant;
    if (a.recipient) ack.recipient = a.recipient;
    if (a.type && (stanza.tag === "receipt" || stanza.tag === "call")) ack.type = a.type;
    try {
      send(node("ack", ack));
    } catch {
      /* conexão caiu no meio — ignora */
    }
  };

  const handlePairDevice = (stanza: BinaryNode) => {
    const pd = getBinaryNodeChild(stanza, "pair-device");
    const refs = getBinaryNodeChildren(pd, "ref").map(refText).filter(Boolean);
    const noiseB64 = b64(auth.creds.noiseKey.publicKey);
    const identB64 = b64(auth.creds.signedIdentityKey.publicKey);
    const advB64 = auth.creds.advSecretKey;

    let first = true;
    const rotate = () => {
      const ref = refs.shift();
      if (!ref) {
        end(new Error("QR expirou (todos os refs foram usados sem pareamento)"));
        return;
      }
      const qr = [ref, noiseB64, identB64, advB64].join(",");
      events.emit("connection.update", { qr });
      const wait = opts.qrTimeoutMs ?? (first ? 60000 : 20000);
      first = false;
      qrTimer = setTimeout(rotate, wait);
    };
    rotate();
  };

  const handlePairSuccess = (stanza: BinaryNode) => {
    if (qrTimer) clearTimeout(qrTimer);
    qrTimer = undefined;

    let result;
    try {
      result = configureSuccessfulPairing(stanza, auth.creds, c);
    } catch (e) {
      end(e as Error);
      return;
    }
    Object.assign(auth.creds, result.creds);

    try {
      send(result.reply);
    } catch (e) {
      end(e as Error);
      return;
    }

    expectRestart = true; // o servidor manda <stream:error code="515"> a seguir
    Promise.resolve(opts.saveCreds?.()).catch(() => {});
    events.emit("creds.update", result.creds as Record<string, unknown>);
    events.emit("connection.update", { isNewLogin: true });
  };

  const handleLoginSuccess = (stanza: BinaryNode) => {
    retries = 0;
    expectRestart = false;
    state = "open";

    void stanza; // <success> traz lid/props que só interessam com a libsignal (#5)
    Promise.resolve(opts.saveCreds?.()).catch(() => {});

    // <iq xmlns="passive"><active/></iq> — marca a sessão como ativa
    try {
      send(
        node("iq", { to: S_WHATSAPP_NET, xmlns: "passive", type: "set", id: genId() }, [
          node("active", {}),
        ]),
      );
    } catch {
      /* segue mesmo assim */
    }

    keepAlive = setInterval(() => {
      try {
        send(
          node("iq", { to: S_WHATSAPP_NET, type: "get", xmlns: "w:p", id: genId() }, [
            node("ping", {}),
          ]),
        );
      } catch {
        /* conexão caiu — o onClose cuida da reconexão */
      }
    }, keepAliveMs);

    // Sobe pré-chaves uma vez por processo (o servidor repõe via
    // <notification type="encrypt">). Fase 1: sem query proativa de <count>.
    if (!preKeysUploaded) {
      preKeysUploaded = true;
      void messages.uploadPreKeys().catch((e) => {
        preKeysUploaded = false;
        // eslint-disable-next-line no-console
        console.error("client: upload de pré-chaves falhou:", (e as Error).message);
      });
    }

    events.emit("connection.update", { connection: "open" });
  };

  const handleStreamError = (stanza: BinaryNode) => {
    const child = Array.isArray(stanza.content) ? stanza.content[0] : undefined;
    const code = stanza.attrs.code ?? child?.tag ?? "";
    if (code === "515" || expectRestart) {
      reconnect(0); // restart pós-pareamento: imediato, não conta como falha
      return;
    }
    if (LOGOUT_CODES.has(code)) {
      end(new Error(`stream:error ${code} — sessão inválida, refazer o pareamento`));
      return;
    }
    reconnect(); // erro transitório
  };

  const handleFailure = (stanza: BinaryNode) => {
    const reason = stanza.attrs.reason ?? stanza.attrs.code ?? "";
    if (LOGOUT_CODES.has(reason)) {
      end(new Error(`failure ${reason} — desconectado, refazer o pareamento`));
      return;
    }
    reconnect();
  };

  const handleNode = (n: BinaryNode) => {
    events.emit("node.recv", n); // passthrough cru (mensagens vêm cifradas)

    switch (n.tag) {
      case "iq": {
        if (getBinaryNodeChild(n, "pair-device")) return handlePairDevice(n);
        if (getBinaryNodeChild(n, "pair-success")) return handlePairSuccess(n);
        // resposta a um `query()` nosso (ex.: media_conn)
        if (n.attrs.id && pendingIq.has(n.attrs.id) &&
            (n.attrs.type === "result" || n.attrs.type === "error")) {
          const p = pendingIq.get(n.attrs.id)!;
          pendingIq.delete(n.attrs.id);
          clearTimeout(p.timer);
          if (n.attrs.type === "error") {
            const err = getBinaryNodeChild(n, "error");
            p.reject(new Error(`iq ${n.attrs.id}: erro ${err?.attrs.code ?? ""} ${err?.attrs.text ?? ""}`.trim()));
          } else {
            p.resolve(n);
          }
          return;
        }
        // ping do servidor → responde result
        if (n.attrs.type === "get" && getBinaryNodeChild(n, "ping") && n.attrs.id) {
          try {
            send(node("iq", { to: S_WHATSAPP_NET, type: "result", id: n.attrs.id }));
          } catch {
            /* ignore */
          }
        }
        return;
      }
      case "success":
        return handleLoginSuccess(n);
      case "failure":
        return handleFailure(n);
      case "stream:error":
        return handleStreamError(n);
      case "xmlstreamend":
        return reconnect();
      case "message":
        void messages.handleMessageStanza(n).catch((e) => {
          // eslint-disable-next-line no-console
          console.error("client: handleMessageStanza:", (e as Error).message);
        });
        return sendAck(n);
      case "notification":
        if (n.attrs.type === "encrypt") {
          void messages.onEncryptNotification().catch(() => {});
        } else {
          try {
            notifications.handleNotification(n);
          } catch {
            /* notificação malformada — só ackeia */
          }
        }
        return sendAck(n);
      // Presença não leva <ack>.
      case "presence":
        return presence.handlePresence(n);
      case "chatstate":
        return presence.handleChatState(n);
      default:
        if (ACKABLE.has(n.tag)) sendAck(n);
    }
  };

  // --- ciclo de conexão --------------------------------------------

  const reconnect = (delayMs?: number) => {
    if (stopped || connecting) return;
    teardown();
    state = "connecting";

    const isRestart = delayMs === 0 || expectRestart;
    if (!isRestart) {
      retries += 1;
      if (retries > maxRetries) {
        end(new Error(`desisti após ${maxRetries} reconexões seguidas sem sucesso`));
        return;
      }
    }
    const wait =
      delayMs ?? (isRestart ? 250 : Math.min(1000 * 2 ** (retries - 1), 10000));

    events.emit("connection.update", { connection: "connecting" });
    setTimeout(start, wait);
  };

  const start = () => {
    if (stopped || connecting) return;
    connecting = true;

    connectOni({
      auth,
      profile: opts.profile,
      version: opts.version,
      connector: opts.connector,
      countryCode: opts.countryCode,
      timeout: opts.connectTimeoutMs,
      onSocket: (s) => {
        socket = s;
        let closedByUs = false;
        unbind.push(() => {
          closedByUs = true;
        });
        unbind.push(s.events.on("node.recv", handleNode));
        unbind.push(
          s.events.on("connection.update", (u) => {
            // O NoiseSocket emite "open" no fim do handshake (não é o <success>
            // do WhatsApp — ignoramos). Só o "close" inesperado interessa.
            if (u.connection === "close" && !stopped && !closedByUs) {
              reconnect();
            }
          }),
        );
      },
    })
      .then(() => {
        connecting = false;
        // handshake Noise OK. Agora esperamos <pair-device> ou <success>.
        // Não emitimos "open" aqui — só depois do <success> do WhatsApp.
        if (!expectRestart) retries = 0;
      })
      .catch((e) => {
        connecting = false;
        if (stopped) return;
        reconnect();
        void e;
      });
  };

  start();

  return {
    events,
    sendNode: send,
    sendText: (jid, text) => messages.sendText(jid, text),
    sendMessage: (jid, msg) => messages.sendMessage(jid, msg),
    sendAudio: async (jid, data, o2) => messages.sendMessage(jid, await media.buildAudioMessage(data, o2)),
    sendImage: async (jid, data, o2) => messages.sendMessage(jid, await media.buildImageMessage(data, o2)),
    sendVideo: async (jid, data, o2) => messages.sendMessage(jid, await media.buildVideoMessage(data, o2)),
    sendDocument: async (jid, data, o2) =>
      messages.sendMessage(jid, await media.buildDocumentMessage(data, o2)),
    sendSticker: async (jid, data, o2) =>
      messages.sendMessage(jid, await media.buildStickerMessage(data, o2)),
    setProfilePicture: (jpeg) => profile.setProfilePicture(jpeg),
    removeProfilePicture: () => profile.removeProfilePicture(),
    setBio: (text) => profile.setBio(text),
    sendReaction: (jid, key, emoji) => messages.sendReaction(jid, key, emoji),
    sendPresenceUpdate: (type, toJid) => presence.sendPresenceUpdate(type, toJid),
    subscribePresence: (jid) => presence.subscribePresence(jid),
    end,
    get state() {
      return state;
    },
  };
}

// --- helpers ----------------------------------------------------------

function refText(n: BinaryNode): string {
  if (typeof n.content === "string") return n.content;
  if (n.content instanceof Uint8Array) return utf8Decode(n.content);
  return "";
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const d = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (d >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[d & 63] : "=";
  }
  return out;
}
