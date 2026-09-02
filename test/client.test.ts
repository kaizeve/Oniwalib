// openWhatsApp — o fluxo inteiro offline, contra o MockWaServer:
//
//   handshake → <iq><pair-device> (QR) → <pair-success> → resposta
//   <pair-device-sign> → <stream:error 515> → reconecta com payload de LOGIN
//   → <success> → connection "open".
//
// Top level, sem wrappers async (o RTS trava um `await` aninhado).

import { crypto } from "../src/crypto";
import { openWhatsApp } from "../src/client";
import { memoryAuthState } from "../src/auth/state";
import { mockTransportPair } from "../src/transport/mock";
import { MockWaServer } from "../src/transport/mock-wa-server";
import { node, getBinaryNodeChild } from "../src/frame/node";
import { Reader } from "../src/proto/wire";
import type { Transport } from "../src/transport/types";
import { makePairSuccess } from "./_pair-fixture";

const C = crypto();
let pass = 0;
let fail = 0;
const fails: string[] = [];
const ok = (n: string, c: boolean, d = "") => {
  if (c) pass++;
  else {
    fail++;
    fails.push(n + (d ? ` — ${d}` : ""));
  }
};

const auth = memoryAuthState();
const JID = "5511977776666:7@s.whatsapp.net";

let connectorCalls = 0;
let saveCredsCalls = 0;
let phase2Payload: Uint8Array | undefined;
let replySeen: ReturnType<typeof getBinaryNodeChild> | undefined;

const connector = (): Promise<Transport> => {
  const [clientT, serverT] = mockTransportPair();
  const call = ++connectorCalls;
  const server = new MockWaServer(serverT, C);

  if (call === 1) {
    server.onReady(() => {
      // 1) o servidor manda o <iq><pair-device> com os refs do QR
      server.pushNode(
        node("iq", { from: "@s.whatsapp.net", type: "set", id: "pd-1", xmlns: "md" }, [
          node("pair-device", {}, [node("ref", {}, "REF-A"), node("ref", {}, "REF-B")]),
        ]),
      );
      // 2) e o <pair-success> logo depois (como se o QR já tivesse sido escaneado)
      server.pushNode(makePairSuccess(auth.creds, C, { jid: JID, keyIndex: 1 }).stanza);
    });
    server.onReply((n) => {
      if (getBinaryNodeChild(n, "pair-device-sign")) {
        replySeen = n as never;
        // 3) restart pós-pareamento
        server.pushNode(node("stream:error", { code: "515" }));
      }
    });
  } else {
    server.onReady(() => {
      phase2Payload = server.clientPayload;
      server.pushNode(node("success", { lid: "111:7@lid" }));
    });
  }
  return Promise.resolve(clientT);
};

const conn = openWhatsApp({
  auth,
  connector,
  version: [2, 3000, 0],
  saveCreds: () => {
    saveCredsCalls++;
  },
  keepAliveMs: 60000,
});

let qr: string | undefined;
let isNewLogin = false;
let opened = false;
let closed = false;
conn.events.on("connection.update", (u) => {
  if (u.qr) qr = u.qr;
  if (u.isNewLogin) isNewLogin = true;
  if (u.connection === "open") opened = true;
  if (u.connection === "close") closed = true;
});

const deadline = Date.now() + 5000;
while (Date.now() < deadline && !(opened && isNewLogin)) {
  await new Promise((r) => setTimeout(r, 25));
}

ok("emitiu QR com o 1º ref", !!qr && qr.split(",")[0] === "REF-A", qr);
ok("QR = ref,noise,ident,adv (4 campos)", (qr ?? "").split(",").length === 4);
ok(
  "cliente respondeu <pair-device-sign><device-identity>",
  !!replySeen &&
    !!getBinaryNodeChild(getBinaryNodeChild(replySeen as never, "pair-device-sign"), "device-identity"),
);
ok("emitiu isNewLogin após o pareamento", isNewLogin);
ok("saveCreds chamado (>=1)", saveCredsCalls >= 1, String(saveCredsCalls));
ok("creds.registered persistido", auth.creds.registered === true);
ok("creds.me.id = jid do <device>", auth.creds.me?.id === JID);
ok("signalIdentities preenchido", (auth.creds.signalIdentities?.length ?? 0) === 1);
ok("reconectou: connector chamado 2x", connectorCalls === 2, String(connectorCalls));
ok("chegou a <success> → connection 'open'", opened);
ok("conn.state === 'open'", conn.state === "open");

if (phase2Payload) {
  const f = new Reader(phase2Payload).fields();
  ok("2ª conexão: payload de LOGIN tem username (campo 1)", f.has(1));
  ok("2ª conexão: payload de LOGIN sem regData (campo 19)", !f.has(19));
} else {
  ok("capturou o payload da 2ª conexão", false);
}

conn.end();
await new Promise((r) => setTimeout(r, 30));
ok("end() → state 'close' + connection.update close", conn.state === "close" && closed);

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/client [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
