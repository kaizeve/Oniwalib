// One-shot app-state / history live check. Fresh pairing, in a NON-pm2 process
// (no watch, no restart to eat the one-time key share). Scan the QR, then it
// waits ~90s for: the app-state sync keys, a clean resync (no MAC error), and a
// history-sync chunk. Prints a verdict and exits.
//
//   node scripts/appstate-probe.mjs
//
// Uses a throwaway auth (`./oni-auth-probe.json`) so it never touches oni-bot.

import { openWhatsApp, jsonFileAuthState } from "../src/index.ts";
let qrRender;
try { qrRender = (await import("qrcode-terminal")).default; } catch { qrRender = null; }

const auth = jsonFileAuthState("./oni-auth-probe.json");
const conn = openWhatsApp({ auth, saveCreds: () => auth.saveCreds() });

const seen = { keys: false, resyncOk: false, resyncErr: "", history: 0, historyMsgs: 0, pushName: false };
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

conn.events.on("connection.update", (u) => {
  if (u.qr) {
    console.log(`\n[${stamp()}] escaneie (WhatsApp > Aparelhos conectados > Conectar um aparelho):\n`);
    if (qrRender) qrRender.generate(u.qr, { small: true });
    else console.log(u.qr, "\n");
  }
  if (u.connection === "open") console.log(`[${stamp()}] 🟢 conectado — aguardando as chaves de app-state…`);
  if (u.connection === "close") console.log(`[${stamp()}] 🔴 fechou: ${u.lastDisconnect?.error?.message ?? "?"}`);
});

conn.events.on("creds.update", (c) => {
  if ("myAppStateKeyId" in c) {
    seen.keys = true;
    console.log(`[${stamp()}] 🔑 chaves de app-state guardadas (myAppStateKeyId=${String(c.myAppStateKeyId).slice(0, 12)}…)`);
    // força um resync agora que temos chave
    conn.resyncAppState().then(
      () => { seen.resyncOk = true; console.log(`[${stamp()}] ✅ resync sem erro`); },
      (e) => { seen.resyncErr = e?.message ?? String(e); console.log(`[${stamp()}] ❌ resync falhou: ${seen.resyncErr}`); },
    );
  }
  if (c.me && typeof c.me === "object" && "name" in c.me && c.me.name) {
    seen.pushName = true;
    console.log(`[${stamp()}] 📛 push name sincronizado: "${c.me.name}"`);
  }
});

conn.events.on("messaging-history.set", (h) => {
  seen.history += 1;
  seen.historyMsgs += h.messages?.length ?? 0;
  console.log(`[${stamp()}] 📚 history ${h.syncType ?? "?"} — ${h.chats.length} chat(s), ${h.messages?.length ?? 0} msg(s), progress ${h.progress ?? "?"}`);
});
conn.events.on("chats.update", (c) => console.log(`[${stamp()}] 💬 chats.update: ${JSON.stringify(c).slice(0, 160)}`));
conn.events.on("contacts.upsert", (c) => console.log(`[${stamp()}] 👤 contacts.upsert × ${c.length}`));

console.log("appstate-probe: conectando… (Ctrl-C para abortar)");
await conn.start();

// espera até 100s ou até termos o essencial
const deadline = Date.now() + 100_000;
while (Date.now() < deadline && !(seen.keys && (seen.resyncOk || seen.resyncErr) && seen.history)) {
  await new Promise((r) => setTimeout(r, 1000));
}

console.log("\n──────── VEREDITO ────────");
console.log(`chaves de app-state ......... ${seen.keys ? "✅ recebidas" : "❌ NÃO vieram"}`);
console.log(`resync ..................... ${seen.resyncOk ? "✅ limpo (MAC ok)" : seen.resyncErr ? "❌ " + seen.resyncErr : "— não rodou"}`);
console.log(`push name .................. ${seen.pushName ? "✅ sincronizado" : "—"}`);
console.log(`history sync ............... ${seen.history ? `✅ ${seen.history} chunk(s), ${seen.historyMsgs} msg(s)` : "❌ nenhum chunk"}`);
const pass = seen.keys && seen.resyncOk && seen.history;
console.log(`\n${pass ? "🎉 APP-STATE + HISTORY VALIDADOS AO VIVO" : "⚠️  incompleto — ver acima"}`);

conn.end();
setTimeout(() => process.exit(pass ? 0 : 1), 500);
