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
import { utf8Decode } from "../frame/buffer";
import { jidNormalizedUser } from "../usync";

export interface GroupParticipant {
  jid: string;
  /** `undefined` = membro comum. */
  admin?: "admin" | "superadmin";
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
}

export interface GroupsLayer {
  /** Metadata completa de um grupo/comunidade. */
  groupMetadata(jid: string): Promise<GroupMetadata>;
  /** Só a lista de participantes (atalho de `groupMetadata`). */
  groupParticipants(jid: string): Promise<GroupParticipant[]>;
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

export function createGroupsLayer(o: GroupsLayerOptions): GroupsLayer {
  const { query } = o;

  async function groupMetadata(jid: string): Promise<GroupMetadata> {
    const res = await query(
      node("iq", { to: jid, type: "get", xmlns: "w:g2" }, [
        node("query", { request: "interactive" }),
      ]),
    );
    return extractGroupMetadata(res);
  }

  async function groupParticipants(jid: string): Promise<GroupParticipant[]> {
    return (await groupMetadata(jid)).participants;
  }

  return { groupMetadata, groupParticipants };
}
