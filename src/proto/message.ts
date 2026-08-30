// Builders de body de mensagem — a forma que o `Message` do protobuf da WA tem
// no fio, montada como objeto JS puro (o que o protobufjs produziria).
//
// Cobre texto e os tipos INTERATIVOS que os forks modificados da Baileys
// mantêm vivos depois que o WhatsApp restringiu botões no cliente não-oficial:
// `buttonsMessage`, `listMessage`, `templateMessage`, `interactiveMessage`.
// Aqui só se MONTA o body; cifrar, enquadrar e enviar é fase posterior.
//
// NOTA: quando o `proto/` real (D3 do plano) entrar, estes objetos passam a ser
// validados contra o schema. Até lá são a referência da forma esperada.

export interface TextBody {
  conversation?: string;
  extendedTextMessage?: {
    text: string;
    contextInfo?: ContextInfo;
    previewType?: "NONE" | "VIDEO";
  };
}

export interface ContextInfo {
  stanzaId?: string;
  participant?: string;
  quotedMessage?: Message;
  mentionedJid?: string[];
  expiration?: number;
}

export interface ButtonSpec {
  id: string;
  text: string;
}

export interface ListRow {
  title: string;
  description?: string;
  rowId: string;
}

export interface ListSection {
  title: string;
  rows: ListRow[];
}

export interface NativeFlowButton {
  name: string;
  /** JSON serializado dos parâmetros — ex.: `{"display_text":"Abrir","url":"https://..."}` */
  paramsJson: string;
}

// A união fica aberta: novos tipos entram sem quebrar quem consome.
export type Message = TextBody & Record<string, unknown>;

export function text(body: string, ctx?: ContextInfo): Message {
  if (!ctx) {
    return { conversation: body };
  }
  return { extendedTextMessage: { text: body, contextInfo: ctx } };
}

// --- botões clássicos (buttonsMessage) -------------------------------------

export function buttons(opts: {
  content: string;
  footer?: string;
  buttons: ButtonSpec[];
  headerType?: number;
}): Message {
  return {
    buttonsMessage: {
      contentText: opts.content,
      footerText: opts.footer,
      headerType: opts.headerType ?? 1,
      buttons: opts.buttons.map((b) => ({
        buttonId: b.id,
        buttonText: { displayText: b.text },
        type: 1,
      })),
    },
  };
}

// --- lista (listMessage) --------------------------------------------------

export function list(opts: {
  title: string;
  description: string;
  buttonText: string;
  sections: ListSection[];
  footer?: string;
}): Message {
  return {
    listMessage: {
      title: opts.title,
      description: opts.description,
      buttonText: opts.buttonText,
      footerText: opts.footer,
      listType: 1, // SINGLE_SELECT
      sections: opts.sections.map((s) => ({
        title: s.title,
        rows: s.rows.map((r) => ({
          title: r.title,
          description: r.description ?? "",
          rowId: r.rowId,
        })),
      })),
    },
  };
}

// --- template com botões hidratados (templateMessage) --------------------

export function template(opts: {
  content: string;
  footer?: string;
  buttons: Array<
    | { quickReply: { id: string; text: string } }
    | { url: { text: string; url: string } }
    | { call: { text: string; phoneNumber: string } }
  >;
}): Message {
  return {
    templateMessage: {
      hydratedTemplate: {
        hydratedContentText: opts.content,
        hydratedFooterText: opts.footer,
        hydratedButtons: opts.buttons.map((b, i) => {
          const index = i + 1;
          if ("quickReply" in b) {
            return {
              index,
              quickReplyButton: {
                displayText: b.quickReply.text,
                id: b.quickReply.id,
              },
            };
          }
          if ("url" in b) {
            return {
              index,
              urlButton: { displayText: b.url.text, url: b.url.url },
            };
          }
          return {
            index,
            callButton: {
              displayText: b.call.text,
              phoneNumber: b.call.phoneNumber,
            },
          };
        }),
      },
    },
  };
}

// --- native flow / interactive (o caminho atual dos forks) ---------------

export function interactive(opts: {
  body: string;
  footer?: string;
  title?: string;
  subtitle?: string;
  buttons: NativeFlowButton[];
}): Message {
  return {
    interactiveMessage: {
      body: { text: opts.body },
      footer: opts.footer ? { text: opts.footer } : undefined,
      header: opts.title
        ? { title: opts.title, subtitle: opts.subtitle, hasMediaAttachment: false }
        : undefined,
      nativeFlowMessage: {
        buttons: opts.buttons.map((b) => ({
          name: b.name,
          buttonParamsJson: b.paramsJson,
        })),
      },
    },
  };
}

// Atalhos de native flow mais usados.
export const flow = {
  quickReply(text: string, id: string): NativeFlowButton {
    return {
      name: "quick_reply",
      paramsJson: JSON.stringify({ display_text: text, id }),
    };
  },
  url(text: string, url: string): NativeFlowButton {
    return {
      name: "cta_url",
      paramsJson: JSON.stringify({ display_text: text, url }),
    };
  },
  copy(text: string, copyCode: string): NativeFlowButton {
    return {
      name: "cta_copy",
      paramsJson: JSON.stringify({ display_text: text, copy_code: copyCode }),
    };
  },
  call(text: string, phone: string): NativeFlowButton {
    return {
      name: "cta_call",
      paramsJson: JSON.stringify({ display_text: text, phone_number: phone }),
    };
  },
};

// Alguns forks embrulham interactive/buttons num viewOnce para o WhatsApp
// oficial renderizar. Helper explícito, sem esconder o que faz.
export function wrapViewOnce(msg: Message): Message {
  return { viewOnceMessage: { message: msg } };
}
