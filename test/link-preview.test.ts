// src/link-preview.ts — extrai título/descrição/URL canônica das meta tags e o
// codec E2E carrega os campos do card (`matchedText`/`canonicalUrl`/`title`/
// `description`). `fetch` é um dublê que devolve HTML fixo.

import { fetchLinkPreview, firstUrl } from "../src/link-preview";
import { encodeE2EMessage, decodeE2EMessage } from "../src/proto/e2e-message";

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

const htmlFetch = (html: string, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => html,
});

// --- firstUrl ---------------------------------------------------------------
ok("firstUrl: pega a URL no meio do texto", firstUrl("olha isso https://exemplo.com/a legal") === "https://exemplo.com/a");
ok("firstUrl: tira pontuação final", firstUrl("veja https://exemplo.com/pag.") === "https://exemplo.com/pag");
ok("firstUrl: sem URL → undefined", firstUrl("sem link nenhum aqui") === undefined);
ok("firstUrl: http também", firstUrl("http://x.test/y") === "http://x.test/y");

// --- OpenGraph -----------------------------------------------------------
{
  const html = `<!doctype html><html><head>
    <title>fallback</title>
    <meta property="og:title" content="Título OG &amp; cia">
    <meta property="og:description" content="Descrição do card">
    <meta property="og:url" content="https://exemplo.com/canonico">
  </head><body>x</body></html>`;
  const p = await fetchLinkPreview("dá uma olhada em https://exemplo.com/x", htmlFetch(html));
  ok("og: matchedText = URL do texto", p?.matchedText === "https://exemplo.com/x");
  ok("og: title (com entidade decodificada)", p?.title === "Título OG & cia");
  ok("og: description", p?.description === "Descrição do card");
  ok("og: canonicalUrl", p?.canonicalUrl === "https://exemplo.com/canonico");
}

// --- fallback pra <title> + meta name=description -----------------------
{
  const html = `<html><head><title>  Só o title  </title>
    <meta name="description" content="meta description simples"></head></html>`;
  const p = await fetchLinkPreview("https://exemplo.com/y", htmlFetch(html));
  ok("fallback: title do <title>", p?.title === "Só o title");
  ok("fallback: description do meta name", p?.description === "meta description simples");
  ok("fallback: canonicalUrl = a própria URL", p?.canonicalUrl === "https://exemplo.com/y");
}

// --- casos que devolvem undefined --------------------------------------
ok("sem URL → undefined", (await fetchLinkPreview("texto puro", htmlFetch("<html></html>"))) === undefined);
ok("sem fetch → undefined", (await fetchLinkPreview("https://x.test", undefined)) === undefined);
ok("HTTP 500 → undefined", (await fetchLinkPreview("https://x.test", htmlFetch("<html><title>x</title></html>", 500))) === undefined);
ok("resposta não-HTML → undefined", (await fetchLinkPreview("https://x.test", htmlFetch('{"json":true}'))) === undefined);
ok("HTML sem title/description → undefined", (await fetchLinkPreview("https://x.test", htmlFetch("<html><head></head><body>nada</body></html>"))) === undefined);
{
  const boom = async () => {
    throw new Error("rede caiu");
  };
  ok("fetch que lança → undefined (não propaga)", (await fetchLinkPreview("https://x.test", boom as never)) === undefined);
}

// --- codec E2E: campos do card sobrevivem ao round-trip ---------------
{
  const msg = {
    extendedTextMessage: {
      text: "veja https://exemplo.com/x",
      matchedText: "https://exemplo.com/x",
      canonicalUrl: "https://exemplo.com/canonico",
      title: "Título",
      description: "Descrição",
    },
  };
  const rt = decodeE2EMessage(encodeE2EMessage(msg)).extendedTextMessage!;
  ok("codec: text", rt.text === "veja https://exemplo.com/x");
  ok("codec: matchedText", rt.matchedText === "https://exemplo.com/x");
  ok("codec: canonicalUrl", rt.canonicalUrl === "https://exemplo.com/canonico");
  ok("codec: title", rt.title === "Título");
  ok("codec: description", rt.description === "Descrição");
}
{
  // texto simples continua sem os campos do card
  const rt = decodeE2EMessage(encodeE2EMessage({ extendedTextMessage: { text: "oi" } })).extendedTextMessage!;
  ok("codec: sem card → matchedText undefined", rt.matchedText === undefined && rt.title === undefined);
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/link-preview [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
