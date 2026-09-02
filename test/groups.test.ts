// Camada de grupos (src/groups/index.ts): monta o <iq xmlns="w:g2"> e parseia
// o <group>. `query` é um dublê.

import { createGroupsLayer, extractGroupMetadata } from "../src/groups";
import { getBinaryNodeChild, node, type BinaryNode } from "../src/frame/node";
import { utf8Encode } from "../src/frame/buffer";

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

const GID = "120363000000000001@g.us";
const OWNER = "5511999999999@s.whatsapp.net";

let sent: BinaryNode | undefined;
let reply: BinaryNode;
const query = async (n: BinaryNode): Promise<BinaryNode> => {
  sent = n;
  return reply;
};
const groups = createGroupsLayer({ query });

// --- consulta monta o stanza certo -------------------------------
{
  reply = node("iq", { type: "result" }, [
    node("group", { id: "120363000000000001", subject: "Meu Grupo", s_o: OWNER, s_t: "1700000000", creation: "1699000000", creator: OWNER, size: "2" }, [
      node("participant", { jid: OWNER, type: "superadmin" }),
      node("participant", { jid: "5511888888888@s.whatsapp.net" }),
      node("description", { id: "d1", t: "1700000001" }, [node("body", {}, utf8Encode("regras aqui"))]),
    ]),
  ]);
  const m = await groups.groupMetadata(GID);
  ok("iq get / xmlns w:g2 / to = grupo", sent?.attrs.type === "get" && sent?.attrs.xmlns === "w:g2" && sent?.attrs.to === GID);
  ok("<query request=interactive>", getBinaryNodeChild(sent, "query")?.attrs.request === "interactive");

  ok("id normalizado com @g.us", m.id === GID);
  ok("subject", m.subject === "Meu Grupo");
  ok("subjectOwner normalizado", m.subjectOwner === OWNER);
  ok("subjectTime numérico", m.subjectTime === 1700000000);
  ok("creation", m.creation === 1699000000);
  ok("owner = creator", m.owner === OWNER);
  ok("size", m.size === 2);
  ok("desc do <description><body>", m.desc === "regras aqui");
  ok("descId", m.descId === "d1");
  ok("addressingMode default pn", m.addressingMode === "pn");
  ok("2 participantes", m.participants.length === 2);
  ok("participante superadmin", m.participants[0]?.jid === OWNER && m.participants[0]?.admin === "superadmin");
  ok("participante comum: admin undefined", m.participants[1]?.admin === undefined);
  ok("flags default false", m.announce === false && m.restrict === false && m.isCommunity === false);
}

// --- flags: announce / locked / approval / ephemeral / lid ---------
{
  reply = node("iq", { type: "result" }, [
    node("group", { id: GID, subject: "x", size: "0", addressing_mode: "lid" }, [
      node("announcement", {}),
      node("locked", {}),
      node("membership_approval_mode", {}),
      node("ephemeral", { expiration: "604800" }),
    ]),
  ]);
  const m = await groups.groupMetadata(GID);
  ok("announce", m.announce === true);
  ok("restrict (locked)", m.restrict === true);
  ok("joinApprovalMode", m.joinApprovalMode === true);
  ok("ephemeralDuration", m.ephemeralDuration === 604800);
  ok("addressingMode lid", m.addressingMode === "lid");
  ok("size cai na contagem de participantes (0)", m.size === 0);
}

// --- comunidade: <parent> / <linked_parent> ----------------------
{
  const parentMeta = extractGroupMetadata(
    node("iq", {}, [node("group", { id: GID, subject: "Comunidade" }, [node("parent", { default_membership_approval_mode: "request_required" })])]),
  );
  ok("isCommunity com <parent>", parentMeta.isCommunity === true);

  const subMeta = extractGroupMetadata(
    node("iq", {}, [
      node("group", { id: "120363000000000009", subject: "Subgrupo" }, [
        node("linked_parent", { jid: GID }),
        node("default_sub_group", {}),
      ]),
    ]),
  );
  ok("linkedParent = jid da comunidade", subMeta.linkedParent === GID);
  ok("isCommunityAnnounce com <default_sub_group>", subMeta.isCommunityAnnounce === true);
  ok("subgrupo não é isCommunity", subMeta.isCommunity === false);
}

// --- erro ------------------------------------------------------
{
  let threw = "";
  try {
    extractGroupMetadata(node("iq", { type: "error" }, [node("error", { code: "404", text: "group not found" })]));
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("resposta de erro lança com code+text", threw.includes("404") && threw.includes("group not found"), threw);
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/groups [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
