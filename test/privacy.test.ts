// Camada de privacidade (src/privacy/index.ts): monta os <iq xmlns="privacy">
// de leitura e alteração e parseia as `<category>`. `query` é um dublê que
// captura o node e devolve uma resposta controlada.

import { createPrivacyLayer } from "../src/privacy";
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
const privacy = createPrivacyLayer({ query });

const cats = (...kv: [string, string][]): BinaryNode[] =>
  kv.map(([name, value]) => node("category", { name, value }));

// --- fetch: <privacy> plano -------------------------------------------
{
  reply = node("iq", { type: "result", id: "1" }, [
    node("privacy", {}, cats(["readreceipts", "all"], ["last", "contacts"], ["online", "all"])),
  ]);
  const s = await privacy.fetchPrivacySettings();
  ok("fetch: iq get / xmlns privacy / to s.whatsapp.net",
    sent?.attrs.type === "get" && sent?.attrs.xmlns === "privacy" && sent?.attrs.to === "@s.whatsapp.net");
  ok("fetch: manda um <privacy/> vazio", !!getBinaryNodeChild(sent, "privacy"));
  ok("fetch: readreceipts=all", s.readreceipts === "all");
  ok("fetch: last=contacts", s.last === "contacts");
  ok("fetch: online=all", s.online === "all");
}

// --- fetch: <privacy><privacy> aninhado ------------------------------
{
  reply = node("iq", { type: "result", id: "1" }, [
    node("privacy", {}, [node("privacy", {}, cats(["profile", "contacts"], ["groupadd", "contact_blacklist"]))]),
  ]);
  const s = await privacy.fetchPrivacySettings();
  ok("fetch aninhado: profile=contacts", s.profile === "contacts");
  ok("fetch aninhado: groupadd=contact_blacklist", s.groupadd === "contact_blacklist");
}

// --- update: manda a <category> e reflete a resposta ----------------
{
  sent = undefined;
  reply = node("iq", { type: "result", id: "1" }, [
    node("privacy", {}, cats(["readreceipts", "none"])),
  ]);
  const s = await privacy.updatePrivacySetting("readreceipts", "none");
  ok("update: iq set / xmlns privacy", sent?.attrs.type === "set" && sent?.attrs.xmlns === "privacy");
  const c = getBinaryNodeChildren(getBinaryNodeChild(sent, "privacy"), "category")[0];
  ok("update: <category name=readreceipts value=none>", c?.attrs.name === "readreceipts" && c?.attrs.value === "none");
  ok("update: devolve o valor novo", s.readreceipts === "none");
}

// --- update: <iq type=result> vazio → reflete o pedido -------------
{
  reply = node("iq", { type: "result", id: "1" });
  const s = await privacy.updatePrivacySetting("last", "none");
  ok("update sem eco: cai no valor pedido", s.last === "none");
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/privacy [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
