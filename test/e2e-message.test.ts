// Codec do `Message` E2E (proto/e2e-message.ts) — round-trips e um vetor fixo.

import {
  encodeE2EMessage,
  decodeE2EMessage,
  messageText,
} from "../src/proto/e2e-message";
import { Reader } from "../src/proto/wire";

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
const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

// conversation (campo 1) → 0a 02 6f 69
ok("conversation vira 0a026f69", hex(encodeE2EMessage({ conversation: "oi" })) === "0a026f69");
{
  const back = decodeE2EMessage(encodeE2EMessage({ conversation: "olá 👋" }));
  ok("conversation round-trip", back.conversation === "olá 👋");
  ok("messageText pega conversation", messageText(back) === "olá 👋");
}

// extendedTextMessage (campo 6) { text = 1 }
{
  const enc = encodeE2EMessage({ extendedTextMessage: { text: "com contexto" } });
  ok("extendedTextMessage usa o campo 6", (enc[0]! >> 3) === 6);
  const back = decodeE2EMessage(enc);
  ok("extendedTextMessage.text round-trip", back.extendedTextMessage?.text === "com contexto");
  ok("messageText cai no extendedText", messageText(back) === "com contexto");
}

// deviceSentMessage (campo 31) { destinationJid = 1, message = 2 }
{
  const enc = encodeE2EMessage({
    deviceSentMessage: {
      destinationJid: "123@s.whatsapp.net",
      message: { conversation: "eco" },
    },
  });
  const back = decodeE2EMessage(enc);
  ok("deviceSentMessage.destinationJid", back.deviceSentMessage?.destinationJid === "123@s.whatsapp.net");
  ok("deviceSentMessage.message aninhada", back.deviceSentMessage?.message?.conversation === "eco");
}

// campos desconhecidos são ignorados (não quebram o decode)
{
  const withExtra = new Uint8Array([
    0x0a, 0x01, 0x78, // conversation = "x"
    0x28, 0x2a, // campo 5 varint 42 (desconhecido aqui)
  ]);
  const back = decodeE2EMessage(withExtra);
  ok("campo desconhecido ignorado", back.conversation === "x");
}

// buttonsMessage (campo 42) — round-trip + campo certo
{
  const msg = {
    buttonsMessage: {
      contentText: "toque um botão",
      footerText: "oni",
      headerType: 1,
      buttons: [
        { buttonId: "!ping", buttonText: { displayText: "🏓 ping" }, type: 1 },
        { buttonId: "!status", buttonText: { displayText: "📊 status" }, type: 1 },
      ],
    },
  };
  const enc = encodeE2EMessage(msg);
  ok("buttonsMessage usa o campo 42", new Reader(enc).next().field === 42);
  const back = decodeE2EMessage(enc);
  ok("buttonsMessage.contentText", back.buttonsMessage?.contentText === "toque um botão");
  ok("buttonsMessage.footerText", back.buttonsMessage?.footerText === "oni");
  ok("buttonsMessage.headerType", back.buttonsMessage?.headerType === 1);
  ok("buttonsMessage: 2 botões", back.buttonsMessage?.buttons?.length === 2);
  ok("buttonsMessage botão id", back.buttonsMessage?.buttons?.[1]?.buttonId === "!status");
  ok(
    "buttonsMessage botão displayText",
    back.buttonsMessage?.buttons?.[0]?.buttonText?.displayText === "🏓 ping",
  );
  ok("buttonsMessage botão type", back.buttonsMessage?.buttons?.[0]?.type === 1);
}

// listMessage (campo 36) — round-trip aninhado (seções → linhas)
{
  const msg = {
    listMessage: {
      title: "menu",
      description: "escolha",
      buttonText: "abrir",
      footerText: "oni",
      listType: 1,
      sections: [
        { title: "sec A", rows: [{ title: "r1", description: "d1", rowId: "!ping" }] },
        {
          title: "sec B",
          rows: [
            { title: "r2", description: "d2", rowId: "!status" },
            { title: "r3", description: "", rowId: "!uptime" },
          ],
        },
      ],
    },
  };
  const back = decodeE2EMessage(encodeE2EMessage(msg));
  ok("listMessage.title", back.listMessage?.title === "menu");
  ok("listMessage.buttonText", back.listMessage?.buttonText === "abrir");
  ok("listMessage.listType", back.listMessage?.listType === 1);
  ok("listMessage: 2 seções", back.listMessage?.sections?.length === 2);
  ok("listMessage: seção B tem 2 linhas", back.listMessage?.sections?.[1]?.rows?.length === 2);
  ok("listMessage rowId", back.listMessage?.sections?.[0]?.rows?.[0]?.rowId === "!ping");
  ok("listMessage row description", back.listMessage?.sections?.[1]?.rows?.[0]?.description === "d2");
}

// viewOnceMessage (campo 37) embrulha um Message
{
  const back = decodeE2EMessage(
    encodeE2EMessage({ viewOnceMessage: { message: { conversation: "escondido" } } }),
  );
  ok("viewOnceMessage desembrulha", back.viewOnceMessage?.message?.conversation === "escondido");
  ok("messageText entra no viewOnce", messageText(back) === "escondido");
}

// respostas de toque → messageText devolve o id selecionado
{
  const br = decodeE2EMessage(
    encodeE2EMessage({ buttonsResponseMessage: { selectedButtonId: "!ping", selectedDisplayText: "🏓 ping" } }),
  );
  ok("buttonsResponseMessage.selectedButtonId", br.buttonsResponseMessage?.selectedButtonId === "!ping");
  ok("messageText de toque em botão = id", messageText(br) === "!ping");

  const lr = decodeE2EMessage(
    encodeE2EMessage({
      listResponseMessage: { title: "menu", singleSelectReply: { selectedRowId: "!status" } },
    }),
  );
  ok("listResponseMessage.selectedRowId", lr.listResponseMessage?.singleSelectReply?.selectedRowId === "!status");
  ok("messageText de escolha em lista = rowId", messageText(lr) === "!status");
}

// interactiveMessage (campo 45) + nativeFlowMessage — round-trip
{
  const msg = {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadataVersion: 2 },
        interactiveMessage: {
          body: { text: "toque um botão" },
          footer: { text: "oni" },
          nativeFlowMessage: {
            buttons: [
              { name: "quick_reply", buttonParamsJson: '{"display_text":"🏓 ping","id":"!ping"}' },
              { name: "quick_reply", buttonParamsJson: '{"display_text":"📊 status","id":"!status"}' },
            ],
          },
        },
      },
    },
  };
  const back = decodeE2EMessage(encodeE2EMessage(msg));
  const im = back.viewOnceMessage?.message?.interactiveMessage;
  ok("interactiveMessage.body round-trip", im?.body?.text === "toque um botão");
  ok("interactiveMessage.footer round-trip", im?.footer?.text === "oni");
  ok("nativeFlowMessage: 2 botões", im?.nativeFlowMessage?.buttons?.length === 2);
  ok("nativeFlow botão name", im?.nativeFlowMessage?.buttons?.[0]?.name === "quick_reply");
  ok(
    "nativeFlow botão params",
    im?.nativeFlowMessage?.buttons?.[1]?.buttonParamsJson === '{"display_text":"📊 status","id":"!status"}',
  );
  ok(
    "messageContextInfo.deviceListMetadataVersion",
    back.viewOnceMessage?.message?.messageContextInfo?.deviceListMetadataVersion === 2,
  );
}

// toque em native flow → interactiveResponseMessage (campo 48) → messageText = id
{
  const resp = decodeE2EMessage(
    encodeE2EMessage({
      interactiveResponseMessage: {
        body: { text: "🏓 ping" },
        nativeFlowResponseMessage: {
          name: "quick_reply",
          paramsJson: '{"id":"!ping","display_text":"🏓 ping"}',
        },
      },
    }),
  );
  ok(
    "interactiveResponseMessage.nativeFlowResponseMessage.name",
    resp.interactiveResponseMessage?.nativeFlowResponseMessage?.name === "quick_reply",
  );
  ok("messageText de toque em native flow = id", messageText(resp) === "!ping");

  // quick_reply às vezes volta como templateButtonReplyMessage (campo 29)
  const tbr = decodeE2EMessage(
    encodeE2EMessage({ templateButtonReplyMessage: { selectedId: "!status", selectedDisplayText: "📊" } }),
  );
  ok("templateButtonReplyMessage.selectedId", tbr.templateButtonReplyMessage?.selectedId === "!status");
  ok("messageText de templateButtonReply = id", messageText(tbr) === "!status");
}

// reactionMessage: campo 46 no fio (não 25 = templateMessage)
{
  const enc = encodeE2EMessage({
    reactionMessage: { key: { id: "x", remoteJid: "a@s.whatsapp.net", fromMe: false }, text: "🔥" },
  });
  ok("reactionMessage usa o campo 46", new Reader(enc).next().field === 46);
  const back = decodeE2EMessage(enc);
  ok("reactionMessage round-trip", back.reactionMessage?.text === "🔥");
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/e2e-message [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
