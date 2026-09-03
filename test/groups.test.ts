// Camada de grupos (src/groups/index.ts): monta o <iq xmlns="w:g2"> e parseia
// o <group>. `query` é um dublê.

import { createGroupsLayer, extractGroupMetadata, handleGroupNotification } from "../src/groups";
import { getBinaryNodeChild, getBinaryNodeChildren, node, type BinaryNode } from "../src/frame/node";
import { utf8Encode, utf8Decode } from "../src/frame/buffer";
import { Emitter } from "../src/events/emitter";

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

// --- <notification type="w:gp2"> ---------------------------------
{
  const ev = new Emitter();
  const parts: any[] = [];
  const grpUp: any[] = [];
  ev.on("group-participants.update", (u) => parts.push(u));
  ev.on("groups.update", (u) => grpUp.push(u));
  let invalidated = "";
  const opts = { events: ev, onMembershipChange: (g: string) => (invalidated = g) };
  const X = "5511777777777@s.whatsapp.net";

  const h1 = handleGroupNotification(
    node("notification", { type: "w:gp2", from: GID, participant: OWNER }, [
      node("add", {}, [node("participant", { jid: X })]),
    ]),
    opts,
  );
  ok("add: handled=true", h1 === true);
  ok("add: group-participants.update action=add", parts[0]?.action === "add" && parts[0]?.participants?.[0] === X);
  ok("add: author = participant da stanza", parts[0]?.author === OWNER);
  ok("add: onMembershipChange chamado", invalidated === GID);

  invalidated = "";
  handleGroupNotification(
    node("notification", { type: "w:gp2", from: GID, participant: OWNER }, [
      node("promote", {}, [node("participant", { jid: X })]),
    ]),
    opts,
  );
  ok("promote: action=promote", parts[1]?.action === "promote");
  ok("promote: NÃO invalida device cache", invalidated === "");

  handleGroupNotification(
    node("notification", { type: "w:gp2", from: GID, participant: OWNER }, [
      node("subject", { subject: "Novo Nome", s_t: "1700000500" }),
    ]),
    opts,
  );
  const gu = grpUp[grpUp.length - 1]?.[0];
  ok("subject: groups.update {id, subject, subjectOwner}", gu?.id === GID && gu?.subject === "Novo Nome" && gu?.subjectOwner === OWNER);

  handleGroupNotification(
    node("notification", { type: "w:gp2", from: GID }, [node("announce", {})]),
    opts,
  );
  ok("announce: groups.update announce=true", grpUp[grpUp.length - 1]?.[0]?.announce === true);

  ok("from não-grupo → handled=false", handleGroupNotification(node("notification", { type: "w:gp2", from: OWNER }, [node("add", {})]), opts) === false);
}

// --- gestão de grupo: monta o stanza certo ---------------------
{
  const txt = (n: BinaryNode | undefined): string | undefined =>
    !n ? undefined : typeof n.content === "string" ? n.content : n.content instanceof Uint8Array ? utf8Decode(n.content) : undefined;

  // groupCreate
  reply = node("iq", { type: "result" }, [
    node("group", { id: "120363000000000050", subject: "Novo", creator: OWNER, size: "1" }, [
      node("participant", { jid: OWNER, type: "superadmin" }),
    ]),
  ]);
  const created = await groups.groupCreate("Novo", ["5511888888888@s.whatsapp.net", "5511777777777@s.whatsapp.net"]);
  ok("create: iq set / to @g.us", sent?.attrs.type === "set" && sent?.attrs.to === "@g.us" && sent?.attrs.xmlns === "w:g2");
  const cNode = getBinaryNodeChild(sent, "create");
  ok("create: <create subject key>", cNode?.attrs.subject === "Novo" && !!cNode?.attrs.key);
  ok("create: 2 <participant>", getBinaryNodeChildren(cNode, "participant").length === 2);
  ok("create: devolve metadata parseada", created.id === "120363000000000050@g.us" && created.subject === "Novo");

  // groupLeave
  reply = node("iq", { type: "result" });
  await groups.groupLeave(GID);
  ok("leave: to @g.us / <leave><group id>", sent?.attrs.to === "@g.us" && getBinaryNodeChild(getBinaryNodeChild(sent, "leave"), "group")?.attrs.id === GID);

  // groupUpdateSubject
  await groups.groupUpdateSubject(GID, "Assunto Novo");
  ok("subject: iq set to grupo", sent?.attrs.type === "set" && sent?.attrs.to === GID);
  ok("subject: conteúdo em bytes", txt(getBinaryNodeChild(sent, "subject")) === "Assunto Novo");

  // groupUpdateDescription (busca metadata p/ pegar o prev descId, depois seta)
  reply = node("iq", { type: "result" }, [
    node("group", { id: GID, subject: "x" }, [node("description", { id: "old-desc" }, [node("body", {}, utf8Encode("antiga"))])]),
  ]);
  await groups.groupUpdateDescription(GID, "descrição nova");
  const dNode = getBinaryNodeChild(sent, "description");
  ok("description: id novo + prev do metadata", !!dNode?.attrs.id && dNode?.attrs.prev === "old-desc");
  ok("description: <body> com o texto", txt(getBinaryNodeChild(dNode, "body")) === "descrição nova");

  await groups.groupUpdateDescription(GID);
  ok("description vazia: delete=true, sem body", getBinaryNodeChild(sent, "description")?.attrs.delete === "true" && !getBinaryNodeChild(getBinaryNodeChild(sent, "description"), "body"));

  // groupParticipantsUpdate
  reply = node("iq", { type: "result" }, [
    node("add", {}, [
      node("participant", { jid: "5511777777777@s.whatsapp.net" }),
      node("participant", { jid: "5511666666666@s.whatsapp.net", error: "403" }),
    ]),
  ]);
  const upd = await groups.groupParticipantsUpdate(GID, ["5511777777777@s.whatsapp.net", "5511666666666@s.whatsapp.net"], "add");
  ok("participantsUpdate: <add> com participantes", getBinaryNodeChild(sent, "add") && getBinaryNodeChildren(getBinaryNodeChild(sent, "add"), "participant").length === 2);
  ok("participantsUpdate: status 200 default", upd[0]?.status === "200" && upd[0]?.jid === "5511777777777@s.whatsapp.net");
  ok("participantsUpdate: status = error do server", upd[1]?.status === "403");

  // groupSettingUpdate
  reply = node("iq", { type: "result" });
  await groups.groupSettingUpdate(GID, "announcement");
  ok("settingUpdate: <announcement/>", !!getBinaryNodeChild(sent, "announcement"));

  // groupToggleEphemeral
  await groups.groupToggleEphemeral(GID, 604800);
  ok("ephemeral on: <ephemeral expiration>", getBinaryNodeChild(sent, "ephemeral")?.attrs.expiration === "604800");
  await groups.groupToggleEphemeral(GID, 0);
  ok("ephemeral off: <not_ephemeral/>", !!getBinaryNodeChild(sent, "not_ephemeral"));

  // groupJoinApprovalMode
  await groups.groupJoinApprovalMode(GID, "on");
  ok("joinApprovalMode: <membership_approval_mode><group_join state=on>", getBinaryNodeChild(getBinaryNodeChild(sent, "membership_approval_mode"), "group_join")?.attrs.state === "on");

  // groupMemberAddMode
  await groups.groupMemberAddMode(GID, "all_member_add");
  ok("memberAddMode: <member_add_mode>all_member_add", txt(getBinaryNodeChild(sent, "member_add_mode")) === "all_member_add");

  // groupInviteCode
  reply = node("iq", { type: "result" }, [node("invite", { code: "ABC123" })]);
  const code = await groups.groupInviteCode(GID);
  ok("inviteCode: iq get <invite/> → code", sent?.attrs.type === "get" && code === "ABC123");

  // groupRevokeInvite
  reply = node("iq", { type: "result" }, [node("invite", { code: "NEW999" })]);
  const rev = await groups.groupRevokeInvite(GID);
  ok("revokeInvite: iq set <invite/> → novo code", sent?.attrs.type === "set" && rev === "NEW999");

  // groupAcceptInvite
  reply = node("iq", { type: "result" }, [node("group", { jid: GID })]);
  const joined = await groups.groupAcceptInvite("ABC123");
  ok("acceptInvite: to @g.us set <invite code> → jid", sent?.attrs.to === "@g.us" && getBinaryNodeChild(sent, "invite")?.attrs.code === "ABC123" && joined === GID);

  // groupGetInviteInfo
  reply = node("iq", { type: "result" }, [node("group", { id: GID, subject: "Do Convite" })]);
  const info = await groups.groupGetInviteInfo("ABC123");
  ok("getInviteInfo: iq get <invite code> → metadata", sent?.attrs.type === "get" && info.subject === "Do Convite");

  // groupRequestParticipantsList
  reply = node("iq", { type: "result" }, [
    node("membership_approval_requests", {}, [
      node("membership_approval_request", { jid: "5511555555555@s.whatsapp.net", request_time: "1700000900" }),
    ]),
  ]);
  const reqs = await groups.groupRequestParticipantsList(GID);
  ok("requestList: <membership_approval_requests>", getBinaryNodeChild(sent, "membership_approval_requests") !== undefined && sent?.attrs.type === "get");
  ok("requestList: parseia jid do pedido", reqs[0]?.jid === "5511555555555@s.whatsapp.net");

  // groupRequestParticipantsUpdate
  reply = node("iq", { type: "result" }, [
    node("membership_requests_action", {}, [
      node("approve", {}, [node("participant", { jid: "5511555555555@s.whatsapp.net" })]),
    ]),
  ]);
  const ru = await groups.groupRequestParticipantsUpdate(GID, ["5511555555555@s.whatsapp.net"], "approve");
  ok("requestUpdate: <membership_requests_action mode=approve>", getBinaryNodeChild(sent, "membership_requests_action")?.attrs.mode === "approve");
  ok("requestUpdate: resultado por participante", ru[0]?.jid === "5511555555555@s.whatsapp.net" && ru[0]?.status === "200");
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
