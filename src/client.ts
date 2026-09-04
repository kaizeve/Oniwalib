// openWhatsApp — o driver de conexão. Junta `connectOni` (transporte + Noise) com
// a máquina de estados do WhatsApp Web: QR, pareamento, o restart 515, login já
// registrado, keepalive e acks. É o análogo do `makeWASocket` da Baileys, no
// mínimo necessário para: mostrar o QR, parear de verdade, e voltar autenticado
// (`<success>`).
//
// O QUE ISTO NÃO FAZ: decifrar `<message>` (libsignal — issue #5). Stanzas de
// mensagem chegam, são "ackadas" para o servidor não repetir, e repassadas cruas
// em `events.on("node.recv")`. Ler o texto exige a camada Signal.

import { Emitter, type MessageKey, type WAPresence, type OniwalibEvents } from "./events/emitter";
import { decryptPollVote, resolvePollVote } from "./polls";
import { decodeHistorySync } from "./history";
import { connectOni } from "./connect";
import { configureSuccessfulPairing } from "./pairing";
import { createMessagesLayer, type MessagesLayer, type SendOptions } from "./messages";
import { makeLidStore, type LidStore } from "./signal/lid";
import {
  createMediaLayer,
  type MediaLayer,
  type FetchLike,
  type AudioOptions,
  type ImageOptions,
  type VideoOptions,
  type DocumentOptions,
  type StickerOptions,
  type DownloadedMedia,
  hasDownloadableMedia,
} from "./media";
import { createProfileLayer, type ProfileLayer } from "./profile";
import { createAppStateLayer, type AppStateLayer } from "./appstate/layer";
import type { ChatModification, WAPatchName } from "./appstate";
import { createCallsLayer, type CallsLayer } from "./calls";
import { createBlocklistLayer, type BlocklistLayer } from "./blocklist";
import {
  createBusinessLayer,
  type BusinessLayer,
  type BusinessProfile,
  type Catalog,
  type Collection,
  type OrderDetails,
} from "./business";
import {
  createPrivacyLayer,
  type PrivacyLayer,
  type PrivacyCategory,
  type PrivacyValue,
  type PrivacySettings,
} from "./privacy";
import { createUSyncLayer, type USyncLayer } from "./usync";
import {
  createGroupsLayer,
  handleGroupNotification,
  type GroupsLayer,
  type GroupMetadata,
  type GroupParticipant,
  type GroupParticipantAction,
  type GroupSetting,
  type ParticipantUpdateResult,
} from "./groups";
import {
  createChannelsLayer,
  resolveRequiredChannels,
  inviteCodeOf,
  type ChannelsLayer,
  type NewsletterMetadata,
} from "./channels";
import { createPresenceLayer, type PresenceLayer } from "./presence";
import { createNotificationsLayer, type NotificationsLayer } from "./notifications";
import type { E2EMessage } from "./proto/e2e-message";
import { fetchLinkPreview } from "./link-preview";
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
import { jidDecode, isJidNewsletter } from "./frame/jid";

const S_WHATSAPP_NET = "@s.whatsapp.net";
const ACKABLE = new Set(["message", "receipt", "notification", "call", "ack"]);

/** vCard 3.0 mínimo pro `contactMessage`. `waid` (dígitos do telefone) faz o
 *  WhatsApp reconhecer o cartão como uma conta e abrir a conversa ao tocar. */
function makeVCard(name: string, phone?: string): string {
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${name}`, `N:${name};;;;`];
  if (phone) {
    const digits = phone.replace(/[^\d]/g, "");
    lines.push(`TEL;type=CELL;type=VOICE;waid=${digits}:${phone.startsWith("+") ? phone : `+${digits}`}`);
  }
  lines.push("END:VCARD");
  return lines.join("\n");
}

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
  /** Anuncia `<presence type="available">` assim que loga — o telefone para
   *  de te notificar das mensagens que o bot já viu. Default `true`, como na
   *  Baileys (`markOnlineOnConnect`). Passe `false` para um bot "invisível". */
  markOnlineOnConnect?: boolean;
  /** Manda recibo de leitura (tick azul) automático em toda mensagem recebida
   *  que vira `messages.upsert`. Default `false` — a Baileys também não manda
   *  sozinha; use `conn.readMessages(...)` quando quiser marcar como lido. */
  sendReadReceipts?: boolean;
  /** Decodifica o CORPO das mensagens no history sync (mais caro; o
   *  `WebMessageInfo` é grande). Default `true`. `false` = só a lista de chats
   *  e a contagem. */
  historyMessages?: boolean;
  /** Baixa + decifra o anexo de TODA mensagem de mídia recebida e emite
   *  `messages.media` com os bytes prontos — sem precisar chamar
   *  `conn.downloadMedia(m.message)` na mão. Default `false` (gasta rede).
   *  Precisa de `fetch`. */
  autoDownloadMedia?: boolean;
  /** ms entre pings de keepalive. Default 25000. */
  keepAliveMs?: number;
  /** Máx. de reconexões automáticas seguidas antes de desistir. Default 5. */
  maxRetries?: number;
  /** ms até trocar o QR pelo próximo ref. Default 60000 no 1º, 20000 depois. */
  qrTimeoutMs?: number;
  /** Timeout do connect do transporte, em ms. Default 20000. */
  connectTimeoutMs?: number;
  /** URL alternativa do JSON de canais obrigatórios. Só serve pra teste — a
   *  lista remota só é aceita com assinatura válida da chave do dono (senão cai
   *  na embutida `DEFAULT_REQUIRED_CHANNELS`), então repontar isto não burla a
   *  atribuição. */
  channelsSource?: string;
}

export interface OniConnection {
  readonly events: Emitter;
  /** Envia um node cru na conexão ativa. Lança se não estiver aberta. */
  sendNode(n: BinaryNode): void;
  /** Cifra e envia um texto 1:1 ou grupo. `opts` = resposta citada (`quoted`),
   *  menções (`mentions`), mensagem temporária (`ephemeralExpiration`). */
  sendText(jid: string, text: string, opts?: SendOptions): Promise<{ id: string }>;
  /** Como `sendText`, mas com um `Message` inteiro — botões, lista, viewOnce… */
  sendMessage(jid: string, msg: E2EMessage, opts?: SendOptions): Promise<{ id: string }>;
  /** Álbum: um container + N mídias ligadas. `items` são `imageMessage`/
   *  `videoMessage` (use `buildImageMessage`/`buildVideoMessage`). */
  sendAlbum(jid: string, items: E2EMessage[], opts?: SendOptions): Promise<{ albumId: string; ids: string[] }>;
  /** Cartão de contato. Passe `vcard` pronto, ou `phone`/`name` e a lib monta um
   *  vCard 3.0 simples. Vários → `contactsArrayMessage`. */
  sendContact(
    jid: string,
    contacts:
      | { name: string; phone?: string; vcard?: string }
      | Array<{ name: string; phone?: string; vcard?: string }>,
    opts?: SendOptions,
  ): Promise<{ id: string }>;
  /** Pino de localização. */
  sendLocation(
    jid: string,
    loc: { latitude: number; longitude: number; name?: string; address?: string; url?: string },
    opts?: SendOptions,
  ): Promise<{ id: string }>;
  /** Edita uma mensagem nossa já enviada (`key` = a original). Vira um
   *  `protocolMessage` MESSAGE_EDIT; o outro lado recebe `messages.update`. */
  editMessage(jid: string, key: MessageKey, newText: string): Promise<{ id: string }>;
  /** Apaga uma mensagem para todos (revoke). */
  deleteMessage(jid: string, key: MessageKey): Promise<{ id: string }>;
  /** Cria uma enquete. Devolve o id e a `pollEncKey` — guarde a chave para
   *  decifrar os votos depois (`poll.update` → `readPollVote`). */
  sendPoll(
    jid: string,
    name: string,
    options: string[],
    selectableCount?: number,
  ): Promise<{ id: string; pollEncKey: Uint8Array }>;
  /** Decifra um voto (`poll.update`). Passe a `pollEncKey` que você guardou ao
   *  criar a enquete e a lista de opções. Devolve os NOMES votados (ou os
   *  hashes crus se `optionNames` não vier). */
  readPollVote(
    evt: OniwalibEvents["poll.update"],
    pollEncKey: Uint8Array,
    optionNames?: string[],
  ): string[] | Uint8Array[];
  /** Abre sessão Signal com `jids` que ainda não têm uma (busca o bundle de
   *  pré-chaves e roda o X3DH). `sendText`/`sendMessage` 1:1 já chamam isto
   *  sozinhos; use direto para pré-aquecer. Devolve os jids que ficaram sem
   *  sessão. */
  assertSessions(jids: string[]): Promise<string[]>;
  /** Cifra + sobe um anexo ao servidor de mídia e envia (1:1 ou grupo). Precisa
   *  de `fetch` (default `globalThis.fetch`) e de sessão Signal com `jid`. */
  sendAudio(jid: string, data: Uint8Array, opts?: AudioOptions): Promise<{ id: string }>;
  sendImage(jid: string, data: Uint8Array, opts?: ImageOptions): Promise<{ id: string }>;
  sendVideo(jid: string, data: Uint8Array, opts?: VideoOptions): Promise<{ id: string }>;
  sendDocument(jid: string, data: Uint8Array, opts?: DocumentOptions): Promise<{ id: string }>;
  sendSticker(jid: string, data: Uint8Array, opts?: StickerOptions): Promise<{ id: string }>;
  /** Baixa + decifra + verifica (MAC de 10 bytes e, se presente, `fileSha256`) o
   *  anexo de uma mensagem recebida — passe a `message` de um evento
   *  `messages.upsert`. Precisa de `fetch` (default `globalThis.fetch`). */
  downloadMedia(msg: E2EMessage): Promise<DownloadedMedia>;
  /** Posta um status (`status@broadcast`) para `recipients` (JIDs que verão).
   *  `text` vira um status de texto; `media` (com `type`) sobe e posta a mídia. */
  postStatus(
    recipients: string[],
    content: { text: string } | { media: Uint8Array; type: "image" | "video"; caption?: string },
  ): Promise<{ id: string; sentTo: number }>;
  /** Troca a sua foto de perfil (JPEG, idealmente quadrado ~640px). */
  setProfilePicture(jpeg: Uint8Array): Promise<void>;
  /** Remove a sua foto de perfil. */
  removeProfilePicture(): Promise<void>;
  /** Define o seu recado / bio. */
  setBio(text: string): Promise<void>;
  /** URL da foto de perfil de `jid` (contato, grupo ou você). `hd` = imagem
   *  cheia. `undefined` se não tem foto ou a privacidade não deixa. */
  getProfilePictureUrl(jid: string, hd?: boolean): Promise<string | undefined>;
  /** Recado / bio de `jid`. `undefined` se não há ou é privado. */
  fetchStatus(jid: string): Promise<{ status?: string; setAt?: Date } | undefined>;
  /** Quais dos `numbers` têm conta no WhatsApp (um resultado por entrada). */
  onWhatsApp(numbers: string[]): Promise<import("./usync").OnWhatsAppResult[]>;
  /** Lê as configurações de privacidade da conta (readreceipts, last, online,
   *  profile, status, groupadd, calladd). */
  fetchPrivacySettings(): Promise<PrivacySettings>;
  /** Altera uma categoria de privacidade da conta. */
  updatePrivacySetting(category: PrivacyCategory, value: PrivacyValue): Promise<PrivacySettings>;
  /** USYNC: device ids logados de cada número. `{ "55...@s.whatsapp.net": [0, 23] }`.
   *  Base para mandar a um número novo e para o fan-out de SKDM em grupo. */
  getDeviceList(jids: string[]): Promise<Record<string, number[]>>;
  /** Mapa número↔lid observado até agora. `@lid` → `@s.whatsapp.net` (ou o
   *  próprio jid, se já for número); `undefined` se for um lid ainda não
   *  pareado. Alimentado pelas stanzas de entrada e pela metadata de grupo. */
  lidToPn(jid: string | undefined): Promise<string | undefined>;
  /** Marca um jid (número ou lid) como contato que já falou com o bot em 1:1.
   *  Persistido, cifrado, sobrevive a restart. Use como fonte da audiência de
   *  status (`postStatus`) em vez de manter uma lista só em memória. */
  noteContact(jid: string | undefined): Promise<void>;
  /** Todo mundo já marcado com `noteContact`, colapsando par número/lid (número
   *  quando conhecido). */
  knownContacts(): Promise<string[]>;
  /** Metadata de um canal (`@newsletter`) por código de convite ou jid. */
  newsletterMetadata(type: "invite" | "jid", key: string): Promise<NewsletterMetadata>;
  /** Segue um canal pelo jid `...@newsletter`. */
  followNewsletter(jid: string): Promise<void>;
  /** Deixa de seguir um canal. */
  unfollowNewsletter(jid: string): Promise<void>;
  /** Silencia / dessilencia um canal. */
  muteNewsletter(jid: string): Promise<void>;
  unmuteNewsletter(jid: string): Promise<void>;
  /** Cria um canal (`@newsletter`); devolve os metadados com o jid. */
  createNewsletter(name: string, description?: string): Promise<NewsletterMetadata>;
  /** Apaga um canal (só o dono). */
  deleteNewsletter(jid: string): Promise<void>;
  /** Reage (ou tira, `code` vazio) a uma mensagem de canal pelo `server_id`
   *  (o `newsletterServerId` do `messages.upsert`). */
  newsletterReactMessage(jid: string, serverId: number, code: string): void;
  /** Busca mensagens antigas de um canal (`{serverId, message}` decodificados). */
  newsletterFetchMessages(
    jid: string,
    count: number,
    opts?: { since?: number; after?: number },
  ): Promise<Array<{ serverId?: number; message?: import("./proto/e2e-message").E2EMessage }>>;
  /** Assina updates ao vivo de um canal; devolve a duração (s) se informada. */
  subscribeNewsletterUpdates(jid: string): Promise<{ duration?: number } | undefined>;
  /** Força a verificação de canal obrigatório agora, ignorando o cache de "já
   *  garantido" (a checagem normal roda sozinha no connect e só uma vez).
   *  Resolve → checa → segue o que faltar. Nunca lança. */
  ensureChannels(): Promise<void>;
  /** Metadata de um grupo/comunidade (`<iq xmlns="w:g2">`): assunto, dono,
   *  participantes + admin, `announce`/`restrict`, e `isCommunity`/`linkedParent`
   *  para distinguir comunidade de grupo comum. */
  groupMetadata(jid: string): Promise<GroupMetadata>;
  /** Só a lista de participantes de um grupo. */
  groupParticipants(jid: string): Promise<GroupParticipant[]>;
  /** Cria um grupo com um assunto e uma lista inicial de números. */
  groupCreate(subject: string, participants: string[]): Promise<GroupMetadata>;
  /** Sai de um grupo. */
  groupLeave(jid: string): Promise<void>;
  /** Troca o nome (assunto) do grupo. */
  groupUpdateSubject(jid: string, subject: string): Promise<void>;
  /** Troca a descrição do grupo. Vazio/`undefined` apaga. */
  groupUpdateDescription(jid: string, description?: string): Promise<void>;
  /** add/remove/promote/demote de participantes em lote — um resultado por jid
   *  (`status` `"200"` OK, `"403"` sem permissão, `"408"` fora do zap, …). */
  groupParticipantsUpdate(
    jid: string,
    participants: string[],
    action: GroupParticipantAction,
  ): Promise<ParticipantUpdateResult[]>;
  /** `announcement`/`not_announcement` (só admin fala) e `locked`/`unlocked`
   *  (só admin edita infos). */
  groupSettingUpdate(jid: string, setting: GroupSetting): Promise<void>;
  /** Mensagens temporárias: `0` desliga, senão segundos (86400/604800/7776000). */
  groupToggleEphemeral(jid: string, expirationSeconds: number): Promise<void>;
  /** Exigir aprovação de admin para entrar: `"on"`/`"off"`. */
  groupJoinApprovalMode(jid: string, mode: "on" | "off"): Promise<void>;
  /** Quem adiciona membro: `"all_member_add"` ou `"admin_add"`. */
  groupMemberAddMode(jid: string, mode: "all_member_add" | "admin_add"): Promise<void>;
  /** Código de convite atual (`chat.whatsapp.com/<code>`). */
  groupInviteCode(jid: string): Promise<string | undefined>;
  /** Revoga o convite e devolve o novo código. */
  groupRevokeInvite(jid: string): Promise<string | undefined>;
  /** Entra num grupo por código de convite; devolve o jid do grupo. */
  groupAcceptInvite(code: string): Promise<string | undefined>;
  /** Metadata de um grupo pelo código de convite, sem entrar. */
  groupGetInviteInfo(code: string): Promise<GroupMetadata>;
  /** Lista de pedidos de entrada pendentes (com `joinApprovalMode` ligado). */
  groupRequestParticipantsList(jid: string): Promise<Array<Record<string, string>>>;
  /** Aprova/rejeita pedidos de entrada em lote. */
  groupRequestParticipantsUpdate(
    jid: string,
    participants: string[],
    action: "approve" | "reject",
  ): Promise<ParticipantUpdateResult[]>;
  /** Subgrupos de uma comunidade (`<iq w:g2><sub_groups>`). */
  communitySubGroups(communityJid: string): Promise<Array<{ jid: string; subject?: string }>>;
  /** Liga grupos existentes a uma comunidade como subgrupos. */
  communityLinkSubgroups(communityJid: string, groupJids: string[]): Promise<ParticipantUpdateResult[]>;
  /** Desliga um subgrupo da comunidade. */
  communityUnlinkSubgroup(communityJid: string, groupJid: string): Promise<void>;
  /** Pré-abre sessão Signal com TODOS os devices de TODOS os participantes de
   *  um grupo (metadata → USYNC → cold-send). Roda uma vez (ex.: ao entrar no
   *  grupo) para o próximo `sendMessage(grupo, …)` alcançar todo mundo, não só
   *  quem já falou. Devolve quantos devices ficaram sem sessão. */
  assertGroupSessions(groupJid: string): Promise<{ opened: number; missing: number }>;
  /** Reage a uma mensagem (`emoji` vazio remove a reação). Precisa de sessão. */
  sendReaction(jid: string, key: MessageKey, emoji: string): Promise<{ id: string }>;
  /** Anuncia a nossa presença. `available`/`unavailable` é global; `composing`/
   *  `recording`/`paused` é por chat e exige `toJid`. */
  sendPresenceUpdate(type: WAPresence, toJid?: string): void;
  /** Atalhos por chat de `sendPresenceUpdate` — "digitando…", "gravando áudio…",
   *  e parar. */
  sendTyping(jid: string): void;
  sendRecording(jid: string): void;
  sendPaused(jid: string): void;
  /** Pede ao servidor a presença de `jid` (senão os `<presence>` dele não vêm). */
  subscribePresence(jid: string): void;
  /** Marca mensagens como lidas (tick azul). Agrupa as `keys` por chat e manda
   *  um `<receipt type="read">` por chat. */
  readMessages(keys: MessageKey[]): void;
  /** `<receipt>` cru para `ids` num `jid`. `type` omitido = recibo de entrega;
   *  `"read"` = tick azul; `"read-self"` = marca lido sem revelar ao remetente
   *  (quando a tua privacidade de "confirmações de leitura" está desligada).
   *  `participant` só em grupo (quem mandou a mensagem). */
  sendReceipt(jid: string, ids: string[], type?: "read" | "read-self", participant?: string): void;
  /** App-state sync (LT-hash): puxa do servidor o estado das coleções
   *  (`critical_block` = push name, `regular*` = mute/pin/archive/contatos) e
   *  emite `creds.update` / `chats.update` / `contacts.upsert`. Roda sozinho no
   *  connect e a cada `<notification type="server_sync">`; chame para forçar.
   *  Precisa que o device primário já tenha compartilhado as chaves de sync. */
  resyncAppState(names?: WAPatchName[]): Promise<void>;
  /** Troca o nome de perfil (push name) — uma mutação de app-state na coleção
   *  `critical_block`. Precisa das chaves de sync. */
  updateProfileName(name: string): Promise<void>;
  /** Muta/fixa/arquiva um chat, ou marca (não) lido — via app-state sync. */
  chatModify(mod: ChatModification, jid: string): Promise<void>;
  /** (Des)associa uma etiqueta a um chat (app-state; emite `labels.association`
   *  no eco). `labelId` é o id da etiqueta (1..20 nos padrões). */
  addChatLabel(jid: string, labelId: string): Promise<void>;
  removeChatLabel(jid: string, labelId: string): Promise<void>;
  /** `true` se já recebemos as chaves-mestras de app-state do device primário. */
  appStateReady(): boolean;
  /** Lista de jids bloqueados (também emite `blocklist.update`). */
  fetchBlocklist(): Promise<string[]>;
  /** Bloqueia/desbloqueia um número. */
  updateBlockStatus(jid: string, action: "block" | "unblock"): Promise<void>;
  /** Recusa uma chamada recebida (do evento `call`: `rejectCall(c.id, c.chatId)`). */
  rejectCall(callId: string, callFrom: string): void;
  /** Perfil comercial de um número Business (`<iq w:biz>`). */
  getBusinessProfile(jid: string): Promise<BusinessProfile | undefined>;
  /** Catálogo de produtos de um número Business. */
  getCatalog(opts?: { jid?: string; limit?: number; cursor?: string }): Promise<Catalog>;
  /** Coleções (agrupamentos de produtos) de um número Business. */
  getCollections(jid?: string, limit?: number): Promise<Collection[]>;
  /** Detalhes de um pedido (`orderId` + token do `orderMessage`). */
  getOrderDetails(orderId: string, tokenBase64: string): Promise<OrderDetails>;
  /** Fecha e não reconecta. */
  end(err?: Error): void;
  /** A conexão já é iniciada sozinha. Chame (e `await`) isto quando precisar de
   *  uma cadeia `await` explícita do handshake — **obrigatório no RTS**, onde
   *  `rts run` não agenda o `start()` disparado internamente. Idempotente:
   *  devolve a promessa do handshake em voo. */
  start(): Promise<void>;
  /** Segura o processo (loop `await`) até fechar, e faz o keepalive-ping quando
   *  `setInterval` não roda (RTS). Em bun/node é opcional. Padrão de bot no RTS:
   *  `await conn.start(); await conn.waitUntilClose();`. */
  waitUntilClose(): Promise<void>;
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
  /** A promessa do handshake em voo (ou o último). `conn.start()` a devolve, o
   *  que dá ao runtime do RTS uma cadeia `await` para bombear (o `start()`
   *  disparado sozinho fica órfão e o `rts run` não o agenda). */
  let connectPromise: Promise<void> = Promise.resolve();

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

  // Keepalive-ping. Precisa rodar JÁ no fim do handshake Noise — não só depois do
  // <success> —, senão o servidor derruba o stream com <stream:error>[ping] a
  // cada ~30s enquanto o QR está na tela, e o QR reinicia junto (janela curta
  // demais para escanear de um `pm2 logs`). Idempotente.
  function startKeepAlive(): void {
    if (keepAlive) return;
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
  }

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

  // USYNC — device list de um número (cold-send / fan-out de SKDM em grupo).
  const usync: USyncLayer = createUSyncLayer({ query, crypto: c });

  // Mapa número↔lid, persistido no cofre de chaves. Alimentado passivamente
  // pelas stanzas de entrada e pela metadata de grupo (ver `resolveGroupDeviceJids`).
  const lidStore: LidStore = makeLidStore(auth.keys);

  // GRUPOS — metadata via `<iq xmlns="w:g2">` (participantes, admin, comunidade).
  const groups: GroupsLayer = createGroupsLayer({ query, genId });

  // CANAIS — resolver/seguir `@newsletter` via `w:mex`. Usado no <success> para
  // colar a conta ao canal oficial (registry/channels.json).
  const channels: ChannelsLayer = createChannelsLayer({ query, sendNode: send, genId });
  let channelsEnforced = false;
  const CHANNELS_DONE_ID = "__channels_done";
  const loadChannelsDone = async (): Promise<Set<string>> => {
    const { [CHANNELS_DONE_ID]: raw } = await auth.keys.get("lid-mapping", [CHANNELS_DONE_ID]);
    return new Set(Array.isArray(raw) ? (raw as unknown[]).filter((x): x is string => typeof x === "string") : []);
  };
  const enforceRequiredChannels = async (force = false): Promise<void> => {
    if (channelsEnforced && !force) return;
    channelsEnforced = true;
    try {
      const { channels: want } = await resolveRequiredChannels({
        source: opts.channelsSource,
        crypto: c,
      });
      const done = force ? new Set<string>() : await loadChannelsDone();
      let changed = false;
      for (const link of want) {
        const code = inviteCodeOf(link);
        if (!code || done.has(code)) continue; // já garantido antes → não reconsulta
        // eslint-disable-next-line no-await-in-loop
        const r = await channels.ensureFollowing(link);
        const label = r.name ? `"${r.name}"` : (r.jid ?? link);
        if (r.action === "followed") {
          done.add(code);
          changed = true;
          // eslint-disable-next-line no-console
          console.log(`channels: conta agora segue o canal oficial ${label}`);
        } else if (r.action === "already") {
          done.add(code);
          changed = true;
        } else {
          // eslint-disable-next-line no-console
          console.error(`channels: não consegui garantir ${link}: ${r.error ?? "erro"}`);
        }
      }
      if (changed) await auth.keys.set({ "lid-mapping": { [CHANNELS_DONE_ID]: [...done] } });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("channels: verificação de canal falhou:", (e as Error).message);
    }
  };

  // Cache curto da lista de device-jids por grupo (metadata + USYNC são caros).
  // Invalidado quando chega um `<notification w:gp2>` de add/remove.
  const groupDeviceCache = new Map<string, { devices: string[]; at: number }>();
  const GROUP_DEVICE_TTL = 5 * 60 * 1000;

  const resolveGroupDeviceJids = async (groupJid: string): Promise<string[]> => {
    const hit = groupDeviceCache.get(groupJid);
    if (hit && Date.now() - hit.at < GROUP_DEVICE_TTL) return hit.devices;

    const meta = await groups.groupMetadata(groupJid);
    const meUser = jidDecode(auth.creds.me?.id)?.user;
    const meLidUser = jidDecode(auth.creds.me?.lid)?.user;
    const isSelf = (user?: string): boolean =>
      !!user && (user === meUser || (!!meLidUser && user === meLidUser));

    // A metadata pareia lid↔número no `<participant>` — registra o par no mapa.
    for (const p of meta.participants) {
      if (p.phoneNumber) void lidStore.remember(p.phoneNumber, p.jid);
      if (p.lid) void lidStore.remember(p.jid, p.lid);
    }

    // USYNC é protocolo de NÚMERO. Num grupo lid-addressed o `participant.jid`
    // vem como `@lid` e o número real fica em `phone_number`; consultar USYNC
    // com o `@lid` volta vazio → `SKDM p/ 0 device(s)`. Consulta pelo número e
    // re-endereça os device ids de volta pro jid que o grupo usa (lid ou número).
    const entries: Array<{ addrUser: string; addrServer: string; queryJid: string }> = [];
    for (const p of meta.participants) {
      const addr = jidDecode(p.jid);
      if (!addr?.user || isSelf(addr.user)) continue;
      const phone = addr.server === "lid" ? p.phoneNumber : p.jid;
      const pd = jidDecode(phone);
      if (!pd?.user || isSelf(pd.user)) continue; // lid sem número conhecido → fica de fora
      entries.push({
        addrUser: addr.user,
        addrServer: addr.server,
        queryJid: `${pd.user}@${pd.server === "c.us" ? "s.whatsapp.net" : pd.server}`,
      });
    }

    const targets: string[] = [];
    if (entries.length) {
      const deviceMap = await usync.getDeviceList([...new Set(entries.map((e) => e.queryJid))]);
      for (const e of entries) {
        const ids = deviceMap[e.queryJid] ?? [];
        for (const id of ids.length ? ids : [0]) {
          const jid = id === 0 ? `${e.addrUser}@${e.addrServer}` : `${e.addrUser}:${id}@${e.addrServer}`;
          if (!targets.includes(jid)) targets.push(jid);
        }
      }
    }

    groupDeviceCache.set(groupJid, { devices: targets, at: Date.now() });
    return targets;
  };

  // { user@server: [deviceIds] }  →  ["user@server", "user:12@server", …]
  function expandDeviceJids(devices: Record<string, number[]>): string[] {
    const out: string[] = [];
    for (const [user, ids] of Object.entries(devices)) {
      const d = jidDecode(user);
      if (!d?.user) continue;
      for (const id of ids.length ? ids : [0]) {
        out.push(id === 0 ? user : `${d.user}:${id}@${d.server}`);
      }
    }
    return out;
  }

  // Devices de uma lista solta de números (destinatários de status). Mesma
  // resolução USYNC do grupo, sem a metadata. Exclui as nossas próprias contas.
  const resolveStatusDeviceJids = async (userJids: string[]): Promise<string[]> => {
    const meUser = jidDecode(auth.creds.me?.id)?.user;
    const users = Array.from(
      new Set(
        userJids
          .map((j) => {
            const d = jidDecode(j);
            return d?.user ? `${d.user}@${d.server || "s.whatsapp.net"}` : undefined;
          })
          .filter((j): j is string => !!j && jidDecode(j)?.user !== meUser),
      ),
    );
    if (!users.length) return [];
    return expandDeviceJids(await usync.getDeviceList(users));
  };

  // Camada de mensagem (Signal): decifra <message>, cifra sendText, sobe
  // pré-chaves. Só faz sentido depois do <success>; antes disso `send` lança.
  const messages: MessagesLayer = createMessagesLayer({
    events,
    auth,
    crypto: c,
    sendNode: send,
    genId,
    query,
    groupDevices: resolveGroupDeviceJids,
    statusDevices: resolveStatusDeviceJids,
    lid: lidStore,
    saveCreds: opts.saveCreds,
  });
  let preKeysUploaded = false;

  // Camada de mídia: cifra + sobe o anexo (HTTP) e devolve o `Message` pronto,
  // que segue pelo mesmo `messages.sendMessage` (1:1 ou grupo).
  const httpFetch = opts.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
  const media: MediaLayer = createMediaLayer({ crypto: c, query, fetch: httpFetch });

  // App-state sync (LT-hash): push name, mute/pin/archive, roster de contatos.
  // O blob externo de snapshot/patch usa o mesmo esquema de download da mídia.
  const appstate: AppStateLayer = createAppStateLayer({
    query,
    keys: auth.keys,
    crypto: c,
    events,
    creds: auth.creds,
    saveCreds: opts.saveCreds,
    downloadBlob: (ref) => media.downloadEncryptedBlob(ref, "WhatsApp App State Keys"),
  });
  let appStateSynced = false;

  // Perfil: foto e recado (bio). `<iq w:profile:picture>` / `<iq status>`.
  const profile: ProfileLayer = createProfileLayer({ query });

  // Privacidade da conta (confirmações de leitura, visto por último, foto…).
  const privacy: PrivacyLayer = createPrivacyLayer({ query });

  // Presença (online/digitando) e notificações de perfil (foto/recado). Só
  // fazem sentido depois do <success>; antes disso `send` lança.
  const presence: PresenceLayer = createPresenceLayer({
    events,
    sendNode: send,
    genId,
    meId: () => auth.creds.me?.id,
  });
  const notifications: NotificationsLayer = createNotificationsLayer({ events });

  // Chamadas (só notifica + recusa; sem WebRTC) e blocklist da conta.
  const calls: CallsLayer = createCallsLayer({ events, sendNode: send });
  const blocklist: BlocklistLayer = createBlocklistLayer({ query, events });
  const business: BusinessLayer = createBusinessLayer({ query, meId: () => auth.creds.me?.id });

  // Recibos de leitura (tick azul) e afins. `<receipt to=jid type=read
  // id=id0 [participant=...]>` + `<list><item id=.../></list>` para os demais
  // ids (formato da Baileys `sendReceipt`).
  const sendReceipt = (
    jid: string,
    ids: string[],
    type?: "read" | "read-self",
    participant?: string,
  ): void => {
    if (ids.length === 0) return;
    const attrs: Record<string, string> = { to: jid, id: ids[0]! };
    if (type) attrs.type = type;
    if (participant) attrs.participant = participant;
    const extra = ids.slice(1);
    const content =
      extra.length > 0
        ? [node("list", {}, extra.map((id) => node("item", { id })))]
        : undefined;
    try {
      send(node("receipt", attrs, content));
    } catch {
      /* conexão caiu — ignora */
    }
  };

  const readMessages = (keys: MessageKey[]): void => {
    // agrupa por chat; em grupo, o `participant` é de quem mandou (todas as
    // keys de um mesmo chat costumam ter o mesmo participant num lote).
    const byChat = new Map<string, { ids: string[]; participant?: string }>();
    for (const k of keys) {
      if (!k.remoteJid || !k.id) continue;
      let g = byChat.get(k.remoteJid);
      if (!g) byChat.set(k.remoteJid, (g = { ids: [], participant: k.participant }));
      g.ids.push(k.id);
    }
    for (const [jid, g] of byChat) sendReceipt(jid, g.ids, "read", g.participant);
  };

  // Recibo de leitura automático (opt-in). A Baileys não faz isto sozinha; aqui
  // é um atalho para quem quer que TODA mensagem recebida já saia com tick azul.
  if (opts.sendReadReceipts) {
    events.on("messages.upsert", ({ type, messages: msgs }) => {
      if (type !== "notify") return;
      for (const m of msgs) {
        if (m.key.fromMe || !m.message) continue;
        sendReceipt(m.key.remoteJid, [m.key.id], "read", m.key.participant);
      }
    });
  }

  // Baixa o anexo de toda mídia recebida e emite `messages.media` já pronto.
  // Opt-in (gasta rede). A `messages.upsert` já saiu antes — este evento é um
  // extra pra quem não quer chamar `downloadMedia` na mão. NÃO baixa mídia de
  // `status@broadcast` nem de canal por padrão (é o status/feed dos outros —
  // baixar tudo isso é banda à toa); pra esses, chame `downloadMedia` na mão.
  if (opts.autoDownloadMedia) {
    events.on("messages.upsert", ({ type, messages: msgs }) => {
      if (type !== "notify") return;
      for (const m of msgs) {
        if (m.key.fromMe || !m.message || !hasDownloadableMedia(m.message as E2EMessage)) continue;
        if (m.key.remoteJid === "status@broadcast" || isJidNewsletter(m.key.remoteJid)) continue;
        void media
          .downloadMedia(m.message as E2EMessage)
          .then((dl) => events.emit("messages.media", { key: m.key, message: m.message, media: dl }))
          .catch((error: Error) =>
            events.emit("messages.media", { key: m.key, message: m.message, error }),
          );
      }
    });
  }

  // O device primário entrega as chaves-mestras do app-state sync embrulhadas
  // num `protocolMessage.appStateSyncKeyShare`. Assim que chegam, guarda e faz
  // o primeiro resync (push name, contatos, mute/pin…).
  events.on("messages.upsert", ({ messages: msgs }) => {
    for (const m of msgs) {
      const pmsg = (m.message as { protocolMessage?: {
        appStateSyncKeyShare?: Array<{ keyId: Uint8Array; keyData: Uint8Array; timestamp?: number }>;
        historySyncNotification?: {
          mediaKey?: Uint8Array; directPath?: string; fileEncSha256?: Uint8Array;
          syncType?: number; progress?: number;
        };
      } } | undefined)?.protocolMessage;
      const share = pmsg?.appStateSyncKeyShare;
      if (share && share.length) {
        void appstate
          .ingestKeys(share)
          .then(() => appstate.resync())
          .catch((e) => console.error("appstate: ingest/resync falhou:", (e as Error).message));
      }
      const hsn = pmsg?.historySyncNotification;
      if (hsn?.mediaKey && hsn.directPath) {
        void ingestHistorySync(hsn).catch((e) =>
          console.error("history: sync falhou:", (e as Error).message),
        );
      }
    }
  });

  const ingestHistorySync = async (hsn: {
    mediaKey?: Uint8Array; directPath?: string; fileEncSha256?: Uint8Array;
    syncType?: number; progress?: number;
  }): Promise<void> => {
    if (!c.inflate) {
      console.error("history: adapter de cripto sem `inflate` (node:zlib) — history sync indisponível");
      return;
    }
    const compressed = await media.downloadEncryptedBlob(
      { mediaKey: hsn.mediaKey!, directPath: hsn.directPath!, fileEncSha256: hsn.fileEncSha256 },
      "WhatsApp History Keys",
    );
    const raw = c.inflate(compressed);
    const hist = decodeHistorySync(raw, { withMessages: opts.historyMessages ?? true });
    for (const map of hist.lidMappings) void lidStore.remember(map.pn, map.lid);
    const contacts = hist.pushnames
      .filter((p) => p.id)
      .map((p) => ({ id: p.id, notify: p.pushname }));
    if (contacts.length) events.emit("contacts.upsert", contacts);
    // achata as mensagens de todas as conversas do chunk, ordenadas por tempo
    const messages = hist.chats
      .flatMap((ch) => ch.messages ?? [])
      .sort((a, b) => (a.messageTimestamp ?? 0) - (b.messageTimestamp ?? 0));
    events.emit("messaging-history.set", {
      chats: hist.chats,
      contacts,
      messages,
      syncType: hist.syncTypeName,
      progress: hist.progress,
      isLatest: (hist.progress ?? 0) >= 100,
    });
    console.log(
      `history: ${hist.syncTypeName ?? "?"} — ${hist.chats.length} chat(s), ` +
        `${messages.length} msg(s), ${hist.pushnames.length} nome(s)` +
        (hist.progress !== undefined ? `, ${hist.progress}%` : ""),
    );
  };

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

    // O <success> traz o nosso próprio `@lid`. Guarda em `creds.me.lid` (e no
    // mapa) — precisamos dele pra nos filtrar do fan-out de SKDM em grupos
    // lid-addressed, onde o nosso `participant` vem como `@lid`, não número.
    const myLid = stanza.attrs.lid;
    if (myLid && auth.creds.me && auth.creds.me.lid !== myLid) {
      auth.creds.me.lid = myLid;
      void lidStore.remember(auth.creds.me.id, myLid);
      events.emit("creds.update", { me: auth.creds.me });
    }
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

    // Presença inicial. `available` faz o telefone parar de notificar o que o
    // bot já viu; desligue com `markOnlineOnConnect: false` para ficar invisível.
    if (opts.markOnlineOnConnect ?? true) {
      try {
        presence.sendPresenceUpdate("available");
      } catch {
        /* segue mesmo assim */
      }
    }

    startKeepAlive(); // já pode estar rodando desde o fim do handshake

    // Repõe pré-chaves uma vez por processo — mas SÓ se o servidor de fato
    // estiver baixo (`onEncryptNotification` pergunta o `<count>` antes e tem
    // rate-limit). Sem isso, cada restart subia 30 e o `auth.owl` inchava.
    if (!preKeysUploaded) {
      preKeysUploaded = true;
      void messages.onEncryptNotification().catch((e) => {
        preKeysUploaded = false;
        // eslint-disable-next-line no-console
        console.error("client: reposição de pré-chaves falhou:", (e as Error).message);
      });
    }

    // Cola a conta ao canal oficial (uma vez por processo). Fire-and-forget —
    // nunca bloqueia nem derruba a conexão.
    void enforceRequiredChannels();

    // App-state: se já temos as chaves de sync, puxa o estado (push name,
    // contatos, mute/pin). Se ainda não, o `messages.upsert` dispara quando
    // elas chegarem. Uma vez por processo.
    if (!appStateSynced && appstate.hasKeys()) {
      appStateSynced = true;
      void appstate.resync().catch(() => {});
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
        } else if (n.attrs.type === "server_sync") {
          // o servidor avisa que uma coleção de app-state avançou → resync
          const cols = getBinaryNodeChildren(n, "collection")
            .map((c2) => c2.attrs.name)
            .filter((x): x is WAPatchName => !!x);
          void appstate.resync(cols.length ? cols : undefined).catch(() => {});
        } else if (n.attrs.type === "w:gp2") {
          try {
            handleGroupNotification(n, {
              events,
              onMembershipChange: (gjid) => groupDeviceCache.delete(gjid),
            });
          } catch {
            /* notificação de grupo malformada — só ackeia */
          }
        } else if (n.attrs.type === "blocklist") {
          try {
            blocklist.handleBlocklistNotification(n);
          } catch {
            /* malformada — só ackeia */
          }
        } else {
          try {
            notifications.handleNotification(n);
          } catch {
            /* notificação malformada — só ackeia */
          }
        }
        return sendAck(n);
      case "call":
        try {
          calls.handleCallNode(n);
        } catch {
          /* <call> malformado — só ackeia */
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

  const start = (): Promise<void> => {
    if (stopped || connecting) return connectPromise;
    connecting = true;

    connectPromise = connectOni({
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
        // Começa o keepalive JÁ: sem ele o servidor mata o stream ([ping]) a
        // cada ~30s durante a espera do QR e o QR reinicia junto.
        startKeepAlive();
      })
      .catch((e) => {
        connecting = false;
        if (stopped) return;
        reconnect();
        void e;
      });
    return connectPromise;
  };

  /** Mantém o processo vivo (loop `await sleep`) até `state === "close"`.
   *  Necessário no RTS, onde `rts run` sai quando a fila de tarefas drena e não
   *  agenda `setInterval`; em bun/node é opcional (o socket já segura o loop).
   *  Faz também o keepalive-ping quando o `setInterval` não roda. */
  const waitUntilClose = async (): Promise<void> => {
    const step = Math.max(1000, Math.floor((opts.keepAliveMs ?? 25000) / 2));
    let sinceLastPing = 0;
    while (!stopped && state !== "close") {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, step));
      sinceLastPing += step;
      if (state === "open" && !keepAlive && sinceLastPing >= (opts.keepAliveMs ?? 25000)) {
        sinceLastPing = 0;
        try {
          send(
            node("iq", { to: S_WHATSAPP_NET, type: "get", xmlns: "w:p", id: genId() }, [
              node("ping", {}),
            ]),
          );
        } catch {
          /* caiu — o onClose cuida */
        }
      }
    }
  };

  // `assertGroupSessions` = `resolveGroupDeviceJids` (metadata + USYNC, cacheado,
  // definido lá em cima) + cold-send dos devices sem sessão. Rode uma vez (ex.:
  // ao entrar num grupo) e o próximo `sendGroupMessage` alcança todo mundo.
  const assertGroupSessions = async (
    groupJid: string,
  ): Promise<{ opened: number; missing: number }> => {
    const targets = await resolveGroupDeviceJids(groupJid);
    if (targets.length === 0) return { opened: 0, missing: 0 };
    const stillMissing = await messages.assertSessions(targets);
    return { opened: targets.length - stillMissing.length, missing: stillMissing.length };
  };

  // Auto-conecta, mas adiado por um microtask: assim um chamador que faça
  // `const c = openWhatsApp(...); await c.start();` roda o handshake DENTRO da
  // própria cadeia `await` (o RTS precisa disso — não bombeia um `start()`
  // órfão). Em bun/node o microtask dispara sozinho e nada muda.
  let autoStarted = false;
  const autoStart = () => {
    if (autoStarted || stopped || connecting) return;
    autoStarted = true;
    void start();
  };
  if (typeof queueMicrotask === "function") queueMicrotask(autoStart);
  else Promise.resolve().then(autoStart);

  return {
    events,
    sendNode: send,
    sendText: async (jid, text, opts) => {
      if (opts?.linkPreview) {
        const preview = await fetchLinkPreview(text, httpFetch);
        if (preview) {
          const { linkPreview: _lp, ...rest } = opts;
          return messages.sendMessage(
            jid,
            { extendedTextMessage: { text, ...preview } },
            Object.keys(rest).length ? { opts: rest } : undefined,
          );
        }
      }
      return messages.sendText(jid, text, opts);
    },
    sendMessage: (jid, msg, opts) => messages.sendMessage(jid, msg, opts ? { opts } : undefined),
    sendAlbum: (jid, items, opts) => messages.sendAlbum(jid, items, opts),
    sendContact: (jid, contacts, opts) => {
      const one = (ct: { name: string; phone?: string; vcard?: string }) => ({
        displayName: ct.name,
        vcard: ct.vcard ?? makeVCard(ct.name, ct.phone),
      });
      const list = Array.isArray(contacts) ? contacts : [contacts];
      const msg: E2EMessage =
        list.length === 1
          ? { contactMessage: one(list[0]!) }
          : { contactsArrayMessage: { displayName: list.map((c) => c.name).join(", "), contacts: list.map(one) } };
      return messages.sendMessage(jid, msg, opts ? { opts } : undefined);
    },
    sendLocation: (jid, loc, opts) =>
      messages.sendMessage(
        jid,
        {
          locationMessage: {
            degreesLatitude: loc.latitude,
            degreesLongitude: loc.longitude,
            name: loc.name,
            address: loc.address,
            url: loc.url,
          },
        },
        opts ? { opts } : undefined,
      ),
    editMessage: (jid, key, newText) => messages.editMessage(jid, key, newText),
    deleteMessage: (jid, key) => messages.deleteMessage(jid, key),
    sendPoll: (jid, name, options, selectableCount) =>
      messages.sendPoll(jid, name, options, selectableCount),
    readPollVote: (evt, pollEncKey, optionNames) => {
      const k = evt.pollCreationKey;
      const meId = auth.creds.me?.id ?? "";
      const pollCreatorJid = k.fromMe ? meId : k.participant || k.remoteJid;
      if (!evt.vote.encPayload || !evt.vote.encIv) return [];
      const { selectedOptions } = decryptPollVote(
        c,
        { encPayload: evt.vote.encPayload, encIv: evt.vote.encIv },
        { pollMsgId: k.id, pollCreatorJid, voterJid: evt.voterJid, pollEncKey },
      );
      return optionNames ? resolvePollVote(c, optionNames, selectedOptions) : selectedOptions;
    },
    assertSessions: (jids) => messages.assertSessions(jids),
    sendAudio: async (jid, data, o2) => messages.sendMessage(jid, await media.buildAudioMessage(data, o2)),
    sendImage: async (jid, data, o2) => {
      const m = await media.buildImageMessage(data, o2);
      return messages.sendMessage(jid, o2?.viewOnce ? { viewOnceMessageV2: { message: m } } : m);
    },
    sendVideo: async (jid, data, o2) => {
      const m = await media.buildVideoMessage(data, o2);
      return messages.sendMessage(jid, o2?.viewOnce ? { viewOnceMessageV2: { message: m } } : m);
    },
    sendDocument: async (jid, data, o2) =>
      messages.sendMessage(jid, await media.buildDocumentMessage(data, o2)),
    sendSticker: async (jid, data, o2) =>
      messages.sendMessage(jid, await media.buildStickerMessage(data, o2)),
    downloadMedia: (msg) => media.downloadMedia(msg),
    resyncAppState: (names) => appstate.resync(names),
    updateProfileName: (name) => appstate.updateProfileName(name),
    chatModify: (mod, jid) => appstate.chatModify(mod, jid),
    addChatLabel: (jid, labelId) => appstate.chatModify({ addChatLabel: { labelId } }, jid),
    removeChatLabel: (jid, labelId) => appstate.chatModify({ removeChatLabel: { labelId } }, jid),
    appStateReady: () => appstate.hasKeys(),
    fetchBlocklist: () => blocklist.fetchBlocklist(),
    updateBlockStatus: (jid, action) => blocklist.updateBlockStatus(jid, action),
    rejectCall: (callId, callFrom) => calls.rejectCall(callId, callFrom),
    getBusinessProfile: (jid) => business.getBusinessProfile(jid),
    getCatalog: (opts) => business.getCatalog(opts),
    getCollections: (jid, limit) => business.getCollections(jid, limit),
    getOrderDetails: (orderId, token) => business.getOrderDetails(orderId, token),
    postStatus: async (recipients, content) => {
      let msg: E2EMessage;
      if ("text" in content) {
        msg = { conversation: content.text };
      } else if (content.type === "image") {
        msg = await media.buildImageMessage(content.media, { caption: content.caption });
      } else {
        msg = await media.buildVideoMessage(content.media, { caption: content.caption });
      }
      return messages.sendStatus(msg, recipients);
    },
    setProfilePicture: (jpeg) => profile.setProfilePicture(jpeg),
    removeProfilePicture: () => profile.removeProfilePicture(),
    setBio: (text) => profile.setBio(text),
    getProfilePictureUrl: (jid, hd) => profile.getProfilePictureUrl(jid, hd),
    fetchStatus: (jid) => profile.fetchStatus(jid),
    onWhatsApp: (numbers) => usync.onWhatsApp(numbers),
    fetchPrivacySettings: () => privacy.fetchPrivacySettings(),
    updatePrivacySetting: (category, value) => privacy.updatePrivacySetting(category, value),
    getDeviceList: (jids) => usync.getDeviceList(jids),
    lidToPn: (jid) => lidStore.toPn(jid),
    noteContact: (jid) => lidStore.noteContact(jid),
    knownContacts: () => lidStore.contacts(),
    newsletterMetadata: (type, key) => channels.newsletterMetadata(type, key),
    followNewsletter: (jid) => channels.followNewsletter(jid),
    unfollowNewsletter: (jid) => channels.unfollowNewsletter(jid),
    muteNewsletter: (jid) => channels.muteNewsletter(jid),
    unmuteNewsletter: (jid) => channels.unmuteNewsletter(jid),
    createNewsletter: (name, description) => channels.createNewsletter(name, description),
    deleteNewsletter: (jid) => channels.deleteNewsletter(jid),
    newsletterReactMessage: (jid, serverId, code) =>
      channels.newsletterReactMessage(jid, serverId, code),
    newsletterFetchMessages: (jid, count, opts) => channels.newsletterFetchMessages(jid, count, opts),
    subscribeNewsletterUpdates: (jid) => channels.subscribeNewsletterUpdates(jid),
    ensureChannels: () => enforceRequiredChannels(true),
    groupMetadata: (jid) => groups.groupMetadata(jid),
    groupParticipants: (jid) => groups.groupParticipants(jid),
    groupCreate: (subject, participants) => groups.groupCreate(subject, participants),
    groupLeave: (jid) => groups.groupLeave(jid),
    groupUpdateSubject: (jid, subject) => groups.groupUpdateSubject(jid, subject),
    groupUpdateDescription: (jid, description) => groups.groupUpdateDescription(jid, description),
    groupParticipantsUpdate: (jid, participants, action) =>
      groups.groupParticipantsUpdate(jid, participants, action),
    groupSettingUpdate: (jid, setting) => groups.groupSettingUpdate(jid, setting),
    groupToggleEphemeral: (jid, expirationSeconds) => groups.groupToggleEphemeral(jid, expirationSeconds),
    groupJoinApprovalMode: (jid, mode) => groups.groupJoinApprovalMode(jid, mode),
    groupMemberAddMode: (jid, mode) => groups.groupMemberAddMode(jid, mode),
    groupInviteCode: (jid) => groups.groupInviteCode(jid),
    groupRevokeInvite: (jid) => groups.groupRevokeInvite(jid),
    groupAcceptInvite: (code) => groups.groupAcceptInvite(code),
    groupGetInviteInfo: (code) => groups.groupGetInviteInfo(code),
    groupRequestParticipantsList: (jid) => groups.groupRequestParticipantsList(jid),
    groupRequestParticipantsUpdate: (jid, participants, action) =>
      groups.groupRequestParticipantsUpdate(jid, participants, action),
    communitySubGroups: (jid) => groups.communitySubGroups(jid),
    communityLinkSubgroups: (jid, groupJids) => groups.communityLinkSubgroups(jid, groupJids),
    communityUnlinkSubgroup: (jid, groupJid) => groups.communityUnlinkSubgroup(jid, groupJid),
    assertGroupSessions,
    sendReaction: (jid, key, emoji) => messages.sendReaction(jid, key, emoji),
    sendPresenceUpdate: (type, toJid) => presence.sendPresenceUpdate(type, toJid),
    sendTyping: (jid) => presence.sendPresenceUpdate("composing", jid),
    sendRecording: (jid) => presence.sendPresenceUpdate("recording", jid),
    sendPaused: (jid) => presence.sendPresenceUpdate("paused", jid),
    subscribePresence: (jid) => presence.subscribePresence(jid),
    readMessages,
    sendReceipt,
    end,
    start,
    waitUntilClose,
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
