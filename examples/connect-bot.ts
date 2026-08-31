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
// monoespaçada), !buttons e !list/!menu (botões e lista interativos via
// `interactiveMessage`/native flow embrulhado em viewOnce — o WhatsApp não
// desenha mais os `buttonsMessage`/`listMessage` legados de cliente não-oficial;
// o toque volta como o id `!comando` e cai no mesmo handler). !help lista tudo.
//
// !play <url|nome> — baixa um áudio do YouTube (API nether) e ENVIA como
// `audioMessage` de verdade (cifra + upload pro servidor de mídia). Sem botões
// (a lib não os renderiza); no lugar responde uma linha com ping + uso de RAM,
// pra medir o custo de memória de puxar o arquivo. Key/endpoints via env
// NETHER_KEY / NETHER_API (defaults abaixo).
//
// Grupos: LÊ (decifra `skmsg` via sender keys) E RESPONDE — cria o nosso sender
// key, manda `skmsg`, e distribui o SKDM 1:1 pra quem já tem sessão pairwise
// com o bot. Quem nunca falou no grupo desde que o bot subiu não vê a resposta
// (falta USync/cold-send pra buscar o bundle desses).
//
// Ainda NÃO: mídia, e cold-send — só dá para responder 1:1 quem já te mandou
// mensagem (a sessão vem daí). Precisa de `WebSocket` cliente com header Origin
// (bun tem). NÃO pareie uma conta que você não pode perder.

import qrcode from "qrcode-terminal";
import { openWhatsApp } from "../src/client";
import { fileAuthState } from "../src/auth/file-state";
import { OniBot, type IncomingMessage } from "../src/bot/bot";
import { humanBytes } from "../src/bot/monitor";
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

// ── !play / !musica / !youtube ──────────────────────────────────────────────
// Teste de RAM: puxa o áudio da API nether pra memória e ENVIA como
// `audioMessage`. Sem botões — responde ping + uso de memória no lugar.
const NETHER_KEY = process.env.NETHER_KEY ?? "mefodemegumi";
const NETHER_API = process.env.NETHER_API ?? "https://api.netherhost.com.br/api";
const ytAudioUrl = (url: string) =>
  `${NETHER_API}/dl/ytaudio2?url=${encodeURIComponent(url)}&apikey=${NETHER_KEY}`;
// Endpoint de busca — ajuste o path se a sua API usar outro.
const ytSearchUrl = (q: string) =>
  `${NETHER_API}/pesquisas/youtube?query=${encodeURIComponent(q)}&apikey=${NETHER_KEY}`;

function pickVideoUrl(data: unknown): string | undefined {
  const d = data as Record<string, unknown> | undefined;
  const res = (d?.resultado ?? d?.result ?? d?.data ?? d) as unknown;
  const arr = Array.isArray(res)
    ? res
    : ((res as Record<string, unknown>)?.videos as unknown[] | undefined);
  const vid = (Array.isArray(arr) ? arr[0] : res) as Record<string, unknown> | undefined;
  const u = vid?.url ?? vid?.link ?? vid?.href;
  return typeof u === "string" ? u : undefined;
}

async function resolveYouTubeUrl(q: string): Promise<string | undefined> {
  if (/^https?:\/\//i.test(q)) return q;
  const r = await fetch(ytSearchUrl(q));
  if (!r.ok) throw new Error(`busca YouTube: HTTP ${r.status}`);
  return pickVideoUrl(await r.json().catch(() => undefined));
}

function ramLine(msg: IncomingMessage, dlMs: number, bytes: number, rss0: number, rss1: number): string {
  const ping = msg.timestamp
    ? `${Math.max(0, Date.now() - msg.timestamp * 1000)}ms`
    : "n/d";
  const m = process.memoryUsage();
  return [
    `📡 ping: ~${ping}`,
    `⏬ download: ${humanBytes(bytes)} em ${dlMs}ms`,
    `🧠 RSS: ${humanBytes(m.rss)}  (Δ +${humanBytes(Math.max(0, rss1 - rss0))} no fetch)`,
    `🧩 heap: ${humanBytes(m.heapUsed)} / ${humanBytes(m.heapTotal)} · nativo ${humanBytes(m.external)}`,
  ].join("\n");
}

const playCmd = async (args: string, msg: IncomingMessage): Promise<string | undefined> => {
  const q = args.trim();
  if (!q) return "uso: !play <url do YouTube ou nome da música>";
  try {
    const rss0 = process.memoryUsage().rss;
    const url = await resolveYouTubeUrl(q);
    if (!url) return "não achei nada pra essa busca — passe a URL direto ou ajuste ytSearchUrl()";

    const t0 = Date.now();
    const res = await fetch(ytAudioUrl(url));
    if (!res.ok) return `falha ao baixar o áudio: HTTP ${res.status}`;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const dlMs = Date.now() - t0;
    const rss1 = process.memoryUsage().rss;

    await conn.sendText(msg.from, `🎵 *play* — ${url}\n\n${ramLine(msg, dlMs, bytes.length, rss0, rss1)}`);

    const tUp = Date.now();
    await conn.sendAudio(msg.from, bytes, { mimetype: "audio/mp4" });
    console.log(
      `→ ${msg.from}: audioMessage  (upload+envio ${Date.now() - tUp}ms, ${humanBytes(bytes.length)})`,
    );
  } catch (e) {
    return `erro no !play: ${(e as Error).message}`;
  }
  return undefined;
};
bot.register("play", "baixa e envia um áudio do YouTube + ping/RAM (teste de memória)", playCmd);
bot.register("musica", "alias de !play", playCmd);
bot.register("youtube", "alias de !play", playCmd);

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

    // Grupo: respondemos com sender key (skmsg) + distribuição do NOSSO SKDM
    // 1:1 para quem já tem sessão pairwise com a gente. Quem nunca falou no
    // grupo desde que o bot subiu não recebe o SKDM e não vê a resposta —
    // USync/cold-send é a próxima fase.
    const incoming: IncomingMessage = { from, id: m.key.id, text, timestamp: m.messageTimestamp };
    void bot.handle(incoming).then(async (reply) => {
      if (reply === undefined) return;
      // Um comando pode devolver uma lista (ex.: menu em texto + em botões).
      for (const r of Array.isArray(reply) ? reply : [reply]) {
        const t0 = Date.now();
        try {
          if (typeof r === "string") await conn.sendText(from, r);
          else await conn.sendMessage(from, r);
          const kind =
            typeof r === "string"
              ? r.split("\n")[0]
              : Object.keys(r.viewOnceMessage?.message ?? r).filter(
                  (k) => k !== "messageContextInfo",
                )[0] ?? "message";
          console.log(`→ ${from}: ${kind}  (envio ${Date.now() - t0}ms)`);
        } catch (e) {
          console.error(`falha ao responder ${from}:`, (e as Error).message);
        }
      }
    });
  }
});

console.log("\nconectando…");
