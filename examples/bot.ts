// Bot básico sobre a oniwalib — comandos + monitoramento de CPU/RAM.
//
// Roda em bun (`bun examples/bot.ts`) e no RTS
// (`../rts/target/fast/rts run examples/bot.ts`).
//
// IMPORTANTE: a oniwalib ainda NÃO conecta no WhatsApp (falta o conector
// TLS+WebSocket real — issue #1). Aqui o bot roda sobre `MockWaServer`, o
// servidor Noise em memória. A lógica de comando e o monitoramento são reais e
// portáveis: quando o transporte real entrar, `attachBot` aponta pra ele e o
// bot funciona de verdade.

import { NoiseSocket } from "../src/noise/socket";
import { mockTransportPair } from "../src/transport/mock";
import { MockWaServer } from "../src/transport/mock-wa-server";
import { crypto, initAuthCreds, STOCK } from "../src/index";
import { buildClientPayload } from "../src/proto/handshake";
import { encodeClientPayload } from "../src/proto/client-payload";
import { OniBot, type IncomingMessage } from "../src/bot/bot";
import { node, getBinaryNodeChild, type BinaryNode } from "../src/frame/node";
import { utf8Decode } from "../src/frame/buffer";

// O conteúdo string de um node volta do fio como bytes (o WABinary não
// distingue string de binário). Este helper resolve os dois.
function bodyText(n: BinaryNode | undefined): string {
  const body = getBinaryNodeChild(n, "body");
  const c = body?.content;
  if (typeof c === "string") return c;
  if (c instanceof Uint8Array) return utf8Decode(c);
  return "";
}

// Liga um OniBot a um NoiseSocket. Extrai texto do node `<message><body>` (a
// convenção do mock) e responde com a mesma forma. É AQUI que o pipeline real
// (libsignal decrypt + protobuf) entra, quando existir.
function attachBot(sock: NoiseSocket, bot: OniBot): void {
  // `.then()` e não `async (n) => await ...`: no RTS, um callback de emitter
  // marcado `async` deixa a continuação do `await` fora do event loop e o
  // processo trava. A cadeia de promise explícita não tem esse problema.
  sock.events.on("node.recv", (n: BinaryNode) => {
    if (n.tag !== "message") return;
    const msg: IncomingMessage = {
      from: n.attrs.from ?? "unknown",
      id: n.attrs.id ?? "?",
      text: bodyText(n),
    };
    void bot.handle(msg).then((reply) => {
      if (reply !== undefined) {
        const body = typeof reply === "string" ? reply : JSON.stringify(reply);
        sock.sendNode(node("message", { to: msg.from, id: `r-${msg.id}` }, [node("body", {}, body)]));
      }
    });
  });
}

const C = crypto();
const [clientT, serverT] = mockTransportPair();
const server = new MockWaServer(serverT, C);

const sock = new NoiseSocket({
  transport: clientT,
  crypto: C,
  staticKey: C.generateX25519(),
  clientPayload: encodeClientPayload(buildClientPayload(initAuthCreds(), STOCK)),
});

const bot = new OniBot({ name: "oni-demo" });
bot.register("coffee", "☕ (comando custom de exemplo)", () => "☕ aqui está");
attachBot(sock, bot);

// imprime o que o bot respondeu
server.onReply((n) => {
  console.log(`\n\x1b[36m← bot\x1b[0m\n${bodyText(n)}`);
});

await sock.connect();
console.log("handshake ok · bot no ar\n");

const script = ["!ping", "!status", "!echo hello oni", "!coffee", "!help", "!nope"];
for (let i = 0; i < script.length; i++) {
  const line = script[i]!;
  console.log(`\x1b[33m→ user\x1b[0m  ${line}`);
  const t0 = Date.now();
  server.pushMessage({ from: "5511999999999@s.whatsapp.net", id: `m${i}`, text: line });
  await new Promise((r) => setTimeout(r, 30));
  if (line === "!ping") console.log(`   (round-trip ~${Date.now() - t0}ms)`);
}

await new Promise((r) => setTimeout(r, 30));
sock.close();
console.log("\n\x1b[32mfim.\x1b[0m");
