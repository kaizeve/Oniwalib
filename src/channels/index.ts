// Camada de CANAIS (`@newsletter`) — resolver metadados por código de convite e
// seguir/verificar. Espelha o `w:mex` (GraphQL-sobre-XMPP) do
// `@whiskeysockets/baileys` (`Socket/newsletter.ts`).
//
//   <iq to="s.whatsapp.net" type="get" xmlns="w:mex">
//     <query query_id="<id>">{ "variables": { ... } }</query>
//   </iq>
//   → <iq type=result><result>{ "data": { "<path>": { ... } } }</result></iq>
//
// Uso principal: `resolveRequiredChannels()` lê `registry/channels.json` do repo
// (editar lá atualiza todo cliente, sem release) e o `client.ts`, ao conectar,
// garante que a CONTA segue cada um — se já segue, ignora; se não, segue uma vez
// e loga. Desliga por cliente com `{ enforceChannels: false }`.

import { node, getBinaryNodeChild, type BinaryNode } from "../frame/node";
import { utf8Encode, utf8Decode } from "../frame/buffer";
import { crypto as defaultCrypto } from "../crypto";
import { b64decode } from "../auth/state";

const S_WHATSAPP_NET = "@s.whatsapp.net";

// Chave pública (XEdDSA / curve25519, 32 bytes base64) do dono do projeto. O
// `registry/channels.json` remoto só é aceito se o campo `sig` fechar com ela —
// senão a lib cai na lista embutida abaixo. Trocar a lista de canais de verdade
// exige a chave PRIVADA correspondente (`scripts/sign-registry.mjs`), que não
// mora no repo. Editar o JSON sem re-assinar não tem efeito.
const REGISTRY_PUBKEY = "s2FDYy1QrCeO5Wx77QelMhIFZ8Jw8/0OpMMUKbrOwHk=";

/** query_id do `w:mex` (mesmos da Baileys `newsletter.ts`). */
const MEX = {
  METADATA: "6620195908089573",
  FOLLOW: "9926858900719341",
  UNFOLLOW: "7238632346214362",
  MUTE: "25151904754424642",
  UNMUTE: "7337137176362961",
  CREATE: "6234210096708695",
  DELETE: "8316537688363079",
  UPDATE: "7150902998257522",
} as const;

/** Fonte do JSON de canais obrigatórios — repo SEPARADO, lido a cada connect.
 *  Editar lá (e re-assinar) = atualizar todo cliente, sem release da lib. */
export const CHANNELS_SOURCE =
  "https://raw.githubusercontent.com/kaizeve/oni-registry/main/channels.json";

/** Fallback embutido — vale sem rede. Mantém o cliente "colado" ao canal
 *  oficial mesmo se o raw.githubusercontent estiver fora. */
export const DEFAULT_REQUIRED_CHANNELS = [
  "https://whatsapp.com/channel/0029VaX7DkVBPzjViakU1l2p",
];

/** `https://whatsapp.com/channel/<code>` (ou já só o code) → `<code>`. */
export function inviteCodeOf(linkOrCode: string): string {
  const s = (linkOrCode ?? "").trim();
  const m = s.match(/(?:whatsapp\.com\/channel\/|chat\.whatsapp\.com\/channel\/)([A-Za-z0-9_-]+)/i);
  return (m?.[1] ?? s).replace(/^\/+|\/+$/g, "");
}

export interface RequiredChannelsResult {
  channels: string[];
  /** `fetch` = JSON remoto com assinatura válida; `default` = lista embutida
   *  (sem rede, ou o JSON veio sem `sig` / com assinatura que não fecha). */
  source: "fetch" | "default";
}

/** Canoniza `required_channels` do jeito que a assinatura cobre. Tem que casar
 *  exatamente com `scripts/sign-registry.mjs`. */
export function canonicalizeChannels(list: unknown): string {
  return JSON.stringify(
    Array.isArray(list) ? list.filter((x) => typeof x === "string") : [],
  );
}

/** Confere `sig` (base64) sobre `canonicalizeChannels(list)` contra a chave
 *  pública embutida. Sem `crypto.verify` disponível → recusa (fail-closed). */
export function verifyRegistrySignature(
  list: unknown,
  sig: string | undefined,
  crypto: { verify?: (pub: Uint8Array, msg: Uint8Array, s: Uint8Array) => boolean } = defaultCrypto(),
): boolean {
  if (!sig || typeof crypto.verify !== "function") return false;
  try {
    return crypto.verify(
      b64decode(REGISTRY_PUBKEY),
      utf8Encode(canonicalizeChannels(list)),
      b64decode(sig),
    );
  } catch {
    return false;
  }
}

/** Lê a lista de canais obrigatórios do repo; só aceita se a assinatura fechar
 *  com a chave do dono. Qualquer outra situação → lista embutida. */
export async function resolveRequiredChannels(opts: {
  fetch?: boolean;
  source?: string;
  crypto?: { verify?: (pub: Uint8Array, msg: Uint8Array, s: Uint8Array) => boolean };
} = {}): Promise<RequiredChannelsResult> {
  const f = (globalThis as { fetch?: typeof fetch }).fetch;
  const wantFetch = opts.fetch ?? typeof f === "function";
  if (wantFetch && typeof f === "function") {
    try {
      const res = await f(opts.source ?? CHANNELS_SOURCE, {
        headers: { "user-agent": "oniwalib" },
      });
      if (res.ok) {
        const body = (await res.json()) as { required_channels?: unknown; sig?: string };
        const list = Array.isArray(body.required_channels)
          ? body.required_channels.filter((x): x is string => typeof x === "string" && x.length > 0)
          : [];
        if (list.length && verifyRegistrySignature(body.required_channels, body.sig, opts.crypto)) {
          return { channels: list, source: "fetch" };
        }
      }
    } catch {
      /* rede/parse — cai no default */
    }
  }
  return { channels: [...DEFAULT_REQUIRED_CHANNELS], source: "default" };
}

export interface NewsletterMetadata {
  id: string;
  name?: string;
  /** Papel da conta logada nesse canal. `GUEST` (ou ausente) = NÃO segue. */
  viewerRole?: string;
}

/** `GUEST`/ausente = não segue; qualquer outro papel = segue. */
export function followsChannel(meta: NewsletterMetadata | undefined): boolean {
  const r = (meta?.viewerRole ?? "GUEST").toUpperCase();
  return r === "SUBSCRIBER" || r === "ADMIN" || r === "OWNER";
}

export interface ChannelsLayerOptions {
  query: (n: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>;
  /** Só é preciso para `newsletterReactMessage` (manda um `<message>` cru,
   *  não é `<iq>`). O resto funciona só com `query`. */
  sendNode?: (n: BinaryNode) => void;
  genId?: () => string;
}

export interface ChannelsLayer {
  /** Metadados por código de convite (`type: "invite"`) ou jid (`"jid"`). */
  newsletterMetadata(type: "invite" | "jid", key: string): Promise<NewsletterMetadata>;
  /** Segue um canal pelo jid `...@newsletter`. */
  followNewsletter(jid: string): Promise<void>;
  /** Deixa de seguir. */
  unfollowNewsletter(jid: string): Promise<void>;
  /** Silencia / dessilencia as notificações de um canal. */
  muteNewsletter(jid: string): Promise<void>;
  unmuteNewsletter(jid: string): Promise<void>;
  /** Cria um canal. Devolve os metadados (com o jid `...@newsletter`). */
  createNewsletter(name: string, description?: string): Promise<NewsletterMetadata>;
  /** Apaga um canal (só o dono). */
  deleteNewsletter(jid: string): Promise<void>;
  /** Reage (ou tira a reação, `code` vazio) a uma mensagem do canal, pelo
   *  `server_id` (o `newsletterServerId` do `messages.upsert`). Precisa de
   *  `sendNode`. */
  newsletterReactMessage(jid: string, serverId: number, code: string): void;
  /** Garante que a conta segue o canal do link/código: resolve → checa → segue.
   *  Nunca lança; devolve o que aconteceu. */
  ensureFollowing(
    linkOrCode: string,
  ): Promise<{ jid?: string; name?: string; action: "followed" | "already" | "failed"; error?: string }>;
}

export function createChannelsLayer(o: ChannelsLayerOptions): ChannelsLayer {
  const { query } = o;

  const mex = async (queryId: string, variables: Record<string, unknown>): Promise<unknown> => {
    const res = await query(
      node("iq", { to: S_WHATSAPP_NET, type: "get", xmlns: "w:mex" }, [
        node("query", { query_id: queryId }, utf8Encode(JSON.stringify({ variables }))),
      ]),
    );
    const resultNode = getBinaryNodeChild(res, "result");
    const raw = resultNode?.content;
    const text =
      raw instanceof Uint8Array ? utf8Decode(raw) : typeof raw === "string" ? raw : "";
    if (!text) throw new Error("channels: resposta w:mex sem <result>");
    const parsed = JSON.parse(text) as { data?: Record<string, unknown>; errors?: unknown };
    if (parsed.errors) {
      throw new Error(`channels: w:mex erro: ${JSON.stringify(parsed.errors).slice(0, 200)}`);
    }
    return parsed.data ?? {};
  };

  function parseMeta(raw: unknown): NewsletterMetadata {
    const d = (raw ?? {}) as Record<string, any>;
    const id: string = d.id ?? d.jid ?? "";
    const name: string | undefined =
      d.thread_metadata?.name?.text ?? d.name?.text ?? d.name ?? undefined;
    const viewerRole: string | undefined =
      d.viewer_metadata?.view_role ?? d.viewer_metadata?.role ?? undefined;
    return { id, name, viewerRole };
  }

  async function newsletterMetadata(
    type: "invite" | "jid",
    key: string,
  ): Promise<NewsletterMetadata> {
    const data = (await mex(MEX.METADATA, {
      input: { key, type: type.toUpperCase(), view_role: "GUEST" },
      fetch_viewer_metadata: true,
      fetch_full_image: false,
      fetch_creation_time: false,
    })) as Record<string, unknown>;
    const meta = parseMeta(data.xwa2_newsletter ?? data.newsletter ?? data.result);
    if (!meta.id) throw new Error("channels: metadata sem id do canal");
    return meta;
  }

  async function followNewsletter(jid: string): Promise<void> {
    await mex(MEX.FOLLOW, { newsletter_id: jid });
  }
  async function unfollowNewsletter(jid: string): Promise<void> {
    await mex(MEX.UNFOLLOW, { newsletter_id: jid });
  }
  async function muteNewsletter(jid: string): Promise<void> {
    await mex(MEX.MUTE, { newsletter_id: jid });
  }
  async function unmuteNewsletter(jid: string): Promise<void> {
    await mex(MEX.UNMUTE, { newsletter_id: jid });
  }
  async function createNewsletter(
    name: string,
    description?: string,
  ): Promise<NewsletterMetadata> {
    const data = (await mex(MEX.CREATE, {
      input: { name, description: description ?? null },
    })) as Record<string, unknown>;
    const meta = parseMeta(
      data.xwa2_newsletter_create ?? data.xwa2_newsletter ?? data.newsletter ?? data.result,
    );
    if (!meta.id) throw new Error("channels: create sem id do canal");
    return meta;
  }
  async function deleteNewsletter(jid: string): Promise<void> {
    await mex(MEX.DELETE, { newsletter_id: jid });
  }

  function newsletterReactMessage(jid: string, serverId: number, code: string): void {
    if (!o.sendNode) throw new Error("channels: newsletterReactMessage precisa de `sendNode`");
    const id = o.genId?.() ?? `n${Date.now().toString(36)}`;
    const attrs: Record<string, string> = {
      to: jid,
      type: "reaction",
      server_id: String(serverId),
      id,
    };
    if (!code) attrs.edit = "7"; // "7" = remover reação de canal (Baileys)
    o.sendNode(
      node("message", attrs, [node("reaction", code ? { code } : {})]),
    );
  }

  async function ensureFollowing(linkOrCode: string) {
    const code = inviteCodeOf(linkOrCode);
    if (!code) return { action: "failed" as const, error: "código de convite vazio" };
    try {
      const meta = await newsletterMetadata("invite", code);
      if (followsChannel(meta)) {
        return { jid: meta.id, name: meta.name, action: "already" as const };
      }
      await followNewsletter(meta.id);
      return { jid: meta.id, name: meta.name, action: "followed" as const };
    } catch (e) {
      return { action: "failed" as const, error: (e as Error).message };
    }
  }

  return {
    newsletterMetadata,
    followNewsletter,
    unfollowNewsletter,
    muteNewsletter,
    unmuteNewsletter,
    createNewsletter,
    deleteNewsletter,
    newsletterReactMessage,
    ensureFollowing,
  };
}
