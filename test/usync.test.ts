// Camada USYNC (src/usync/index.ts): monta o <iq xmlns="usync"> de device list
// e parseia a resposta. `query` é um dublê que captura o node enviado e devolve
// uma resposta controlada.

import { createUSyncLayer, jidNormalizedUser } from "../src/usync";
import { crypto } from "../src/crypto";
import { getBinaryNodeChild, getBinaryNodeChildren, node, type BinaryNode } from "../src/frame/node";

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

let sent: BinaryNode | undefined;
let reply: BinaryNode = node("iq", { type: "result", id: "1" });
const query = async (n: BinaryNode): Promise<BinaryNode> => {
  sent = n;
  return reply;
};
const usync = createUSyncLayer({ query, crypto: crypto() });

const A = "5511999999999@s.whatsapp.net";
const B = "5511888888888@s.whatsapp.net";

const userResult = (jid: string, ids: number[]): BinaryNode =>
  node("user", { jid }, [
    node("devices", {}, [
      node(
        "device-list",
        {},
        ids.map((id) => node("device", { id: String(id) })),
      ),
    ]),
  ]);

// --- normalização ---------------------------------------------------
ok("normaliza device/agent fora do jid", jidNormalizedUser("5511999999999:3@s.whatsapp.net") === A);
ok("normaliza c.us → s.whatsapp.net", jidNormalizedUser("5511999999999@c.us") === A);
ok("jid já normalizado passa igual", jidNormalizedUser(A) === A);

// --- consulta: monta o stanza certo -------------------------------
{
  reply = node("iq", { type: "result", id: "1" }, [
    node("usync", {}, [node("list", {}, [userResult(A, [0, 23]), userResult(B, [0])])]),
  ]);
  const map = await usync.getDeviceList([A, "5511999999999:3@s.whatsapp.net", B]);

  ok("iq get / xmlns usync / to s.whatsapp.net",
    sent?.attrs.type === "get" && sent?.attrs.xmlns === "usync" && sent?.attrs.to === "@s.whatsapp.net");
  const us = getBinaryNodeChild(sent, "usync");
  ok("usync mode=query context=message last=true", us?.attrs.mode === "query" && us?.attrs.context === "message" && us?.attrs.last === "true");
  ok("usync tem sid", typeof us?.attrs.sid === "string" && (us!.attrs.sid as string).length >= 8);
  ok("<query><devices version=2>", getBinaryNodeChild(getBinaryNodeChild(us, "query"), "devices")?.attrs.version === "2");
  const listUsers = getBinaryNodeChildren(getBinaryNodeChild(us, "list"), "user");
  ok("dedup: 2 <user> (A e B, não 3)", listUsers.length === 2);
  ok("<user jid> normalizado", listUsers[0]?.attrs.jid === A && listUsers[1]?.attrs.jid === B);

  ok("parse: A → [0, 23]", JSON.stringify(map[A]) === "[0,23]");
  ok("parse: B → [0]", JSON.stringify(map[B]) === "[0]");
}

// --- respostas sem devices / fora de ordem -----------------------
{
  reply = node("iq", { type: "result", id: "1" }, [
    node("usync", {}, [
      node("list", {}, [
        node("user", { jid: A }, [node("devices", {}, [node("device-list", {}, [
          node("device", { id: "23" }),
          node("device", { id: "0" }),
          node("device", { id: "5" }),
        ])])]),
        node("user", { jid: B }, [node("error", { code: "480", text: "not on whatsapp" })]),
      ]),
    ]),
  ]);
  const map = await usync.getDeviceList([A, B]);
  ok("device ids saem ordenados", JSON.stringify(map[A]) === "[0,5,23]");
  ok("user com <error> → []", JSON.stringify(map[B]) === "[]");
}

// --- lista vazia -------------------------------------------------
{
  sent = undefined;
  const map = await usync.getDeviceList([]);
  ok("jids=[] não faz query", sent === undefined);
  ok("jids=[] → {}", JSON.stringify(map) === "{}");
}

// --- onWhatsApp ------------------------------------------------------------
{
  reply = node("iq", { type: "result", id: "1" }, [
    node("usync", {}, [
      node("list", {}, [
        node("user", { jid: A }, [node("contact", { type: "in" })]),
        node("user", {}, [node("contact", { type: "out" })]),
      ]),
    ]),
  ]);
  sent = undefined;
  const r = await usync.onWhatsApp(["+55 11 99999-9999", "5511777770000"]);
  const q = getBinaryNodeChild(getBinaryNodeChild(sent, "usync"), "query");
  ok("onWhatsApp: <query><contact/>", !!getBinaryNodeChild(q, "contact"));
  const firstContact = getBinaryNodeChildren(
    getBinaryNodeChild(getBinaryNodeChild(sent, "usync"), "list"),
    "user",
  )[0];
  ok("onWhatsApp: <contact> com + na frente", getBinaryNodeChild(firstContact, "contact")?.content === "+5511999999999");
  ok("onWhatsApp: 1 por entrada, na ordem", r.length === 2 && r[0]?.input === "+55 11 99999-9999");
  ok("onWhatsApp: existe → jid canônico", r[0]?.exists === true && r[0]?.jid === A);
  ok("onWhatsApp: não existe", r[1]?.exists === false && r[1]?.jid === undefined);
  reply = node("iq", { type: "result", id: "1" });
}
{
  sent = undefined;
  const r = await usync.onWhatsApp([]);
  ok("onWhatsApp: []  não faz query", sent === undefined && r.length === 0);
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/usync [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
