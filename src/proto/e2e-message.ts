// Codec de fio do `Message` E2E do WhatsApp — o subconjunto que o OniBot usa:
// texto, os tipos INTERATIVOS que os forks mantêm vivos (`buttonsMessage`,
// `listMessage`), o wrapper `viewOnceMessage`, e as respostas que voltam quando
// alguém toca um botão / escolhe uma linha (`buttonsResponseMessage`,
// `listResponseMessage`). É o que sai de `unpadRandomMax16(decrypt(...))` e o
// que entra em `encrypt(...)` na resposta.
//
//   message Message {
//     string conversation                                      = 1;
//     SenderKeyDistributionMessage senderKeyDistributionMessage = 2;
//     ExtendedTextMessage extendedTextMessage                   = 6;   // { string text = 1; }
//     ListMessage listMessage                                   = 36;
//     FutureProofMessage viewOnceMessage                        = 37;  // { Message message = 1; }
//     ListResponseMessage listResponseMessage                   = 39;
//     ButtonsMessage buttonsMessage                             = 42;
//     ButtonsResponseMessage buttonsResponseMessage             = 43;
//     InteractiveMessage interactiveMessage                     = 45;  // native flow — o caminho vivo p/ botões
//     ReactionMessage reactionMessage                           = 46;
//     InteractiveResponseMessage interactiveResponseMessage     = 48;  // volta quando toca num native-flow
//     TemplateButtonReplyMessage templateButtonReplyMessage     = 29;  // volta quando toca num quick_reply
//     DeviceSentMessage deviceSentMessage                       = 31;  // { string destinationJid = 1; Message message = 2; }
//     MessageContextInfo messageContextInfo                     = 35;  // { DeviceListMetadata = 1; int32 version = 2 }
//   }
//
// Campos conferidos contra `@whiskeysockets/baileys` WAProto (master, 2026-08).
// Os builders "amigáveis" (com defaults) ficam em `proto/message.ts`; aqui é só
// o que precisa virar bytes de verdade.

import { Reader, Writer } from "./wire";
import { utf8Decode } from "../frame/buffer";

export interface E2EButtonsMessage {
  contentText?: string;
  footerText?: string;
  /** HeaderType: 1 EMPTY, 2 TEXT, … (default 1). */
  headerType?: number;
  buttons?: Array<{
    buttonId?: string;
    buttonText?: { displayText?: string };
    /** Button.Type: 1 RESPONSE, 2 NATIVE_FLOW. */
    type?: number;
  }>;
}

export interface E2EListRow {
  title?: string;
  description?: string;
  rowId?: string;
}

export interface E2EListMessage {
  title?: string;
  description?: string;
  buttonText?: string;
  footerText?: string;
  /** ListType: 1 SINGLE_SELECT, 2 PRODUCT_LIST (default 1). */
  listType?: number;
  sections?: Array<{ title?: string; rows?: E2EListRow[] }>;
}

/** MessageKey do WAProto — todos os campos opcionais no fio. */
export interface E2EMessageKey {
  remoteJid?: string;
  fromMe?: boolean;
  id?: string;
  participant?: string;
}

export interface E2EReactionMessage {
  key?: E2EMessageKey;
  /** Emoji da reação. `""` = reação removida. */
  text?: string;
  groupingKey?: string;
  senderTimestampMs?: number;
}

export interface E2EProtocolMessage {
  key?: E2EMessageKey;
  /** ProtocolMessage.Type — 0 REVOKE (apagar p/ todos), 3 EPHEMERAL_SETTING, … */
  type?: number;
}

/**
 * InteractiveMessage (campo 45) + NativeFlowMessage. É o caminho que os forks
 * usam depois que o WhatsApp parou de desenhar `buttonsMessage`/`listMessage`
 * legados vindos de cliente não-oficial. Os botões viram entradas de
 * `nativeFlowMessage.buttons` com `name` (`quick_reply`, `cta_url`,
 * `single_select`, …) e `buttonParamsJson` (JSON serializado). O toque volta em
 * `interactiveResponseMessage` ou `templateButtonReplyMessage`.
 */
export interface E2EInteractiveMessage {
  header?: { title?: string; subtitle?: string; hasMediaAttachment?: boolean };
  body?: { text?: string };
  footer?: { text?: string };
  nativeFlowMessage?: {
    buttons?: Array<{ name?: string; buttonParamsJson?: string }>;
    messageParamsJson?: string;
    messageVersion?: number;
  };
}

/**
 * AudioMessage (campo 8). O mínimo para mandar um áudio já cifrado e subido ao
 * servidor de mídia: os hashes/chave que o destinatário usa para baixar e
 * decifrar (`mediaKey` + HKDF "WhatsApp Audio Keys"), mais `url`/`directPath`.
 * `ptt` marca nota de voz; sem ele o WhatsApp mostra player de música.
 */
export interface E2EAudioMessage {
  url?: string;
  mimetype?: string;
  fileSha256?: Uint8Array;
  fileLength?: number;
  /** Duração em segundos. */
  seconds?: number;
  /** `true` = nota de voz (push-to-talk). */
  ptt?: boolean;
  mediaKey?: Uint8Array;
  fileEncSha256?: Uint8Array;
  directPath?: string;
  /** Unix em segundos — quando a `mediaKey` foi criada. */
  mediaKeyTimestamp?: number;
}

/** ImageMessage (campo 3). Mesma cifra/upload do áudio (HKDF "WhatsApp Image
 *  Keys"). `jpegThumbnail` é o preview que aparece antes do download. */
export interface E2EImageMessage {
  url?: string;
  mimetype?: string;
  caption?: string;
  fileSha256?: Uint8Array;
  fileLength?: number;
  height?: number;
  width?: number;
  mediaKey?: Uint8Array;
  fileEncSha256?: Uint8Array;
  directPath?: string;
  mediaKeyTimestamp?: number;
  jpegThumbnail?: Uint8Array;
}

/** VideoMessage (campo 9). HKDF "WhatsApp Video Keys". `gifPlayback` faz o
 *  WhatsApp tratar um mp4 curto como GIF. */
export interface E2EVideoMessage {
  url?: string;
  mimetype?: string;
  fileSha256?: Uint8Array;
  fileLength?: number;
  seconds?: number;
  mediaKey?: Uint8Array;
  caption?: string;
  gifPlayback?: boolean;
  height?: number;
  width?: number;
  fileEncSha256?: Uint8Array;
  directPath?: string;
  mediaKeyTimestamp?: number;
  jpegThumbnail?: Uint8Array;
}

/** DocumentMessage (campo 7). HKDF "WhatsApp Document Keys". `fileName` é o que
 *  aparece no chat; `title` é o rótulo interno. */
export interface E2EDocumentMessage {
  url?: string;
  mimetype?: string;
  title?: string;
  fileSha256?: Uint8Array;
  fileLength?: number;
  pageCount?: number;
  mediaKey?: Uint8Array;
  fileName?: string;
  fileEncSha256?: Uint8Array;
  directPath?: string;
  mediaKeyTimestamp?: number;
  caption?: string;
  jpegThumbnail?: Uint8Array;
}

/** StickerMessage (campo 26). HKDF "WhatsApp Image Keys", tipo de upload
 *  `image`. `isAnimated` para webp animado. */
export interface E2EStickerMessage {
  url?: string;
  fileSha256?: Uint8Array;
  fileEncSha256?: Uint8Array;
  mediaKey?: Uint8Array;
  mimetype?: string;
  height?: number;
  width?: number;
  directPath?: string;
  fileLength?: number;
  mediaKeyTimestamp?: number;
  isAnimated?: boolean;
}

export interface E2EMessage {
  conversation?: string;
  extendedTextMessage?: { text?: string };
  audioMessage?: E2EAudioMessage;
  imageMessage?: E2EImageMessage;
  videoMessage?: E2EVideoMessage;
  documentMessage?: E2EDocumentMessage;
  stickerMessage?: E2EStickerMessage;
  deviceSentMessage?: { destinationJid?: string; message?: E2EMessage };
  senderKeyDistributionMessage?: {
    groupId?: string;
    axolotlSenderKeyDistributionMessage?: Uint8Array;
  };
  buttonsMessage?: E2EButtonsMessage;
  listMessage?: E2EListMessage;
  viewOnceMessage?: { message?: E2EMessage };
  buttonsResponseMessage?: { selectedButtonId?: string; selectedDisplayText?: string };
  listResponseMessage?: {
    title?: string;
    description?: string;
    singleSelectReply?: { selectedRowId?: string };
  };
  /** Resposta a um `quick_reply` de template/native-flow. */
  templateButtonReplyMessage?: {
    selectedId?: string;
    selectedDisplayText?: string;
    selectedIndex?: number;
  };
  messageContextInfo?: { deviceListMetadataVersion?: number; messageSecret?: Uint8Array };
  interactiveMessage?: E2EInteractiveMessage;
  interactiveResponseMessage?: {
    body?: { text?: string };
    nativeFlowResponseMessage?: { name?: string; paramsJson?: string; version?: number };
  };
  reactionMessage?: E2EReactionMessage;
  protocolMessage?: E2EProtocolMessage;
}

//   message MessageKey {
//     string remoteJid   = 1;
//     bool   fromMe       = 2;
//     string id           = 3;
//     string participant  = 4;
//   }
function messageKeyWriter(k: E2EMessageKey): Writer {
  const w = new Writer();
  w.string(1, k.remoteJid);
  w.bool(2, !!k.fromMe);
  w.string(3, k.id);
  w.string(4, k.participant);
  return w;
}

function decodeMessageKey(b: Uint8Array | undefined): E2EMessageKey | undefined {
  if (!b) return undefined;
  const f = new Reader(b).fields();
  return {
    remoteJid: asStr(f.get(1)?.[0]),
    fromMe: f.get(2)?.[0] === 1,
    id: asStr(f.get(3)?.[0]),
    participant: asStr(f.get(4)?.[0]),
  };
}

//   message InteractiveMessage {
//     Header header = 1; Body body = 2; Footer footer = 3;
//     NativeFlowMessage nativeFlowMessage = 6;   // { NativeFlowButton buttons = 1; string messageParamsJson = 2; int32 messageVersion = 3 }
//   }
function interactiveWriter(im: E2EInteractiveMessage): Writer {
  const w = new Writer();
  if (im.header) {
    const h = new Writer().string(1, im.header.title).string(2, im.header.subtitle);
    if (im.header.hasMediaAttachment) h.bool(5, true);
    w.message(1, h);
  }
  if (im.body) w.message(2, new Writer().string(1, im.body.text));
  if (im.footer) w.message(3, new Writer().string(1, im.footer.text));
  const nf = im.nativeFlowMessage;
  if (nf) {
    const nfw = new Writer();
    for (const b of nf.buttons ?? []) {
      nfw.message(1, new Writer().string(1, b.name).string(2, b.buttonParamsJson));
    }
    nfw.string(2, nf.messageParamsJson);
    if (nf.messageVersion) nfw.uint(3, nf.messageVersion);
    w.message(6, nfw);
  }
  return w;
}

function decodeInteractive(bytes: Uint8Array): E2EInteractiveMessage {
  const f = new Reader(bytes).fields();
  const out: E2EInteractiveMessage = {};
  const h = asBytes(f.get(1)?.[0]);
  if (h) {
    const hf = new Reader(h).fields();
    out.header = {
      title: asStr(hf.get(1)?.[0]),
      subtitle: asStr(hf.get(2)?.[0]),
      hasMediaAttachment: hf.get(5)?.[0] === 1,
    };
  }
  const b = asBytes(f.get(2)?.[0]);
  if (b) out.body = { text: asStr(new Reader(b).fields().get(1)?.[0]) };
  const ft = asBytes(f.get(3)?.[0]);
  if (ft) out.footer = { text: asStr(new Reader(ft).fields().get(1)?.[0]) };
  const nf = asBytes(f.get(6)?.[0]);
  if (nf) {
    const nff = new Reader(nf).fields();
    const ver = nff.get(3)?.[0];
    out.nativeFlowMessage = {
      buttons: (nff.get(1) ?? []).map((btn) => {
        const bf = new Reader(asBytes(btn)!).fields();
        return { name: asStr(bf.get(1)?.[0]), buttonParamsJson: asStr(bf.get(2)?.[0]) };
      }),
      messageParamsJson: asStr(nff.get(2)?.[0]),
      messageVersion: typeof ver === "number" ? ver : undefined,
    };
  }
  return out;
}

export function encodeE2EMessage(m: E2EMessage): Uint8Array {
  const w = new Writer();
  if (m.conversation !== undefined) w.string(1, m.conversation);
  if (m.extendedTextMessage) {
    w.message(6, new Writer().string(1, m.extendedTextMessage.text));
  }
  if (m.audioMessage) {
    const a = m.audioMessage;
    const sub = new Writer();
    sub.string(1, a.url);
    sub.string(2, a.mimetype);
    sub.bytes(3, a.fileSha256);
    if (a.fileLength !== undefined) sub.uint(4, a.fileLength);
    if (a.seconds !== undefined) sub.uint(5, a.seconds);
    if (a.ptt !== undefined) sub.bool(6, a.ptt);
    sub.bytes(7, a.mediaKey);
    sub.bytes(8, a.fileEncSha256);
    sub.string(9, a.directPath);
    if (a.mediaKeyTimestamp !== undefined) sub.uint(10, a.mediaKeyTimestamp);
    w.message(8, sub);
  }
  if (m.imageMessage) {
    const a = m.imageMessage;
    const sub = new Writer();
    sub.string(1, a.url);
    sub.string(2, a.mimetype);
    sub.string(3, a.caption);
    sub.bytes(4, a.fileSha256);
    if (a.fileLength !== undefined) sub.uint(5, a.fileLength);
    if (a.height !== undefined) sub.uint(6, a.height);
    if (a.width !== undefined) sub.uint(7, a.width);
    sub.bytes(8, a.mediaKey);
    sub.bytes(9, a.fileEncSha256);
    sub.string(11, a.directPath);
    if (a.mediaKeyTimestamp !== undefined) sub.uint(12, a.mediaKeyTimestamp);
    sub.bytes(16, a.jpegThumbnail);
    w.message(3, sub);
  }
  if (m.documentMessage) {
    const a = m.documentMessage;
    const sub = new Writer();
    sub.string(1, a.url);
    sub.string(2, a.mimetype);
    sub.string(3, a.title);
    sub.bytes(4, a.fileSha256);
    if (a.fileLength !== undefined) sub.uint(5, a.fileLength);
    if (a.pageCount !== undefined) sub.uint(6, a.pageCount);
    sub.bytes(7, a.mediaKey);
    sub.string(8, a.fileName);
    sub.bytes(9, a.fileEncSha256);
    sub.string(10, a.directPath);
    if (a.mediaKeyTimestamp !== undefined) sub.uint(11, a.mediaKeyTimestamp);
    sub.bytes(16, a.jpegThumbnail);
    sub.string(20, a.caption);
    w.message(7, sub);
  }
  if (m.videoMessage) {
    const a = m.videoMessage;
    const sub = new Writer();
    sub.string(1, a.url);
    sub.string(2, a.mimetype);
    sub.bytes(3, a.fileSha256);
    if (a.fileLength !== undefined) sub.uint(4, a.fileLength);
    if (a.seconds !== undefined) sub.uint(5, a.seconds);
    sub.bytes(6, a.mediaKey);
    sub.string(7, a.caption);
    if (a.gifPlayback !== undefined) sub.bool(8, a.gifPlayback);
    if (a.height !== undefined) sub.uint(9, a.height);
    if (a.width !== undefined) sub.uint(10, a.width);
    sub.bytes(11, a.fileEncSha256);
    sub.string(13, a.directPath);
    if (a.mediaKeyTimestamp !== undefined) sub.uint(14, a.mediaKeyTimestamp);
    sub.bytes(16, a.jpegThumbnail);
    w.message(9, sub);
  }
  if (m.stickerMessage) {
    const a = m.stickerMessage;
    const sub = new Writer();
    sub.string(1, a.url);
    sub.bytes(2, a.fileSha256);
    sub.bytes(3, a.fileEncSha256);
    sub.bytes(4, a.mediaKey);
    sub.string(5, a.mimetype);
    if (a.height !== undefined) sub.uint(6, a.height);
    if (a.width !== undefined) sub.uint(7, a.width);
    sub.string(8, a.directPath);
    if (a.fileLength !== undefined) sub.uint(9, a.fileLength);
    if (a.mediaKeyTimestamp !== undefined) sub.uint(10, a.mediaKeyTimestamp);
    if (a.isAnimated !== undefined) sub.bool(13, a.isAnimated);
    w.message(26, sub);
  }
  if (m.deviceSentMessage) {
    const sub = new Writer().string(1, m.deviceSentMessage.destinationJid);
    if (m.deviceSentMessage.message) sub.bytes(2, encodeE2EMessage(m.deviceSentMessage.message));
    w.message(31, sub);
  }
  if (m.senderKeyDistributionMessage) {
    const s = m.senderKeyDistributionMessage;
    w.message(
      2,
      new Writer().string(1, s.groupId).bytes(2, s.axolotlSenderKeyDistributionMessage),
    );
  }
  if (m.listMessage) {
    const l = m.listMessage;
    const sub = new Writer();
    sub.string(1, l.title);
    sub.string(2, l.description);
    sub.string(3, l.buttonText);
    sub.uint(4, l.listType ?? 0);
    for (const sec of l.sections ?? []) {
      const sw = new Writer().string(1, sec.title);
      for (const row of sec.rows ?? []) {
        sw.message(2, new Writer().string(1, row.title).string(2, row.description).string(3, row.rowId));
      }
      sub.message(5, sw);
    }
    sub.string(7, l.footerText);
    w.message(36, sub);
  }
  if (m.viewOnceMessage?.message) {
    w.message(37, new Writer().bytes(1, encodeE2EMessage(m.viewOnceMessage.message)));
  }
  if (m.listResponseMessage) {
    const r = m.listResponseMessage;
    const sub = new Writer().string(1, r.title);
    if (r.singleSelectReply) {
      sub.message(3, new Writer().string(1, r.singleSelectReply.selectedRowId));
    }
    sub.string(5, r.description);
    w.message(39, sub);
  }
  if (m.buttonsMessage) {
    const b = m.buttonsMessage;
    const sub = new Writer();
    sub.string(6, b.contentText);
    sub.string(7, b.footerText);
    for (const btn of b.buttons ?? []) {
      const bw = new Writer().string(1, btn.buttonId);
      if (btn.buttonText) bw.message(2, new Writer().string(1, btn.buttonText.displayText));
      bw.uint(3, btn.type ?? 0);
      sub.message(9, bw);
    }
    sub.uint(10, b.headerType ?? 0);
    w.message(42, sub);
  }
  if (m.buttonsResponseMessage) {
    const r = m.buttonsResponseMessage;
    const sub = new Writer().string(1, r.selectedButtonId).string(2, r.selectedDisplayText);
    w.message(43, sub);
  }
  if (m.templateButtonReplyMessage) {
    const r = m.templateButtonReplyMessage;
    const sub = new Writer().string(1, r.selectedId).string(2, r.selectedDisplayText);
    if (r.selectedIndex) sub.uint(4, r.selectedIndex);
    w.message(29, sub);
  }
  if (m.messageContextInfo) {
    const sub = new Writer();
    if (m.messageContextInfo.deviceListMetadataVersion)
      sub.uint(2, m.messageContextInfo.deviceListMetadataVersion);
    sub.bytes(3, m.messageContextInfo.messageSecret);
    w.message(35, sub);
  }
  if (m.interactiveMessage) {
    w.message(45, interactiveWriter(m.interactiveMessage));
  }
  if (m.interactiveResponseMessage) {
    const r = m.interactiveResponseMessage;
    const sub = new Writer();
    if (r.body) sub.message(1, new Writer().string(1, r.body.text));
    if (r.nativeFlowResponseMessage) {
      const nfr = new Writer()
        .string(1, r.nativeFlowResponseMessage.name)
        .string(2, r.nativeFlowResponseMessage.paramsJson);
      if (r.nativeFlowResponseMessage.version) nfr.uint(3, r.nativeFlowResponseMessage.version);
      sub.message(2, nfr);
    }
    w.message(48, sub);
  }
  if (m.reactionMessage) {
    const r = m.reactionMessage;
    const sub = new Writer();
    if (r.key) sub.message(1, messageKeyWriter(r.key));
    sub.string(2, r.text);
    sub.string(3, r.groupingKey);
    if (r.senderTimestampMs) sub.uint(4, r.senderTimestampMs);
    w.message(46, sub);
  }
  if (m.protocolMessage) {
    const p = m.protocolMessage;
    const sub = new Writer();
    if (p.key) sub.message(1, messageKeyWriter(p.key));
    sub.uint(2, p.type ?? 0); // REVOKE(0) não é escrito — decode trata ausência como 0
    w.message(12, sub);
  }
  return w.finish();
}

const asBytes = (v: number | Uint8Array | undefined): Uint8Array | undefined =>
  v instanceof Uint8Array ? v : undefined;
const asStr = (v: number | Uint8Array | undefined): string | undefined => {
  const b = asBytes(v);
  return b ? utf8Decode(b) : undefined;
};

export function decodeE2EMessage(bytes: Uint8Array): E2EMessage {
  const f = new Reader(bytes).fields();
  const out: E2EMessage = {};

  const conv = f.get(1)?.[0];
  if (conv instanceof Uint8Array) out.conversation = utf8Decode(conv);

  const ext = asBytes(f.get(6)?.[0]);
  if (ext) {
    const sf = new Reader(ext).fields();
    out.extendedTextMessage = { text: asStr(sf.get(1)?.[0]) };
  }

  const aud = asBytes(f.get(8)?.[0]);
  if (aud) {
    const sf = new Reader(aud).fields();
    const num = (n: number): number | undefined => {
      const v = sf.get(n)?.[0];
      return typeof v === "number" ? v : undefined;
    };
    out.audioMessage = {
      url: asStr(sf.get(1)?.[0]),
      mimetype: asStr(sf.get(2)?.[0]),
      fileSha256: asBytes(sf.get(3)?.[0]),
      fileLength: num(4),
      seconds: num(5),
      ptt: sf.get(6)?.[0] === 1,
      mediaKey: asBytes(sf.get(7)?.[0]),
      fileEncSha256: asBytes(sf.get(8)?.[0]),
      directPath: asStr(sf.get(9)?.[0]),
      mediaKeyTimestamp: num(10),
    };
  }

  const img = asBytes(f.get(3)?.[0]);
  if (img) {
    const sf = new Reader(img).fields();
    const n = (k: number) => (typeof sf.get(k)?.[0] === "number" ? (sf.get(k)![0] as number) : undefined);
    out.imageMessage = {
      url: asStr(sf.get(1)?.[0]),
      mimetype: asStr(sf.get(2)?.[0]),
      caption: asStr(sf.get(3)?.[0]),
      fileSha256: asBytes(sf.get(4)?.[0]),
      fileLength: n(5),
      height: n(6),
      width: n(7),
      mediaKey: asBytes(sf.get(8)?.[0]),
      fileEncSha256: asBytes(sf.get(9)?.[0]),
      directPath: asStr(sf.get(11)?.[0]),
      mediaKeyTimestamp: n(12),
      jpegThumbnail: asBytes(sf.get(16)?.[0]),
    };
  }

  const doc = asBytes(f.get(7)?.[0]);
  if (doc) {
    const sf = new Reader(doc).fields();
    const n = (k: number) => (typeof sf.get(k)?.[0] === "number" ? (sf.get(k)![0] as number) : undefined);
    out.documentMessage = {
      url: asStr(sf.get(1)?.[0]),
      mimetype: asStr(sf.get(2)?.[0]),
      title: asStr(sf.get(3)?.[0]),
      fileSha256: asBytes(sf.get(4)?.[0]),
      fileLength: n(5),
      pageCount: n(6),
      mediaKey: asBytes(sf.get(7)?.[0]),
      fileName: asStr(sf.get(8)?.[0]),
      fileEncSha256: asBytes(sf.get(9)?.[0]),
      directPath: asStr(sf.get(10)?.[0]),
      mediaKeyTimestamp: n(11),
      jpegThumbnail: asBytes(sf.get(16)?.[0]),
      caption: asStr(sf.get(20)?.[0]),
    };
  }

  const vid2 = asBytes(f.get(9)?.[0]);
  if (vid2) {
    const sf = new Reader(vid2).fields();
    const n = (k: number) => (typeof sf.get(k)?.[0] === "number" ? (sf.get(k)![0] as number) : undefined);
    out.videoMessage = {
      url: asStr(sf.get(1)?.[0]),
      mimetype: asStr(sf.get(2)?.[0]),
      fileSha256: asBytes(sf.get(3)?.[0]),
      fileLength: n(4),
      seconds: n(5),
      mediaKey: asBytes(sf.get(6)?.[0]),
      caption: asStr(sf.get(7)?.[0]),
      gifPlayback: sf.get(8)?.[0] === 1,
      height: n(9),
      width: n(10),
      fileEncSha256: asBytes(sf.get(11)?.[0]),
      directPath: asStr(sf.get(13)?.[0]),
      mediaKeyTimestamp: n(14),
      jpegThumbnail: asBytes(sf.get(16)?.[0]),
    };
  }

  const stk = asBytes(f.get(26)?.[0]);
  if (stk) {
    const sf = new Reader(stk).fields();
    const n = (k: number) => (typeof sf.get(k)?.[0] === "number" ? (sf.get(k)![0] as number) : undefined);
    out.stickerMessage = {
      url: asStr(sf.get(1)?.[0]),
      fileSha256: asBytes(sf.get(2)?.[0]),
      fileEncSha256: asBytes(sf.get(3)?.[0]),
      mediaKey: asBytes(sf.get(4)?.[0]),
      mimetype: asStr(sf.get(5)?.[0]),
      height: n(6),
      width: n(7),
      directPath: asStr(sf.get(8)?.[0]),
      fileLength: n(9),
      mediaKeyTimestamp: n(10),
      isAnimated: sf.get(13)?.[0] === 1,
    };
  }

  const dsm = asBytes(f.get(31)?.[0]);
  if (dsm) {
    const sf = new Reader(dsm).fields();
    const inner = asBytes(sf.get(2)?.[0]);
    out.deviceSentMessage = {
      destinationJid: asStr(sf.get(1)?.[0]),
      message: inner ? decodeE2EMessage(inner) : undefined,
    };
  }

  const skdm = asBytes(f.get(2)?.[0]);
  if (skdm) {
    const sf = new Reader(skdm).fields();
    out.senderKeyDistributionMessage = {
      groupId: asStr(sf.get(1)?.[0]),
      axolotlSenderKeyDistributionMessage: asBytes(sf.get(2)?.[0]),
    };
  }

  const lst = asBytes(f.get(36)?.[0]);
  if (lst) {
    const sf = new Reader(lst).fields();
    out.listMessage = {
      title: asStr(sf.get(1)?.[0]),
      description: asStr(sf.get(2)?.[0]),
      buttonText: asStr(sf.get(3)?.[0]),
      listType: typeof sf.get(4)?.[0] === "number" ? (sf.get(4)![0] as number) : undefined,
      footerText: asStr(sf.get(7)?.[0]),
      sections: (sf.get(5) ?? []).map((s) => {
        const secf = new Reader(asBytes(s)!).fields();
        return {
          title: asStr(secf.get(1)?.[0]),
          rows: (secf.get(2) ?? []).map((r) => {
            const rf = new Reader(asBytes(r)!).fields();
            return {
              title: asStr(rf.get(1)?.[0]),
              description: asStr(rf.get(2)?.[0]),
              rowId: asStr(rf.get(3)?.[0]),
            };
          }),
        };
      }),
    };
  }

  const voc = asBytes(f.get(37)?.[0]);
  if (voc) {
    const sf = new Reader(voc).fields();
    const inner = asBytes(sf.get(1)?.[0]);
    out.viewOnceMessage = { message: inner ? decodeE2EMessage(inner) : undefined };
  }

  const lrm = asBytes(f.get(39)?.[0]);
  if (lrm) {
    const sf = new Reader(lrm).fields();
    const ssr = asBytes(sf.get(3)?.[0]);
    out.listResponseMessage = {
      title: asStr(sf.get(1)?.[0]),
      description: asStr(sf.get(5)?.[0]),
      singleSelectReply: ssr ? { selectedRowId: asStr(new Reader(ssr).fields().get(1)?.[0]) } : undefined,
    };
  }

  const bm = asBytes(f.get(42)?.[0]);
  if (bm) {
    const sf = new Reader(bm).fields();
    out.buttonsMessage = {
      contentText: asStr(sf.get(6)?.[0]),
      footerText: asStr(sf.get(7)?.[0]),
      headerType: typeof sf.get(10)?.[0] === "number" ? (sf.get(10)![0] as number) : undefined,
      buttons: (sf.get(9) ?? []).map((b) => {
        const bf = new Reader(asBytes(b)!).fields();
        const bt = asBytes(bf.get(2)?.[0]);
        return {
          buttonId: asStr(bf.get(1)?.[0]),
          buttonText: bt ? { displayText: asStr(new Reader(bt).fields().get(1)?.[0]) } : undefined,
          type: typeof bf.get(3)?.[0] === "number" ? (bf.get(3)![0] as number) : undefined,
        };
      }),
    };
  }

  const brm = asBytes(f.get(43)?.[0]);
  if (brm) {
    const sf = new Reader(brm).fields();
    out.buttonsResponseMessage = {
      selectedButtonId: asStr(sf.get(1)?.[0]),
      selectedDisplayText: asStr(sf.get(2)?.[0]),
    };
  }

  const tbr = asBytes(f.get(29)?.[0]);
  if (tbr) {
    const sf = new Reader(tbr).fields();
    const idx = sf.get(4)?.[0];
    out.templateButtonReplyMessage = {
      selectedId: asStr(sf.get(1)?.[0]),
      selectedDisplayText: asStr(sf.get(2)?.[0]),
      selectedIndex: typeof idx === "number" ? idx : undefined,
    };
  }

  const mci = asBytes(f.get(35)?.[0]);
  if (mci) {
    const sf = new Reader(mci).fields();
    const v = sf.get(2)?.[0];
    out.messageContextInfo = {
      deviceListMetadataVersion: typeof v === "number" ? v : undefined,
      messageSecret: asBytes(sf.get(3)?.[0]),
    };
  }

  const inter = asBytes(f.get(45)?.[0]);
  if (inter) out.interactiveMessage = decodeInteractive(inter);

  const iresp = asBytes(f.get(48)?.[0]);
  if (iresp) {
    const sf = new Reader(iresp).fields();
    const bodyB = asBytes(sf.get(1)?.[0]);
    const nfrB = asBytes(sf.get(2)?.[0]);
    let nativeFlowResponseMessage: {
      name?: string;
      paramsJson?: string;
      version?: number;
    } | undefined;
    if (nfrB) {
      const nf = new Reader(nfrB).fields();
      const ver = nf.get(3)?.[0];
      nativeFlowResponseMessage = {
        name: asStr(nf.get(1)?.[0]),
        paramsJson: asStr(nf.get(2)?.[0]),
        version: typeof ver === "number" ? ver : undefined,
      };
    }
    out.interactiveResponseMessage = {
      body: bodyB ? { text: asStr(new Reader(bodyB).fields().get(1)?.[0]) } : undefined,
      nativeFlowResponseMessage,
    };
  }

  const rm = asBytes(f.get(46)?.[0]);
  if (rm) {
    const sf = new Reader(rm).fields();
    const ts = sf.get(4)?.[0];
    out.reactionMessage = {
      key: decodeMessageKey(asBytes(sf.get(1)?.[0])),
      text: asStr(sf.get(2)?.[0]) ?? "",
      groupingKey: asStr(sf.get(3)?.[0]),
      senderTimestampMs: typeof ts === "number" ? ts : undefined,
    };
  }

  const pm = asBytes(f.get(12)?.[0]);
  if (pm) {
    const sf = new Reader(pm).fields();
    const ty = sf.get(2)?.[0];
    out.protocolMessage = {
      key: decodeMessageKey(asBytes(sf.get(1)?.[0])),
      type: typeof ty === "number" ? ty : 0,
    };
  }

  return out;
}

/**
 * Texto plano de um `Message`. Segue `conversation` → `extendedTextMessage` e,
 * quando a mensagem é uma resposta de botão/lista (ou vem embrulhada em
 * `viewOnceMessage`), devolve o id selecionado — assim o roteador do OniBot
 * trata um toque como se fosse o comando digitado.
 */
export function messageText(m: E2EMessage | undefined): string {
  if (!m) return "";
  if (typeof m.conversation === "string") return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId;
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) {
    return m.listResponseMessage.singleSelectReply.selectedRowId;
  }
  if (m.templateButtonReplyMessage?.selectedId) return m.templateButtonReplyMessage.selectedId;
  // native flow: o toque volta com `paramsJson` = { id, display_text }. O `id`
  // é o que a gente pôs no botão (ex.: "!ping"), então é o que roteia.
  const nfr = m.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (nfr?.paramsJson) {
    try {
      const p = JSON.parse(nfr.paramsJson) as { id?: unknown };
      if (typeof p.id === "string" && p.id) return p.id;
    } catch {
      /* paramsJson não-JSON — cai no fallback */
    }
  }
  if (m.viewOnceMessage?.message) return messageText(m.viewOnceMessage.message);
  if (m.interactiveResponseMessage?.body?.text) return m.interactiveResponseMessage.body.text;
  return "";
}
