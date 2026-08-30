// Igual ao connect-wa.ts, mas com estado PERSISTENTE (fileAuthState). Rode duas
// vezes: o `registrationId` no log é o MESMO na segunda — nada de re-registro,
// que é o que evita rate-limit / ban. As credenciais ficam cifradas em
// `./oni-auth/auth.owl`; a chave mestra em `./oni-auth/auth.owl.key` (0600) ou
// em `ONIWA_STORE_KEY` (hex/base64 de 32 bytes).
//
//   bun examples/connect-persist.ts
//
// NÃO parear com uma conta que você não pode perder: cliente não-oficial é
// banível.

import { connectOni, readPairDevice, buildQrString } from "../src/connect";
import { fileAuthState } from "../src/auth/file-state";
import { STOCK } from "../src/profiles/index";
import { node, type BinaryNode } from "../src/frame/node";

const AUTH_PATH = "./oni-auth/auth.owl";

function preview(n: BinaryNode, depth = 0): string {
  const pad = "  ".repeat(depth);
  const attrs = Object.entries(n.attrs)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  let line = `${pad}<${n.tag}${attrs ? " " + attrs : ""}>`;
  if (typeof n.content === "string") line += ` "${n.content.slice(0, 60)}"`;
  else if (n.content instanceof Uint8Array) line += ` [${n.content.length}B]`;
  else if (Array.isArray(n.content)) {
    line += "\n" + n.content.map((c) => preview(c, depth + 1)).join("\n");
  }
  return line;
}

const { state: auth, saveCreds } = fileAuthState(AUTH_PATH);
console.log(
  `estado em ${AUTH_PATH} · regId ${auth.creds.registrationId} · ` +
    (auth.creds.registered ? "já registrado" : "não registrado"),
);

const { socket, version } = await connectOni({ auth, profile: STOCK, countryCode: "BR" });
console.log(`handshake OK · versão ${version.join(".")} · estado ${socket.status}\n`);

let pairShown = false;

socket.events.on("node.recv", (n: BinaryNode) => {
  console.log("← " + preview(n));

  const pd = readPairDevice(n);
  if (pd && pd.refs.length && !pairShown) {
    pairShown = true;
    if (n.attrs.id) {
      socket.sendNode(node("iq", { to: "s.whatsapp.net", type: "result", id: n.attrs.id }));
    }
    console.log("\n================  QR  ================");
    console.log(buildQrString(pd.refs[0]!, auth));
    console.log("=====================================\n");
  }
});

socket.events.on("connection.update", (u) => {
  if (u.connection === "close") {
    console.log("\nconexão fechada", u.lastDisconnect?.error?.message ?? "");
  }
});

await new Promise((r) => setTimeout(r, 18000));
await saveCreds(); // grava qualquer mutação feita durante a sessão
socket.close();
console.log("fim. (rode de novo — regId igual, estado reaproveitado)");
