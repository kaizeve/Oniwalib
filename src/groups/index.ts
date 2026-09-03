// Camada de GRUPOS — metadata via `<iq xmlns="w:g2">`. Espelha `groupMetadata`
// / `extractGroupMetadata` do `@whiskeysockets/baileys` (`Socket/groups.js`).
//
//   <iq to="120xxx@g.us" type="get" xmlns="w:g2"><query request="interactive"/></iq>
//   → <group id subject s_o s_t creation creator size ...>
//       <participant jid type?="admin|superadmin"/> …
//       <description id t><body>texto</body></description>
//       <announcement/> <locked/>
//       <parent .../>            este grupo É a "announce group" de uma comunidade
//       <linked_parent jid/>     este grupo pertence a uma comunidade
//       <ephemeral expiration/>
//     </group>
//
// Distinguir grupo comum × comunidade: `isCommunity` (tem `<parent>`) /
// `linkedParent` (o jid da comunidade, quando este é um subgrupo).

import { getBinaryNodeChild, getBinaryNodeChildren, node, type BinaryNode } from "../frame/node";
import { utf8Decode, utf8Encode } from "../frame/buffer";
import { isJidGroup } from "../frame/jid";
import { jidNormalizedUser } from "../usync";
import type { Emitter } from "../events/emitter";

export interface GroupParticipant {
  jid: string;
  /** `undefined` = membro comum. */
  admin?: "admin" | "superadmin";
  /** Quando o grupo é lid-addressed, o `jid` é `@lid` e este é o número real
   *  (`553...@s.whatsapp.net`), como o servidor mandou no `<participant>`. */
  phoneNumber?: string;
  /** O contrário: grupo por número, mas o servidor anexou o `@lid` do membro. */
  lid?: string;
}

export interface GroupMetadata {
  id: string;
  subject?: string;
  subjectOwner?: string;
  subjectTime?: number;
  creation?: number;
  owner?: string;
  desc?: string;
  descId?: string;
  /** Endereçamento do grupo: `pn` (número) ou `lid` (oculto). */
  addressingMode: "pn" | "lid";
  /** Só admin manda mensagem. */
  announce: boolean;
  /** Só admin edita as infos do grupo. */
  restrict: boolean;
  /** Entrar precisa de aprovação de admin. */
  joinApprovalMode: boolean;
  /** Este jid É a "announce group" de uma comunidade. */
  isCommunity: boolean;
  /** Este é o subgrupo default de uma comunidade. */
  isCommunityAnnounce: boolean;
  /** jid da comunidade a que este grupo pertence (se for subgrupo). */
  linkedParent?: string;
  size: number;
  ephemeralDuration?: number;
  participants: GroupParticipant[];
}

export interface GroupsLayerOptions {
  query: (n: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>;
  /** Gera um id curto (o mesmo `genId` do socket). Opcional — só é usado para o
   *  `key` do `<create>` e o `id` do `<description>`; sem ele cai num contador. */
  genId?: () => string;
}

/** Resultado de um add/remove/promote/demote por participante. `status` é o
 *  código do servidor: `"200"` OK, `"403"` sem permissão, `"408"` fora do zap,
 *  `"409"` já é membro, `"401"` te bloqueou… `content` é o `<participant>` cru
 *  (às vezes traz um `<add_request>` com o código de convite). */
export interface ParticipantUpdateResult {
  jid: string;
  status: string;
  content: BinaryNode;
}

export type GroupParticipantAction = "add" | "remove" | "promote" | "demote";
export type GroupSetting =
  | "announcement"
  | "not_announcement"
  | "locked"
  | "unlocked";

export interface GroupsLayer {
  /** Metadata completa de um grupo/comunidade. */
  groupMetadata(jid: string): Promise<GroupMetadata>;
  /** Só a lista de participantes (atalho de `groupMetadata`). */
  groupParticipants(jid: string): Promise<GroupParticipant[]>;
  /** Cria um grupo. `participants` são os números a adicionar de cara. */
  groupCreate(subject: string, participants: string[]): Promise<GroupMetadata>;
  /** Sai de um grupo. */
  groupLeave(jid: string): Promise<void>;
  /** Troca o assunto (nome) do grupo. */
  groupUpdateSubject(jid: string, subject: string): Promise<void>;
  /** Troca a descrição. String vazia / `undefined` apaga a descrição. */
  groupUpdateDescription(jid: string, description?: string): Promise<void>;
  /** add/remove/promote/demote em lote. Devolve um resultado por participante. */
  groupParticipantsUpdate(
    jid: string,
    participants: string[],
    action: GroupParticipantAction,
  ): Promise<ParticipantUpdateResult[]>;
  /** `announcement` = só admin fala · `locked` = só admin edita infos (e os
   *  respectivos `not_`/`unlocked`). */
  groupSettingUpdate(jid: string, setting: GroupSetting): Promise<void>;
  /** Liga/desliga mensagens temporárias. `0` desliga; senão segundos
   *  (86400 / 604800 / 7776000). */
  groupToggleEphemeral(jid: string, expirationSeconds: number): Promise<void>;
  /** Entrar no grupo precisa de aprovação de admin? `"on"` / `"off"`. */
  groupJoinApprovalMode(jid: string, mode: "on" | "off"): Promise<void>;
  /** Quem pode adicionar membro: todos ou só admin. */
  groupMemberAddMode(
    jid: string,
    mode: "all_member_add" | "admin_add",
  ): Promise<void>;
  /** Código de convite atual (`chat.whatsapp.com/<code>`). */
  groupInviteCode(jid: string): Promise<string | undefined>;
  /** Revoga o convite e devolve o novo código. */
  groupRevokeInvite(jid: string): Promise<string | undefined>;
  /** Entra num grupo por código de convite. Devolve o jid do grupo. */
  groupAcceptInvite(code: string): Promise<string | undefined>;
  /** Metadata de um grupo a partir do código de convite (sem entrar). */
  groupGetInviteInfo(code: string): Promise<GroupMetadata>;
  /** Lista quem pediu para entrar (com `joinApprovalMode` ligado). */
  groupRequestParticipantsList(jid: string): Promise<Array<Record<string, string>>>;
  /** Aprova/rejeita pedidos de entrada em lote. */
  groupRequestParticipantsUpdate(
    jid: string,
    participants: string[],
    action: "approve" | "reject",
  ): Promise<ParticipantUpdateResult[]>;
}

function textOf(n: BinaryNode | undefined): string | undefined {
  if (!n) return undefined;
  if (typeof n.content === "string") return n.content;
  if (n.content instanceof Uint8Array) return utf8Decode(n.content);
  return undefined;
}
function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function extractGroupMetadata(iqResult: BinaryNode): GroupMetadata {
  const group = getBinaryNodeChild(iqResult, "group");
  if (!group) {
    const err = getBinaryNodeChild(iqResult, "error");
    throw new Error(
      err
        ? `groupMetadata: ${err.attrs.code ?? ""} ${err.attrs.text ?? "erro"}`.trim()
        : "groupMetadata: resposta sem <group>",
    );
  }
  const a = group.attrs;
  if (!a.id) throw new Error("groupMetadata: <group> sem id");
  const id = a.id.includes("@") ? a.id : `${a.id}@g.us`;

  const descChild = getBinaryNodeChild(group, "description");
  const participants: GroupParticipant[] = getBinaryNodeChildren(group, "participant").map((p) => ({
    jid: p.attrs.jid!,
    admin:
      p.attrs.type === "admin" || p.attrs.type === "superadmin"
        ? (p.attrs.type as "admin" | "superadmin")
        : undefined,
    phoneNumber: p.attrs.phone_number || undefined,
    lid: p.attrs.lid || undefined,
  }));

  return {
    id,
    subject: a.subject,
    subjectOwner: a.s_o ? jidNormalizedUser(a.s_o) : undefined,
    subjectTime: num(a.s_t),
    creation: num(a.creation),
    owner: a.creator ? jidNormalizedUser(a.creator) : undefined,
    desc: textOf(getBinaryNodeChild(descChild, "body")),
    descId: descChild?.attrs.id,
    addressingMode: a.addressing_mode === "lid" ? "lid" : "pn",
    announce: !!getBinaryNodeChild(group, "announcement"),
    restrict: !!getBinaryNodeChild(group, "locked"),
    joinApprovalMode: !!getBinaryNodeChild(group, "membership_approval_mode"),
    isCommunity: !!getBinaryNodeChild(group, "parent"),
    isCommunityAnnounce: !!getBinaryNodeChild(group, "default_sub_group"),
    linkedParent: getBinaryNodeChild(group, "linked_parent")?.attrs.jid || undefined,
    size: num(a.size) ?? participants.length,
    ephemeralDuration: num(getBinaryNodeChild(group, "ephemeral")?.attrs.expiration),
    participants,
  };
}

// --- <notification type="w:gp2"> → groups.update / group-participants.update ---

const PARTICIPANT_ACTIONS = {
  add: "add",
  remove: "remove",
  promote: "promote",
  demote: "demote",
} as const;

export interface GroupNotificationOptions {
  events: Emitter;
  /** Chamado quando a composição do grupo muda (add/remove/promote/demote),
   *  para invalidar caches de device-list / SKDM. */
  onMembershipChange?: (groupJid: string) => void;
}

/** Trata um `<notification type="w:gp2">` de um grupo. Devolve `true` se
 *  reconheceu algo. Espelha `handleGroupNotification` da Baileys, no mínimo:
 *  add/remove/promote/demote de participante, e mudança de subject / descrição /
 *  announce / locked / ephemeral. */
export function handleGroupNotification(
  stanza: BinaryNode,
  o: GroupNotificationOptions,
): boolean {
  const from = stanza.attrs.from;
  if (!from || !isJidGroup(from)) return false;
  const author = stanza.attrs.participant;
  const children = Array.isArray(stanza.content) ? stanza.content : [];
  let handled = false;
  const meta: { id: string } & Record<string, unknown> = { id: from };

  for (const child of children) {
    const tag = child.tag;
    if (tag in PARTICIPANT_ACTIONS) {
      const participants = getBinaryNodeChildren(child, "participant")
        .map((p) => p.attrs.jid)
        .filter((j): j is string => !!j);
      o.events.emit("group-participants.update", {
        id: from,
        author,
        participants,
        action: PARTICIPANT_ACTIONS[tag as keyof typeof PARTICIPANT_ACTIONS],
      });
      if (tag === "add" || tag === "remove") o.onMembershipChange?.(from);
      handled = true;
    } else if (tag === "subject") {
      meta.subject = child.attrs.subject;
      meta.subjectTime = num(child.attrs.s_t);
      meta.subjectOwner = author;
      handled = true;
    } else if (tag === "description") {
      meta.desc = textOf(getBinaryNodeChild(child, "body"));
      meta.descId = child.attrs.id;
      handled = true;
    } else if (tag === "announce" || tag === "not_announce") {
      meta.announce = tag === "announce";
      handled = true;
    } else if (tag === "locked" || tag === "unlocked") {
      meta.restrict = tag === "locked";
      handled = true;
    } else if (tag === "ephemeral" || tag === "not_ephemeral") {
      meta.ephemeralDuration = tag === "ephemeral" ? num(child.attrs.expiration) ?? 0 : 0;
      handled = true;
    } else if (tag === "create") {
      const g = getBinaryNodeChild(child, "group");
      if (g) {
        try {
          o.events.emit("groups.update", [extractGroupMetadata(child) as unknown as { id: string }]);
          handled = true;
        } catch {
          /* create malformado — ignora */
        }
      }
    }
  }

  if (Object.keys(meta).length > 1) o.events.emit("groups.update", [meta]);
  return handled;
}

const PARTICIPANTS_GROUP = "@g.us";

export function createGroupsLayer(o: GroupsLayerOptions): GroupsLayer {
  const { query } = o;
  let seq = 0;
  const genId = o.genId ?? (() => `g${Date.now().toString(36)}${(seq++).toString(36)}`);

  // `<iq type xmlns="w:g2" to=…>content</iq>` — o verbo comum da Baileys.
  function groupQuery(
    jid: string,
    type: "get" | "set",
    content: BinaryNode[],
  ): Promise<BinaryNode> {
    return query(node("iq", { to: jid, type, xmlns: "w:g2" }, content));
  }

  function participantNodes(jids: string[]): BinaryNode[] {
    return jids.map((jid) => node("participant", { jid }));
  }

  // `<add|remove|…><participant jid error?/></…>` → um resultado por jid.
  function parseParticipantResults(
    res: BinaryNode,
    tag: string,
  ): ParticipantUpdateResult[] {
    const wrap = getBinaryNodeChild(res, tag);
    return getBinaryNodeChildren(wrap, "participant").map((p) => ({
      jid: p.attrs.jid!,
      status: p.attrs.error ?? "200",
      content: p,
    }));
  }

  async function groupMetadata(jid: string): Promise<GroupMetadata> {
    const res = await groupQuery(jid, "get", [node("query", { request: "interactive" })]);
    return extractGroupMetadata(res);
  }

  async function groupParticipants(jid: string): Promise<GroupParticipant[]> {
    return (await groupMetadata(jid)).participants;
  }

  async function groupCreate(
    subject: string,
    participants: string[],
  ): Promise<GroupMetadata> {
    const res = await groupQuery(PARTICIPANTS_GROUP, "set", [
      node("create", { subject, key: genId() }, participantNodes(participants)),
    ]);
    return extractGroupMetadata(res);
  }

  async function groupLeave(jid: string): Promise<void> {
    await groupQuery(PARTICIPANTS_GROUP, "set", [
      node("leave", {}, [node("group", { id: jid })]),
    ]);
  }

  async function groupUpdateSubject(jid: string, subject: string): Promise<void> {
    await groupQuery(jid, "set", [node("subject", {}, utf8Encode(subject))]);
  }

  async function groupUpdateDescription(
    jid: string,
    description?: string,
  ): Promise<void> {
    const prev = (await groupMetadata(jid)).descId;
    const attrs: Record<string, string> = description
      ? { id: genId() }
      : { delete: "true" };
    if (prev) attrs.prev = prev;
    await groupQuery(jid, "set", [
      node(
        "description",
        attrs,
        description ? [node("body", {}, utf8Encode(description))] : undefined,
      ),
    ]);
  }

  async function groupParticipantsUpdate(
    jid: string,
    participants: string[],
    action: GroupParticipantAction,
  ): Promise<ParticipantUpdateResult[]> {
    const res = await groupQuery(jid, "set", [
      node(action, {}, participantNodes(participants)),
    ]);
    return parseParticipantResults(res, action);
  }

  async function groupSettingUpdate(
    jid: string,
    setting: GroupSetting,
  ): Promise<void> {
    await groupQuery(jid, "set", [node(setting, {})]);
  }

  async function groupToggleEphemeral(
    jid: string,
    expirationSeconds: number,
  ): Promise<void> {
    await groupQuery(jid, "set", [
      expirationSeconds
        ? node("ephemeral", { expiration: String(expirationSeconds) })
        : node("not_ephemeral", {}),
    ]);
  }

  async function groupJoinApprovalMode(
    jid: string,
    mode: "on" | "off",
  ): Promise<void> {
    await groupQuery(jid, "set", [
      node("membership_approval_mode", {}, [node("group_join", { state: mode })]),
    ]);
  }

  async function groupMemberAddMode(
    jid: string,
    mode: "all_member_add" | "admin_add",
  ): Promise<void> {
    await groupQuery(jid, "set", [node("member_add_mode", {}, utf8Encode(mode))]);
  }

  async function groupInviteCode(jid: string): Promise<string | undefined> {
    const res = await groupQuery(jid, "get", [node("invite", {})]);
    return getBinaryNodeChild(res, "invite")?.attrs.code;
  }

  async function groupRevokeInvite(jid: string): Promise<string | undefined> {
    const res = await groupQuery(jid, "set", [node("invite", {})]);
    return getBinaryNodeChild(res, "invite")?.attrs.code;
  }

  async function groupAcceptInvite(code: string): Promise<string | undefined> {
    const res = await groupQuery(PARTICIPANTS_GROUP, "set", [node("invite", { code })]);
    return getBinaryNodeChild(res, "group")?.attrs.jid;
  }

  async function groupGetInviteInfo(code: string): Promise<GroupMetadata> {
    const res = await groupQuery(PARTICIPANTS_GROUP, "get", [node("invite", { code })]);
    return extractGroupMetadata(res);
  }

  async function groupRequestParticipantsList(
    jid: string,
  ): Promise<Array<Record<string, string>>> {
    const res = await groupQuery(jid, "get", [
      node("membership_approval_requests", {}),
    ]);
    const wrap = getBinaryNodeChild(res, "membership_approval_requests");
    return getBinaryNodeChildren(wrap, "membership_approval_request").map(
      (p) => ({ ...p.attrs }),
    );
  }

  async function groupRequestParticipantsUpdate(
    jid: string,
    participants: string[],
    action: "approve" | "reject",
  ): Promise<ParticipantUpdateResult[]> {
    const res = await groupQuery(jid, "set", [
      node(
        "membership_requests_action",
        { mode: action },
        participantNodes(participants),
      ),
    ]);
    const wrap = getBinaryNodeChild(res, "membership_requests_action");
    const inner = getBinaryNodeChild(wrap, action);
    return getBinaryNodeChildren(inner, "participant").map((p) => ({
      jid: p.attrs.jid!,
      status: p.attrs.error ?? "200",
      content: p,
    }));
  }

  return {
    groupMetadata,
    groupParticipants,
    groupCreate,
    groupLeave,
    groupUpdateSubject,
    groupUpdateDescription,
    groupParticipantsUpdate,
    groupSettingUpdate,
    groupToggleEphemeral,
    groupJoinApprovalMode,
    groupMemberAddMode,
    groupInviteCode,
    groupRevokeInvite,
    groupAcceptInvite,
    groupGetInviteInfo,
    groupRequestParticipantsList,
    groupRequestParticipantsUpdate,
  };
}
