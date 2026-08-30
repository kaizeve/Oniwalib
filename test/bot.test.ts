// OniBot: dispatch de comandos + monitoramento + integração pelo mock server.
//
// Tudo no top level, sem wrappers `async function`: o RTS trava ("promise
// cannot settle") num `await sock.connect()` que esteja um nível abaixo, dentro
// de uma async function chamada. Inline funciona.

import { OniBot, asciiTable } from "../src/bot/bot";
import { Monitor, humanBytes, humanDuration } from "../src/bot/monitor";
import { crypto } from "../src/crypto";
import { NoiseSocket } from "../src/noise/socket";
import { mockTransportPair } from "../src/transport/mock";
import { MockWaServer } from "../src/transport/mock-wa-server";
import { buildClientPayload } from "../src/proto/handshake";
import { encodeClientPayload } from "../src/proto/client-payload";
import { initAuthCreds } from "../src/auth/state";
import { STOCK } from "../src/profiles/index";
import { node, getBinaryNodeChild, type BinaryNode } from "../src/frame/node";
import { utf8Decode } from "../src/frame/buffer";

const C = crypto();
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
const mk = (text: string) => ({ from: "u", id: "1", text });
const mkt = (text: string, timestamp: number) => ({ from: "u", id: "1", text, timestamp });
const bodyText = (n: BinaryNode): string => {
  const c = getBinaryNodeChild(n, "body")?.content;
  return typeof c === "string" ? c : c instanceof Uint8Array ? utf8Decode(c) : "";
};

// --- dispatch (puro) -------------------------------------------------
const bot = new OniBot({ name: "t" });
ok("!ping sem carimbo → pong", (await bot.handle(mk("!ping"))) === "pong");
{
  const r = (await bot.handle(mkt("!ping", Math.floor(Date.now() / 1000) - 2))) as string;
  ok("!ping com carimbo → latência", r.startsWith("pong · ~") && r.endsWith("ms"), r);
  const lag = Number(r.replace(/\D+/g, ""));
  ok("!ping latência ~2000ms", lag >= 1500 && lag <= 4000, r);
}
ok("!echo foo bar → foo bar", (await bot.handle(mk("!echo foo bar"))) === "foo bar");
ok("!echo vazio", (await bot.handle(mk("!echo"))) === "(nada pra repetir)");
ok("texto normal → undefined", (await bot.handle(mk("oi tudo bem"))) === undefined);
ok("comando desconhecido", ((await bot.handle(mk("!nope"))) ?? "").includes("desconhecido"));

const help = (await bot.handle(mk("!help"))) ?? "";
for (const c of ["ping", "status", "mem", "uptime", "echo", "help"]) {
  ok(`!help lista ${c}`, help.includes(`!${c}`));
}

bot.register("double", "dobra um número", (a) => String(Number(a) * 2));
ok("comando custom", (await bot.handle(mk("!double 21"))) === "42");
ok("commandNames inclui custom", bot.commandNames.includes("double"));

const pbot = new OniBot({ prefix: "/" });
ok("prefixo custom", (await pbot.handle(mk("/ping"))) === "pong");
ok("prefixo errado ignora", (await pbot.handle(mk("!ping"))) === undefined);

// --- respostas ricas: botões, lista, tabela ----------------------
{
  const r = (await bot.handle(mk("!buttons"))) as any;
  ok("!buttons → buttonsMessage", !!r?.buttonsMessage);
  ok("!buttons: 3 botões", r.buttonsMessage.buttons.length === 3);
  ok("!buttons: id = comando", r.buttonsMessage.buttons[0].buttonId === "!ping");
  ok("!buttons: displayText", r.buttonsMessage.buttons[0].buttonText.displayText.includes("ping"));
}
{
  const r = (await bot.handle(mk("!list"))) as any;
  const m = (await bot.handle(mk("!menu"))) as any;
  ok("!list → listMessage", !!r?.listMessage);
  ok("!menu é alias", JSON.stringify(m) === JSON.stringify(r));
  ok("!list: 2 seções", r.listMessage.sections.length === 2);
  ok("!list: rowId = comando", r.listMessage.sections[0].rows[0].rowId === "!ping");
}
{
  const r = (await bot.handle(mk("!table"))) as string;
  ok("!table → string monoespaçada", typeof r === "string" && r.startsWith("```\n┌"));
  ok("!table tem as linhas", r.includes("uptime") && r.includes("ram (RSS)"));
}
{
  const t = asciiTable(["a", "bb"], [["1", "2"], ["333", "4"]]);
  const rows = t.split("\n");
  ok("asciiTable: topo+cab+régua+2 linhas+base = 6", rows.length === 6);
  ok("asciiTable: larguras alinhadas", rows.every((l) => l.length === rows[0].length), t);
}

// --- monitor -------------------------------------------------------
const mon = new Monitor();
const s1 = mon.sample();
ok("rss > 0", s1.rss > 0);
ok("cpus >= 1", s1.cpus >= 1);
ok("load é [n,n,n]", Array.isArray(s1.load) && s1.load.length === 3);
ok("platform é string", typeof s1.platform === "string" && s1.platform.length > 0);
ok("totalmem >= freemem > 0", s1.totalmem > 0 && s1.totalmem >= s1.freemem);
ok("1ª amostra cpuPercent null", s1.cpuPercent === null);

mon.prime();
let burn = 0;
for (let i = 0; i < 200000; i++) burn += Math.sqrt(i);
ok("burn não some (guard var-de-loop)", burn > 0);
const s2 = mon.sample();
ok("2ª amostra cpuPercent numérico", typeof s2.cpuPercent === "number");

ok("humanBytes", humanBytes(1536) === "1.5 KB" && humanBytes(0) === "0 B");
ok("humanDuration", humanDuration(3661) === "1h 1m 1s" && humanDuration(5) === "5s");

// --- integração pelo mock server (inline!) ---------------------
const [clientT, serverT] = mockTransportPair();
const server = new MockWaServer(serverT, C);
const sock = new NoiseSocket({
  transport: clientT,
  crypto: C,
  staticKey: C.generateX25519(),
  clientPayload: encodeClientPayload(buildClientPayload(initAuthCreds(), STOCK)),
});
const ibot = new OniBot({ name: "int" });

sock.events.on("node.recv", (n: BinaryNode) => {
  if (n.tag !== "message") return;
  void ibot
    .handle({ from: n.attrs.from ?? "x", id: n.attrs.id ?? "x", text: bodyText(n) })
    .then((reply) => {
      if (reply !== undefined) {
        const body = typeof reply === "string" ? reply : JSON.stringify(reply);
        sock.sendNode(node("message", { to: n.attrs.from ?? "x", id: "r" }, [node("body", {}, body)]));
      }
    });
});

let got = "";
server.onReply((n) => {
  got = bodyText(n);
});

await sock.connect();
ok("integração: handshake", sock.status === "open");

server.pushMessage({ from: "5511@s.whatsapp.net", id: "m1", text: "!ping" });
await new Promise((r) => setTimeout(r, 40));
ok("integração: !ping → pong pelo socket", got === "pong");

server.pushMessage({ from: "5511@s.whatsapp.net", id: "m2", text: "!echo integração" });
await new Promise((r) => setTimeout(r, 40));
ok("integração: !echo pelo socket", got === "integração");

sock.close();

// --- resumo ------------------------------------------------------
const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/bot [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
