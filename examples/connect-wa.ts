// Conecta no WhatsApp de verdade: abre o WebSocket, roda o handshake Noise, e
// loga tudo que o servidor manda. Se o handshake fechar, aparece o
// `<iq><pair-device>` com os refs do QR.
//
//   bun examples/connect-wa.ts
//
// Precisa de `WebSocket` cliente com header `Origin` — bun tem, o RTS ainda
// não (issue #1). NÃO parear com uma conta que você não pode perder: cliente
// não-oficial é banível.

import { connectOni, readPairDevice, buildQrString } from "../src/connect";
import { memoryAuthState } from "../src/auth/state";
import { STOCK } from "../src/profiles/index";
import { node, getBinaryNodeChild, type BinaryNode } from "../src/frame/node";
import { utf8Decode } from "../src/frame/buffer";

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

const auth = memoryAuthState();
console.log("me conectando ao WhatsApp…  (regId", auth.creds.registrationId + ")");

const { socket, version } = await connectOni({ auth, profile: STOCK, countryCode: "BR" });
console.log(`handshake OK · versão ${version.join(".")} · estado ${socket.status}\n`);

let pairShown = false;

socket.events.on("node.recv", (n: BinaryNode) => {
  console.log("← " + preview(n));

  // fluxo QR: <iq type="set"><pair-device><ref>…</ref></pair-device></iq>
  const pd = readPairDevice(n);
  if (pd && pd.refs.length && !pairShown) {
    pairShown = true;
    // ack do iq
    if (n.attrs.id) {
      socket.sendNode(node("iq", { to: "s.whatsapp.net", type: "result", id: n.attrs.id }));
    }
    console.log("\n================  QR  ================");
    console.log(buildQrString(pd.refs[0]!, auth));
    console.log("=====================================");
    console.log("(cole isso num gerador de QR e escaneie no WhatsApp > Aparelhos conectados)\n");
  }
});

socket.events.on("connection.update", (u) => {
  if (u.connection === "close") {
    console.log("\nconexão fechada", u.lastDisconnect?.error?.message ?? "");
  }
});

// mantém aberto um tempo pra ver o que chega
await new Promise((r) => setTimeout(r, 18000));
socket.close();
console.log("fim.");
