// JID — o endereço de uma entidade no WhatsApp: `user@server`, opcionalmente
// com `:device` e (nas versões novas) um `agent`.
//
// Servidores conhecidos: `s.whatsapp.net` (usuário), `g.us` (grupo),
// `broadcast` (listas), `lid` (identidade oculta), `newsletter` (canais).

export interface Jid {
  user: string;
  server: string;
  device?: number;
  agent?: number;
}

export function jidEncode(user: string, server: string, device?: number): string {
  const d = device ? `:${device}` : "";
  return `${user}${d}@${server}`;
}

export function jidDecode(jid: string): Jid | undefined {
  const at = jid.indexOf("@");
  if (at < 0) {
    return undefined;
  }
  const server = jid.slice(at + 1);
  let left = jid.slice(0, at);

  let agent: number | undefined;
  let device: number | undefined;

  const dot = left.indexOf(".");
  if (dot >= 0) {
    agent = Number(left.slice(dot + 1, left.indexOf(":") >= 0 ? left.indexOf(":") : undefined));
    left = left.slice(0, dot) + (left.indexOf(":") >= 0 ? left.slice(left.indexOf(":")) : "");
  }
  const colon = left.indexOf(":");
  if (colon >= 0) {
    device = Number(left.slice(colon + 1));
    left = left.slice(0, colon);
  }

  return { user: left, server, device, agent };
}

export function isJidUser(jid: string): boolean {
  return jid.endsWith("@s.whatsapp.net");
}

export function isJidGroup(jid: string): boolean {
  return jid.endsWith("@g.us");
}
