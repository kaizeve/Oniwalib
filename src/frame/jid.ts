// JID — portado de @whiskeysockets/baileys src/WABinary/jid-utils.ts.

export type JidServer =
  | "c.us"
  | "g.us"
  | "broadcast"
  | "s.whatsapp.net"
  | "call"
  | "lid"
  | "newsletter"
  | "bot"
  | "hosted"
  | "hosted.lid";

export enum WAJIDDomains {
  WHATSAPP = 0,
  LID = 1,
  HOSTED = 128,
  HOSTED_LID = 129,
}

export interface FullJid {
  user: string;
  device?: number;
  server: JidServer;
  domainType?: number;
}

export const jidEncode = (
  user: string | number | null,
  server: JidServer | string,
  device?: number,
  agent?: number,
): string => `${user || ""}${agent ? `_${agent}` : ""}${device ? `:${device}` : ""}@${server}`;

export function jidDecode(jid: string | undefined): FullJid | undefined {
  const sepIdx = typeof jid === "string" ? jid.indexOf("@") : -1;
  if (sepIdx < 0) return undefined;

  const server = jid!.slice(sepIdx + 1);
  const userCombined = jid!.slice(0, sepIdx);
  const [userAgent, device] = userCombined.split(":");
  const [user, agent] = userAgent!.split("_");

  let domainType = WAJIDDomains.WHATSAPP;
  if (server === "lid") domainType = WAJIDDomains.LID;
  else if (server === "hosted") domainType = WAJIDDomains.HOSTED;
  else if (server === "hosted.lid") domainType = WAJIDDomains.HOSTED_LID;
  else if (agent) domainType = parseInt(agent);

  return {
    server: server as JidServer,
    user: user!,
    domainType,
    device: device ? +device : undefined,
  };
}

export const isJidUser = (jid: string | undefined) => jid?.endsWith("@s.whatsapp.net");
export const isLidUser = (jid: string | undefined) => jid?.endsWith("@lid");
export const isJidGroup = (jid: string | undefined) => jid?.endsWith("@g.us");
export const isJidBroadcast = (jid: string | undefined) => jid?.endsWith("@broadcast");
export const isJidNewsletter = (jid: string | undefined) => jid?.endsWith("@newsletter");
export const isJidStatusBroadcast = (jid: string | undefined) => jid === "status@broadcast";
export const isJidBot = (jid: string | undefined) => jid?.endsWith("@bot");

/** Que tipo de chat um JID representa. `group` cobre grupo comum E comunidade
 *  (o quê exatamente só a metadata do grupo diz — `<parent>` / `parent_group_id`);
 *  `channel` é um canal (`@newsletter`); `status` é o feed de status. */
export type ChatKind =
  | "user"
  | "lid"
  | "group"
  | "channel"
  | "status"
  | "broadcast"
  | "bot"
  | "unknown";

export function jidKind(jid: string | undefined): ChatKind {
  if (!jid) return "unknown";
  if (isJidStatusBroadcast(jid)) return "status";
  if (isJidGroup(jid)) return "group";
  if (isJidNewsletter(jid)) return "channel";
  if (isJidBroadcast(jid)) return "broadcast";
  if (isLidUser(jid)) return "lid";
  if (isJidBot(jid)) return "bot";
  if (isJidUser(jid) || jid.endsWith("@c.us")) return "user";
  return "unknown";
}
