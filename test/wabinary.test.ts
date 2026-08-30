// Round-trip do codec WABinary + forma dos builders. Script autocontido: roda
// em bun (`bun test/wabinary.test.ts`) e no RTS (`rts run test/wabinary.test.ts`)
// sem framework de teste, para comparar os dois runtimes lado a lado.

import { decodeBinaryNode } from "../src/frame/decode";
import { encodeBinaryNode } from "../src/frame/encode";
import { node, type BinaryNode } from "../src/frame/node";
import { utf8Encode } from "../src/frame/buffer";
import { jidDecode } from "../src/frame/jid";
import * as m from "../src/proto/message";

let pass = 0;
let fail = 0;
const fails: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    fails.push(name + (detail ? ` — ${detail}` : ""));
  }
}

function eq(name: string, a: unknown, b: unknown): void {
  const sa = stable(a);
  const sb = stable(b);
  ok(name, sa === sb, sa === sb ? "" : `\n  got : ${sa}\n  want: ${sb}`);
}

// JSON estável para comparar nodes (Uint8Array → array de números).
function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val instanceof Uint8Array) {
      return { __u8: Array.from(val) };
    }
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val as object).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

function roundtrip(name: string, n: BinaryNode): void {
  const bytes = encodeBinaryNode(n);
  const back = decodeBinaryNode(bytes);
  eq(name, back, n);
}

// O fio NÃO distingue "conteúdo string" de "conteúdo binário": os dois usam
// BINARY_8/20/32. Um conteúdo string não-token volta como os bytes UTF-8 dele —
// o consumidor decide decodificar. (Atributos e tags SÃO strings e voltam como
// string.) Esta é a semântica da Baileys também.
function roundtripContentText(name: string, tag: string, content: string): void {
  const back = decodeBinaryNode(encodeBinaryNode(node(tag, {}, content)));
  eq(name, back, node(tag, {}, utf8Encode(content)));
}

// --- 1. round-trips do codec ------------------------------------------------

roundtrip("node vazio", node("ping"));

roundtrip("node só com atributos", node("iq", { type: "get", to: "s.whatsapp.net", id: "abc123" }));

roundtrip(
  "node com conteúdo de texto (via token, volta string)",
  node("message", { id: "1" }, "message"),
);
roundtripContentText("node com conteúdo de texto não-token", "message", "olá mundo");

roundtrip(
  "node com bytes crus",
  node("enc", { v: "2", type: "pkmsg" }, Uint8Array.from([0, 1, 2, 253, 254, 255])),
);

roundtrip(
  "node aninhado",
  node("iq", { type: "result", from: "s.whatsapp.net" }, [
    node("list", {}, [
      node("item", { jid: "5511999999999@s.whatsapp.net" }),
      node("item", { jid: "5511888888888@s.whatsapp.net" }),
    ]),
    node("nothing"),
  ]),
);

roundtripContentText("string longa (> 255) força BINARY_20", "data", "x".repeat(1000));

roundtripContentText("unicode e emoji", "t", "acentuação — 🔌 café");

roundtrip(
  "lista com 300 filhos força LIST_16",
  node(
    "big",
    {},
    Array.from({ length: 300 }, (_v, i) => node("n", { i: String(i) })),
  ),
);

// --- 2. tokens -----------------------------------------------------------

{
  // "message" está na tabela de 1 byte → deve virar UM byte (não BINARY_8+len).
  const withToken = encodeBinaryNode(node("message"));
  const withoutToken = encodeBinaryNode(node("zzznontoken"));
  ok(
    "token de 1 byte encurta o encode",
    withToken.length < withoutToken.length,
    `${withToken.length} vs ${withoutToken.length}`,
  );
}

{
  // Token desconhecido no fio deve LANÇAR, não devolver lixo.
  let threw = false;
  try {
    decodeBinaryNode(Uint8Array.from([0xf8, 0x01, 0xec, 0x7f]));
  } catch {
    threw = true;
  }
  ok("token desconhecido lança", threw);
}

// --- 3. JID ------------------------------------------------------------

{
  const j = jidDecode("5511999999999:12@s.whatsapp.net");
  eq("jid user", j?.user, "5511999999999");
  eq("jid server", j?.server, "s.whatsapp.net");
  eq("jid device", j?.device, 12);
}

// --- 4. builders de mensagem ---------------------------------------

eq("text simples", m.text("oi"), { conversation: "oi" });

{
  const b = m.buttons({
    content: "Escolha:",
    footer: "rodapé",
    buttons: [
      { id: "a", text: "Opção A" },
      { id: "b", text: "Opção B" },
    ],
  });
  const bm = (b as any).buttonsMessage;
  ok("buttonsMessage tem 2 botões", bm?.buttons?.length === 2);
  eq("buttonId preservado", bm.buttons[0].buttonId, "a");
  eq("displayText preservado", bm.buttons[1].buttonText.displayText, "Opção B");
}

{
  const l = m.list({
    title: "Menu",
    description: "desc",
    buttonText: "Ver",
    sections: [{ title: "Seção 1", rows: [{ title: "R1", rowId: "r1" }] }],
  });
  eq("listMessage rowId", (l as any).listMessage.sections[0].rows[0].rowId, "r1");
}

{
  const i = m.interactive({
    body: "corpo",
    footer: "rodapé",
    buttons: [m.flow.url("Abrir site", "https://example.com"), m.flow.quickReply("Sim", "yes")],
  });
  const nf = (i as any).interactiveMessage.nativeFlowMessage;
  eq("nativeFlow 2 botões", nf.buttons.length, 2);
  eq("cta_url name", nf.buttons[0].name, "cta_url");
  ok(
    "paramsJson é JSON válido",
    (() => {
      try {
        JSON.parse(nf.buttons[0].buttonParamsJson);
        return true;
      } catch {
        return false;
      }
    })(),
  );
}

{
  const w = m.wrapViewOnce(m.text("segredo"));
  eq("viewOnce embrulha", (w as any).viewOnceMessage.message.conversation, "segredo");
}

// --- resumo ------------------------------------------------------------

const runtime =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";

console.log(`\noniwalib/wabinary [${runtime}]  ${pass} pass, ${fail} fail`);
for (const f of fails) {
  console.log("  ✗ " + f);
}
if (fail > 0) {
  if (typeof process !== "undefined") {
    process.exitCode = 1;
  }
  throw new Error(`${fail} falha(s)`);
}
