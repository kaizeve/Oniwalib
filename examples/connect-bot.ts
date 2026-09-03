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
  autoDownloadMedia: true, // mídia recebida já chega baixada em `messages.media`
});

conn.events.on("messages.media", ({ key, media, error }) => {
  if (error) {
    console.error(`✗ mídia de ${key.remoteJid} não baixou: ${error.message}`);
    return;
  }
  console.log(
    `📎 mídia de ${key.remoteJid}: ${media!.type} · ${media!.data.length} bytes` +
      (media!.mimetype ? ` · ${media!.mimetype}` : ""),
  );
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
// Quem vê: `conn.knownContacts()` — TODO mundo que já falou 1:1 com o bot, que a
// lib persiste cifrado no cofre (sobrevive a restart, sem consulta ao servidor).
// `ONI_STORY_VIEWERS` (números por vírgula) adiciona uma lista fixa por cima.
const isPerson = (j?: string): j is string =>
  !!j && (j.endsWith("@s.whatsapp.net") || j.endsWith("@lid"));
const storyViewers = async (msg: IncomingMessage): Promise<string[]> => {
  const env = (process.env.ONI_STORY_VIEWERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((n) => (n.includes("@") ? n : `${n.replace(/\D/g, "")}@s.whatsapp.net`));
  const known = await conn.knownContacts().catch(() => [] as string[]);
  // quem rodou o comando: em 1:1 é `from`, em grupo é `participant`
  const runner = isPerson(msg.from) ? msg.from : msg.participant;
  const all = new Set<string>([...env, ...known]);
  if (isPerson(runner)) all.add(runner);
  return [...all].filter(isPerson);
};

const storysCmd = async (args: string, msg: IncomingMessage): Promise<string> => {
  const body = args.trim();
  if (!body) return "uso: !storys <texto>  |  !storys <url de img/vídeo> [legenda]";
  const viewers = await storyViewers(msg);
  if (viewers.length === 0) {
    return "sem ninguém pra ver o story ainda — manda um oi pro bot numa DM primeiro, ou define ONI_STORY_VIEWERS";
  }
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
bot.register(
  "storys",
  "posta nos stories: !storys <texto> ou !storys <url> [legenda] (vê quem já falou com o bot ou ONI_STORY_VIEWERS)",
  storysCmd,
);
bot.register("story", "alias de !storys", storysCmd);
bot.register("stories", "alias de !storys", storysCmd);

bot.register("local", "manda um pino de localização: !local <lat> <lng> [nome]", async (args, msg) => {
  const [lat, lng, ...rest] = args.trim().split(/\s+/);
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return "uso: !local <lat> <lng> [nome]";
  await conn.sendLocation(msg.from, { latitude: la, longitude: ln, name: rest.join(" ") || undefined });
  return undefined;
});

bot.register("contato", "manda um cartão de contato: !contato <nome> <telefone>", async (args, msg) => {
  const m = args.trim().match(/^(.+?)\s+(\+?\d[\d\s-]{6,})$/);
  if (!m) return "uso: !contato <nome> <telefone>";
  await conn.sendContact(msg.from, { name: m[1]!.trim(), phone: m[2]!.replace(/[\s-]/g, "") });
  return undefined;
});

bot.register("nome", "troca o nome do perfil do bot (!nome <texto>)", async (args) => {
  const name = args.trim();
  if (!name) return "uso: !nome <texto>";
  if (!conn.appStateReady()) {
    return "ainda não recebi as chaves de app-state do celular. abre o WhatsApp no telefone uma vez e tenta de novo.";
  }
  try {
    await conn.updateProfileName(name);
    return `nome do perfil trocado pra "${name}".`;
  } catch (e) {
    return `não rolou: ${(e as Error).message}`;
  }
});

bot.register("sync", "força um resync de app-state (push name, mute/pin, contatos)", async () => {
  if (!conn.appStateReady()) return "sem chaves de app-state ainda (abre o zap no celular).";
  await conn.resyncAppState();
  return "resync disparado — olha os logs.";
});

// --- gestão de grupo (só funciona rodado DENTRO de um grupo) ---------------
const asGroup = (msg: IncomingMessage): string | undefined =>
  msg.from.endsWith("@g.us") ? msg.from : undefined;
// "5511999999999" | "+55 11 99999-9999" | "...@s.whatsapp.net" → jid
const toJids = (args: string): string[] =>
  args
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.includes("@") ? t : `${t.replace(/\D/g, "")}@s.whatsapp.net`))
    .filter((j) => /^\d{6,}@s\.whatsapp\.net$/.test(j));

const partCmd =
  (action: "add" | "remove" | "promote" | "demote") =>
  async (args: string, msg: IncomingMessage): Promise<string> => {
    const gid = asGroup(msg);
    if (!gid) return "esse comando é só dentro de um grupo.";
    const jids = toJids(args);
    if (!jids.length) return `uso: !${action} <número> [número...]`;
    try {
      const res = await conn.groupParticipantsUpdate(gid, jids, action);
      return res
        .map((r) => `${r.jid.split("@")[0]}: ${r.status === "200" ? "ok" : r.status}`)
        .join("\n");
    } catch (e) {
      return `falhou: ${(e as Error).message}`;
    }
  };

bot.register("add", "adiciona alguém ao grupo (!add <número>)", partCmd("add"));
bot.register("kick", "remove alguém do grupo (!kick <número>)", partCmd("remove"));
bot.register("ban", "alias de !kick", partCmd("remove"));
bot.register("promote", "vira admin (!promote <número>)", partCmd("promote"));
bot.register("demote", "tira o admin (!demote <número>)", partCmd("demote"));

bot.register("assunto", "troca o nome do grupo (!assunto <texto>)", async (args, msg) => {
  const gid = asGroup(msg);
  if (!gid) return "esse comando é só dentro de um grupo.";
  if (!args.trim()) return "uso: !assunto <texto>";
  await conn.groupUpdateSubject(gid, args.trim());
  return "assunto trocado.";
});

bot.register("descricao", "troca a descrição do grupo (!descricao <texto>, vazio apaga)", async (args, msg) => {
  const gid = asGroup(msg);
  if (!gid) return "esse comando é só dentro de um grupo.";
  await conn.groupUpdateDescription(gid, args.trim() || undefined);
  return args.trim() ? "descrição trocada." : "descrição apagada.";
});

bot.register("link", "link de convite do grupo", async (_args, msg) => {
  const gid = asGroup(msg);
  if (!gid) return "esse comando é só dentro de um grupo.";
  const code = await conn.groupInviteCode(gid);
  return code ? `https://chat.whatsapp.com/${code}` : "não consegui pegar o link (sou admin?).";
});

bot.register("revogar", "revoga o link de convite atual", async (_args, msg) => {
  const gid = asGroup(msg);
  if (!gid) return "esse comando é só dentro de um grupo.";
  const code = await conn.groupRevokeInvite(gid);
  return code ? `link novo: https://chat.whatsapp.com/${code}` : "não consegui revogar.";
});

bot.register("sair", "o bot sai do grupo", async (_args, msg) => {
  const gid = asGroup(msg);
  if (!gid) return "esse comando é só dentro de um grupo.";
  await conn.sendText(gid, "saindo, falou 👋");
  await conn.groupLeave(gid);
  return "";
});

bot.register("grupo", "mostra infos do grupo", async (_args, msg) => {
  const gid = asGroup(msg);
  if (!gid) return "esse comando é só dentro de um grupo.";
  const m = await conn.groupMetadata(gid);
  const admins = m.participants.filter((p) => p.admin).length;
  return [
    `📛 ${m.subject ?? "(sem nome)"}`,
    `👥 ${m.size} membros · ${admins} admins`,
    `📢 ${m.announce ? "só admin fala" : "todos falam"}`,
    `🔒 ${m.restrict ? "só admin edita infos" : "todos editam infos"}`,
    m.isCommunity ? "🏘️ é uma comunidade" : m.linkedParent ? "🏘️ subgrupo de comunidade" : "",
    m.desc ? `\n${m.desc}` : "",
  ]
    .filter(Boolean)
    .join("\n");
});

bot.register("block", "bloqueia um número (!block <número> — ou responde/roda numa DM)", async (args, msg) => {
  const alvo = toJids(args)[0] ?? (isPerson(msg.from) ? msg.from : undefined);
  if (!alvo) return "uso: !block <número>";
  await conn.updateBlockStatus(alvo, "block");
  return `🚫 ${alvo.split("@")[0]} bloqueado.`;
});
bot.register("unblock", "desbloqueia um número (!unblock <número>)", async (args, msg) => {
  const alvo = toJids(args)[0] ?? (isPerson(msg.from) ? msg.from : undefined);
  if (!alvo) return "uso: !unblock <número>";
  await conn.updateBlockStatus(alvo, "unblock");
  return `✅ ${alvo.split("@")[0]} desbloqueado.`;
});
bot.register("bloqueados", "lista os números bloqueados", async () => {
  const l = await conn.fetchBlocklist();
  return l.length ? l.map((j) => "• " + j.split("@")[0]).join("\n") : "ninguém bloqueado.";
});

// Enquetes: !enquete Pergunta | opção 1 | opção 2 [| opção 3 ...]
const polls = new Map<string, { options: string[]; key: Uint8Array; tally: Map<string, Set<string>> }>();
bot.register("enquete", "cria uma enquete: !enquete Pergunta | op1 | op2 | op3", async (args, msg) => {
  const parts = args.split("|").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return "uso: !enquete Pergunta | opção 1 | opção 2 [| ...]";
  const [pergunta, ...opts] = parts;
  const { id, pollEncKey } = await conn.sendPoll(msg.from, pergunta, opts);
  polls.set(id, { options: opts, key: pollEncKey, tally: new Map(opts.map((o) => [o, new Set<string>()])) });
  return "";
});
conn.events.on("poll.update", (evt) => {
  const p = polls.get(evt.pollCreationKey.id);
  if (!p) return;
  const picked = conn.readPollVote(evt, p.key, p.options) as string[];
  for (const set of p.tally.values()) set.delete(evt.voterJid); // último voto vale
  for (const opt of picked) p.tally.get(opt)?.add(evt.voterJid);
  const placar = [...p.tally.entries()].map(([o, s]) => `${o}: ${s.size}`).join(" · ");
  console.log(`🗳️  voto de ${evt.voterJid.split("@")[0]} → ${picked.join(", ") || "(limpou)"} | ${placar}`);
});

// Recusa chamadas automaticamente (ligue com ONI_REJECT_CALLS=1).
const rejectCalls = process.env.ONI_REJECT_CALLS === "1";
conn.events.on("call", (calls) => {
  for (const c of calls) {
    if (c.status !== "offer") continue;
    console.log(`📞 chamada ${c.isVideo ? "de vídeo " : ""}de ${c.from}${rejectCalls ? " — recusando" : ""}`);
    if (rejectCalls) conn.rejectCall(c.id, c.chatId);
  }
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
    // conversa 1:1 → esse contato pode ver os stories do bot. A lib já persiste
    // isso sozinha ao decifrar a stanza (`noteContact`); a chamada aqui é só
    // para o caso de a mensagem ter vindo por outro caminho.
    if (!inGroup && isPerson(from)) void conn.noteContact(from);
    console.log(`← ${inGroup ? `[grupo ${from}] ` : ""}${m.pushName ?? from}: ${text}`);

    // Grupo: respondemos com sender key (skmsg) + distribuição do NOSSO SKDM
    // 1:1 para quem já tem sessão pairwise com a gente. Quem nunca falou no
    // grupo desde que o bot subiu não recebe o SKDM e não vê a resposta —
    // USync/cold-send é a próxima fase.
    const incoming: IncomingMessage = {
      from,
      participant: m.key.participant,
      id: m.key.id,
      text,
      timestamp: m.messageTimestamp,
    };
    void bot.handle(incoming).then(async (reply) => {
      if (reply === undefined) return;
      // Um comando pode devolver uma lista (ex.: menu em texto + em botões).
      for (const r of Array.isArray(reply) ? reply : [reply]) {
        const t0 = Date.now();
        try {
          if (typeof r === "string")
            // se a resposta tem um link, manda com card de preview
            await conn.sendText(from, r, /https?:\/\//.test(r) ? { linkPreview: true } : undefined);
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
