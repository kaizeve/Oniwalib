// A minimal WhatsApp bot that runs on the RTS engine — `rts run examples/bot-rts.ts`
// (and, once you point it at a real auth store, `rts compile` → a native binary).
//
// The RTS pattern, vs bun/node's fire-and-forget `openWhatsApp`:
//
//   const conn = openWhatsApp({ auth, saveCreds });
//   await conn.start();          // <- run the connect chain in an awaited context
//   await conn.waitUntilClose(); // <- keep the process alive (rts run exits when
//                                //    the task queue drains and has no setInterval)
//
// It also skips the version fetch automatically on RTS (that `fetch` blocks the
// engine's loop and fails slowly). `oni-version.json` keeps the built-in fresh.
//
// Auth persists to `./oni-auth-rts.json` via `jsonFileAuthState` — plain
// read/write, no `stat`, so it works on RTS (unlike `fileAuthState`). Scan the
// QR once; later runs reconnect from the file.

import { openWhatsApp, jsonFileAuthState, messageText } from "../src/index";

const auth = jsonFileAuthState("./oni-auth-rts.json");

const conn = openWhatsApp({
  auth,
  saveCreds: () => auth.saveCreds(),
  markOnlineOnConnect: true,
});

conn.events.on("connection.update", (u) => {
  if (u.qr) {
    console.log("\nescaneie (WhatsApp > Aparelhos conectados > Conectar um aparelho):");
    console.log(u.qr, "\n"); // raw QR string — render it with any QR lib / site
  }
  if (u.connection === "open") console.log("🟢 conectado");
  if (u.connection === "close") console.log("🔴 fechou:", u.lastDisconnect?.error?.message ?? "");
});

conn.events.on("messages.upsert", async ({ type, messages }) => {
  if (type !== "notify") return;
  for (const m of messages) {
    if (m.key.fromMe || !m.message || !m.key.remoteJid) continue;
    const text = messageText(m.message as never).trim();
    if (text === "!ping") {
      await conn.sendText(m.key.remoteJid, "pong 🏓 (do RTS)");
    } else if (text === "!oni") {
      await conn.sendText(m.key.remoteJid, "rodando nativo no RTS 👹");
    }
  }
});

console.log("bot-rts: conectando…");
await conn.start();
console.log("bot-rts: handshake ok, no ar.");
await conn.waitUntilClose();
console.log("bot-rts: encerrado.");
