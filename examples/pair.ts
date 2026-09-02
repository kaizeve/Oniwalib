// Pareia com o WhatsApp DE VERDADE e mantém a sessão.
//
//   bun examples/pair.ts
//
// 1ª vez: mostra um QR no terminal. Abra WhatsApp > Aparelhos conectados >
// Conectar um aparelho e escaneie. A sessão fica cifrada em ./oni-auth/ — rode
// de novo e ele reconecta como aparelho já registrado, sem QR.
//
// Precisa de `WebSocket` cliente com header Origin — bun tem; o RTS ainda não
// (issue #1). NÃO pareie uma conta que você não pode perder: cliente
// não-oficial é banível.
//
// NOTA: este exemplo é só o pareamento + inspeção de nodes crus (`node.recv`).
// Para um bot que LÊ e RESPONDE mensagem 1:1 de verdade (camada Signal fase 1),
// use `examples/connect-bot.ts`.

import qrcode from "qrcode-terminal";
import { openWhatsApp } from "../src/client";
import { fileAuthState } from "../src/auth/file-state";
import { OniBot, type IncomingMessage } from "../src/bot/bot";
import { STOCK } from "../src/profiles/index";
import {
  node,
  getBinaryNodeChild,
  type BinaryNode,
} from "../src/frame/node";
import { utf8Decode } from "../src/frame/buffer";

const AUTH_PATH = "./oni-auth/auth.owl";

const { state: auth, saveCreds } = fileAuthState(AUTH_PATH);
console.log(
  `estado em ${AUTH_PATH} · regId ${auth.creds.registrationId} · ` +
    (auth.creds.registered ? `registrado como ${auth.creds.me?.id}` : "não registrado"),
);

const bot = new OniBot({ name: "oni" });
bot.register("coffee", "☕ (exemplo de comando custom)", () => "☕ aqui está");
let botAttached = false;

function bodyText(n: BinaryNode | undefined): string {
  const c = getBinaryNodeChild(n, "body")?.content;
  if (typeof c === "string") return c;
  if (c instanceof Uint8Array) return utf8Decode(c);
  return "";
}

const conn = openWhatsApp({
  auth,
  saveCreds,
  profile: STOCK,
  countryCode: "BR",
});

conn.events.on("connection.update", (u) => {
  if (u.qr) {
    console.log("\nescaneie (WhatsApp > Aparelhos conectados > Conectar um aparelho):\n");
    qrcode.generate(u.qr, { small: true });
    console.log("\n(o QR troca sozinho a cada ~20s até você escanear)");
  }
  if (u.isNewLogin) {
    console.log(`\n✅ pareado! device = ${auth.creds.me?.id}`);
  }
  if (u.connection === "open") {
    console.log(`\n🟢 conectado e autenticado como ${auth.creds.me?.id}`);
    console.log(`   comandos do bot: ${bot.commandNames.map((n) => "!" + n).join(" ")}`);
    if (!botAttached) {
      botAttached = true;
      conn.events.on("node.recv", (n) => {
        if (n.tag !== "message") return;
        // No WhatsApp real isto é <message><enc> cifrado — sem texto até a
        // libsignal entrar. Em claro (mock/protocolo), o bot responde.
        const text = bodyText(n);
        if (!text) return;
        const msg: IncomingMessage = {
          from: n.attrs.from ?? "?",
          id: n.attrs.id ?? "?",
          text,
        };
        void bot.handle(msg).then((reply) => {
          if (reply !== undefined) {
            const body = typeof reply === "string" ? reply : JSON.stringify(reply);
            conn.sendNode(
              node("message", { to: msg.from, id: `r-${msg.id}` }, [node("body", {}, body)]),
            );
          }
        });
      });
    }
  }
  if (u.connection === "close") {
    const why = u.lastDisconnect?.error?.message ?? "sem motivo";
    console.log(`\n🔴 conexão encerrada: ${why}`);
    process.exit(u.lastDisconnect ? 1 : 0);
  }
});

console.log("\nconectando…");
