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
//     DeviceSentMessage deviceSentMessage                       = 31;  // { string destinationJid = 1; Message message = 2; }
//     MessageContextInfo messageContextInfo                     = 35;  // ignorado
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

export interface E2EMessage {
  conversation?: string;
  extendedTextMessage?: { text?: string };
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
}

export function encodeE2EMessage(m: E2EMessage): Uint8Array {
  const w = new Writer();
  if (m.conversation !== undefined) w.string(1, m.conversation);
  if (m.extendedTextMessage) {
    w.message(6, new Writer().string(1, m.extendedTextMessage.text));
  }
  if (m.deviceSentMessage) {
    const sub = new Writer().string(1, m.deviceSentMessage.destinationJid);
    if (m.deviceSentMessage.message) sub.bytes(2, encodeE2EMessage(m.deviceSentMessage.message));
    w.message(31, sub);
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
  if (m.viewOnceMessage?.message) return messageText(m.viewOnceMessage.message);
  return "";
}
