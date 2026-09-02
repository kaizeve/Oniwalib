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
// Áudio a partir de uma URL do YouTube → responde os bytes do mp3 (audio/mpeg).
const ytAudioUrl = (url: string) =>
  `${NETHER_API}/dl/ytaudio2?url=${encodeURIComponent(url)}&apikey=${NETHER_KEY}`;
// Busca por nome → { status, resultado: [ { url, title, author, seconds, … } ] }.
const ytSearchUrl = (q: string) =>
  `${NETHER_API}/ytsrc?q=${encodeURIComponent(q)}&apikey=${NETHER_KEY}`;

interface Track {
  url: string;
  title?: string;
  author?: string;
  seconds?: number;
  timestamp?: string;
}

function firstTrack(data: unknown): Track | undefined {
  const d = data as Record<string, any> | undefined;
  const list = d?.resultado ?? d?.result ?? d?.data;
  const v = (Array.isArray(list) ? list[0] : Array.isArray(d) ? d[0] : d) as
    | Record<string, any>
    | undefined;
  const url = v?.url ?? v?.link;
  if (typeof url !== "string") return undefined;
  return {
    url,
    title: v?.title ?? v?.titulo,
    author: v?.author?.name ?? v?.author ?? v?.channel?.name ?? v?.channel,
    seconds: typeof v?.seconds === "number" ? v.seconds : v?.duration?.seconds,
    timestamp: v?.timestamp ?? v?.duration?.timestamp,
  };
}

async function resolveTrack(q: string): Promise<Track | undefined> {
  if (/^https?:\/\//i.test(q)) return { url: q };
  const r = await fetch(ytSearchUrl(q));
  if (!r.ok) throw new Error(`busca YouTube: HTTP ${r.status}`);
  return firstTrack(await r.json().catch(() => undefined));
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
    const track = await resolveTrack(q);
    if (!track) return "não achei nada pra essa busca";

    const t0 = Date.now();
    const res = await fetch(ytAudioUrl(track.url));
    if (!res.ok) return `falha ao baixar o áudio: HTTP ${res.status}`;
    const ct = res.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await res.arrayBuffer());
    const dlMs = Date.now() - t0;
    const rss1 = process.memoryUsage().rss;

    const head = track.title
      ? `🎵 *${track.title}*` +
        (track.author ? ` — ${track.author}` : "") +
        (track.timestamp ? ` (${track.timestamp})` : "") +
        `\n${track.url}`
      : `🎵 *play* — ${track.url}`;
    await conn.sendText(msg.from, `${head}\n\n${ramLine(msg, dlMs, bytes.length, rss0, rss1)}`);

    const mime = ct.startsWith("audio/") ? ct.split(";")[0]! : "audio/mpeg";
    const tUp = Date.now();
    await conn.sendAudio(msg.from, bytes, { mimetype: mime, seconds: track.seconds });
    console.log(
      `→ ${msg.from}: audioMessage ${mime} (upload+envio ${Date.now() - tUp}ms, ${humanBytes(bytes.length)})`,
    );
  } catch (e) {
    return `erro no !play: ${(e as Error).message}`;
  }
  return undefined;
};
bot.register("play", "baixa e envia um áudio do YouTube + ping/RAM (teste de memória)", playCmd);
bot.register("musica", "alias de !play", playCmd);
bot.register("youtube", "alias de !play", playCmd);

// ── mídia + perfil ─────────────────────────────────────────────────────────
// Baixa uma URL para a memória e repassa aos helpers da lib. Formato:
//   !img <url> [legenda...]   envia foto        !doc <url> [nome do arquivo]
//   !fig <url>                envia figurinha    !foto <url>  troca a foto do perfil
//   !bio <texto>              troca o recado
async function grab(url: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} ao baixar ${url}`);
  return { bytes: new Uint8Array(await r.arrayBuffer()), mime: (r.headers.get("content-type") ?? "").split(";")[0]! };
}

bot.register("img", "envia uma foto de uma URL (!img <url> [legenda])", async (args, msg) => {
  const [url, ...rest] = args.trim().split(/\s+/);
  if (!url) return "uso: !img <url> [legenda]";
  try {
    const { bytes, mime } = await grab(url);
    await conn.sendImage(msg.from, bytes, {
      mimetype: mime.startsWith("image/") ? mime : "image/jpeg",
      caption: rest.join(" ") || undefined,
    });
    console.log(`→ ${msg.from}: imageMessage (${humanBytes(bytes.length)})`);
  } catch (e) {
    return `erro no !img: ${(e as Error).message}`;
  }
  return undefined;
});

bot.register("doc", "envia um arquivo de uma URL (!doc <url> [nome])", async (args, msg) => {
  const [url, ...rest] = args.trim().split(/\s+/);
  if (!url) return "uso: !doc <url> [nome do arquivo]";
  try {
    const { bytes, mime } = await grab(url);
    const fileName = rest.join(" ") || url.split("/").pop()?.split("?")[0] || "arquivo";
    await conn.sendDocument(msg.from, bytes, { mimetype: mime || undefined, fileName });
    console.log(`→ ${msg.from}: documentMessage ${fileName} (${humanBytes(bytes.length)})`);
  } catch (e) {
    return `erro no !doc: ${(e as Error).message}`;
  }
  return undefined;
});

bot.register("fig", "envia uma figurinha de uma URL (webp/png/jpg)", async (args, msg) => {
  const url = args.trim();
  if (!url) return "uso: !fig <url de imagem>";
  try {
    const { bytes } = await grab(url);
    await conn.sendSticker(msg.from, bytes);
    console.log(`→ ${msg.from}: stickerMessage (${humanBytes(bytes.length)})`);
  } catch (e) {
    return `erro no !fig: ${(e as Error).message}`;
  }
  return undefined;
});

bot.register("foto", "troca a foto de perfil do bot (!foto <url de imagem>)", async (args) => {
  const url = args.trim();
  if (!url) return "uso: !foto <url de imagem quadrada, JPEG)>";
  try {
    const { bytes } = await grab(url);
    await conn.setProfilePicture(bytes);
    return "✅ foto de perfil atualizada";
  } catch (e) {
    return `erro no !foto: ${(e as Error).message}`;
  }
});

bot.register("bio", "troca o recado/bio do bot (!bio <texto>)", async (args) => {
  const text = args.trim();
  if (!text) return "uso: !bio <texto>";
  try {
    await conn.setBio(text);
    return `✅ recado atualizado para: ${text}`;
  } catch (e) {
    return `erro no !bio: ${(e as Error).message}`;
  }
});

// !status <texto>  → status de texto
// !status <url de imagem/vídeo> [legenda]  → posta a mídia como status
// Visível para quem mandou o comando (num teste real, passe a lista de contatos).
// `!status` é embutido no OniBot (cpu/ram/uptime). NÃO registrar aqui.

// `!storys <texto>`  |  `!storys <url de img/vídeo> [legenda]`
//   posta nos stories/status do WhatsApp do bot.
// Quem vê: os JIDs em ONI_STORY_VIEWERS (números separados por vírgula) — sem
// isso, só quem rodou o comando (a lista de contatos real precisa de app-state).
const storyViewers = (msg: IncomingMessage): string[] => {
  const env = (process.env.ONI_STORY_VIEWERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((n) => (n.includes("@") ? n : `${n.replace(/\D/g, "")}@s.whatsapp.net`));
  return env.length ? env : [msg.from];
};

const storysCmd = async (args: string, msg: IncomingMessage): Promise<string> => {
  const body = args.trim();
  if (!body) return "uso: !storys <texto>  |  !storys <url de img/vídeo> [legenda]";
  const viewers = storyViewers(msg);
  try {
    const first = body.split(/\s+/)[0] ?? "";
    if (!/^https?:\/\/\S+$/i.test(first)) {
      const r = await conn.postStatus(viewers, { text: body });
      console.log(`→ story de texto p/ ${r.sentTo} viewer(s)`);
      return `✅ story de texto postado (${r.sentTo} viewer(s))`;
    }
    const [url, ...rest] = body.split(/\s+/);
    const caption = rest.join(" ") || undefined;
    const { bytes, mime } = await grab(url!);
    const type = mime.startsWith("video/") ? "video" : "image";
    const r = await conn.postStatus(viewers, { media: bytes, type, caption });
    console.log(`→ story ${type} (${humanBytes(bytes.length)}) p/ ${r.sentTo} viewer(s)`);
    return `✅ story de ${type} postado (${r.sentTo} viewer(s))`;
  } catch (e) {
    return `erro no !storys: ${(e as Error).message}`;
  }
};
bot.register("storys", "posta nos stories: !storys <texto>  ou  !storys <url> [legenda]", storysCmd);
bot.register("story", "alias de !storys", storysCmd);
bot.register("stories", "alias de !storys", storysCmd);

bot.register("nome", "troca o nome do perfil do bot (!nome <texto>)", async (args) => {
  const name = args.trim();
  if (!name) return "uso: !nome <texto>";
  // O push name do WhatsApp MD é uma mutação de app-state (LT-hash), que a
  // oniwalib ainda não tem. Foto (!foto) e recado (!bio) são <iq> simples e
  // funcionam; o nome fica pra quando o app-state sync entrar.
  return "trocar o nome do perfil ainda não dá (precisa de app-state sync). use !bio e !foto por enquanto.";
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
