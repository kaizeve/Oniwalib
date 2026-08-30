// OniBot no WhatsApp DE VERDADE — lê e responde mensagem 1:1.
//
//   bun examples/connect-bot.ts
//
// 1ª vez: mostra um QR. Abra WhatsApp > Aparelhos conectados > Conectar um
// aparelho e escaneie. A sessão fica cifrada em ./oni-auth/ — rode de novo e
// reconecta sem QR.
//
// O que roda agora (fase 1 da camada Signal): decifra `<message><enc>`
// (pkmsg/msg) de conversa 1:1, decodifica o texto e responde CIFRADO. Sobe as
// pré-chaves logo após o `<success>`.
//
// Comandos: !ping (mostra a latência WhatsApp→bot), !status, !table (tabela
// monoespaçada), !buttons e !list/!menu (botões e lista interativos —
// buttonsMessage / listMessage; o toque volta como o id `!comando` e cai no
// mesmo handler). !help lista tudo.
//
// Grupos: LÊ (decifra `skmsg` via sender keys) e loga. RESPONDER em grupo
// (nosso sender key + distribuição USync) ainda é fase 2.
//
// Ainda NÃO: mídia, e cold-send — só dá para responder 1:1 quem já te mandou
// mensagem (a sessão vem daí). Precisa de `WebSocket` cliente com header Origin
// (bun tem). NÃO pareie uma conta que você não pode perder.

import qrcode from "qrcode-terminal";
import { openWhatsApp } from "../src/client";
import { fileAuthState } from "../src/auth/file-state";
import { OniBot, type IncomingMessage } from "../src/bot/bot";
import { STOCK } from "../src/profiles/index";
import { messageText } from "../src/proto/e2e-message";

const AUTH_PATH = "./oni-auth/auth.owl";

const { state: auth, saveCreds } = fileAuthState(AUTH_PATH);
console.log(
  `estado em ${AUTH_PATH} · regId ${auth.creds.registrationId} · ` +
    (auth.creds.registered ? `registrado como ${auth.creds.me?.id}` : "não registrado"),
);

const bot = new OniBot({ name: "oni" });
bot.register("coffee", "☕ (exemplo de comando custom)", () => "☕ aqui está");
// Manda !buttons / !list / !table de outro número para testar os tipos ricos.

// maxRetries alto: para um bot que fica no ar, quedas transitórias devem
// reconectar DENTRO do processo (backoff exponencial, teto de 10s) em vez de
// derrubar tudo. O `client.ts` ignora esse limite nos códigos de logout
// (401/403/405/conflict/device_removed) — esses sim encerram de vez.
const conn = openWhatsApp({
  auth,
  saveCreds,
  profile: STOCK,
  countryCode: "BR",
  maxRetries: 1_000_000,
});

conn.events.on("connection.update", (u) => {
  if (u.qr) {
    console.log("\nescaneie (WhatsApp > Aparelhos conectados > Conectar um aparelho):\n");
    qrcode.generate(u.qr, { small: true });
    console.log("\n(o QR troca sozinho a cada ~20s até você escanear)");
  }
  if (u.isNewLogin) console.log(`\n✅ pareado! device = ${auth.creds.me?.id}`);
  if (u.connection === "open") {
    console.log(`\n🟢 conectado como ${auth.creds.me?.id}`);
    console.log(`   comandos: ${bot.commandNames.map((n) => "!" + n).join(" ")}`);
    console.log("   manda um !ping de outro número…");
  }
  if (u.connection === "close") {
    // Com maxRetries alto, só chega aqui em logout de verdade (sessão morta).
    console.log(`\n🔴 sessão encerrada: ${u.lastDisconnect?.error?.message ?? "sem motivo"}`);
    console.log("   (precisa parear de novo — apague ./oni-auth e rode `npm run bot`)");
    process.exit(1);
  }
});

conn.events.on("messages.upsert", ({ messages }) => {
  for (const m of messages) {
    if (m.key.fromMe || !m.message) continue;
    const text = messageText(m.message as Parameters<typeof messageText>[0]);
    if (!text) continue;
    const from = m.key.remoteJid;
    const inGroup = from.endsWith("@g.us");
    console.log(`← ${inGroup ? `[grupo ${from}] ` : ""}${m.pushName ?? from}: ${text}`);

    if (inGroup) {
      // Grupo já é LIDO (sender keys). RESPONDER em grupo precisa do nosso
      // próprio sender key + distribuição via USync — fase 2. Só logamos.
      continue;
    }

    const incoming: IncomingMessage = { from, id: m.key.id, text, timestamp: m.messageTimestamp };
    void bot.handle(incoming).then((reply) => {
      if (reply === undefined) return;
      const t0 = Date.now();
      const send =
        typeof reply === "string" ? conn.sendText(from, reply) : conn.sendMessage(from, reply);
      send
        .then(() => {
          const kind = typeof reply === "string" ? reply : Object.keys(reply)[0];
          console.log(`→ ${from}: ${kind}  (envio ${Date.now() - t0}ms)`);
        })
        .catch((e) => console.error(`falha ao responder ${from}:`, (e as Error).message));
    });
  }
});

console.log("\nconectando…");
