// Camada de CANAIS (src/channels/index.ts): resolver `registry/channels.json`,
// metadata `w:mex` por convite, seguir, e o `ensureFollowing` (checa antes).
// `query` é um dublê que captura o <iq> e devolve um <result> canned.

import {
  createChannelsLayer,
  resolveRequiredChannels,
  verifyRegistrySignature,
  canonicalizeChannels,
  inviteCodeOf,
  followsChannel,
  DEFAULT_REQUIRED_CHANNELS,
} from "../src/channels";
import { node, getBinaryNodeChild, type BinaryNode } from "../src/frame/node";
import { utf8Decode, utf8Encode } from "../src/frame/buffer";
import { crypto } from "../src/crypto";

// Fixture assinado com a chave privada que casa com a REGISTRY_PUBKEY embutida
// em src/channels/index.ts (a lista viva mora no repo kaizeve/oni-registry).
const SIGNED_LIST = ["https://whatsapp.com/channel/0029VaX7DkVBPzjViakU1l2p"];
const SIGNED_SIG =
  "srNiLznPkoGVWnk3eodgcgrciVKw9GKSVhVAB6Zr5B9bPmeRG6EwFKsw4rg+ovTjmY3pOpXzuQX3ThhkIMiQCg==";

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

const CODE = "0029VaX7DkVBPzjViakU1l2p";
const JID = "120363000000000000@newsletter";

// --- inviteCodeOf ---------------------------------------------------------
{
  ok("inviteCodeOf: link https", inviteCodeOf(`https://whatsapp.com/channel/${CODE}`) === CODE);
  ok("inviteCodeOf: link chat.whatsapp", inviteCodeOf(`https://chat.whatsapp.com/channel/${CODE}/`) === CODE);
  ok("inviteCodeOf: só o código", inviteCodeOf(CODE) === CODE);
  ok("inviteCodeOf: vazio", inviteCodeOf("") === "");
}

// --- followsChannel -----------------------------------------------------
{
  ok("followsChannel: GUEST não segue", followsChannel({ id: JID, viewerRole: "GUEST" }) === false);
  ok("followsChannel: ausente não segue", followsChannel({ id: JID }) === false);
  ok("followsChannel: SUBSCRIBER segue", followsChannel({ id: JID, viewerRole: "SUBSCRIBER" }) === true);
  ok("followsChannel: OWNER segue", followsChannel({ id: JID, viewerRole: "owner" }) === true);
}

// --- assinatura do registry (chave real embutida) --------------------
{
  ok(
    "assinatura do fixture fecha com a REGISTRY_PUBKEY embutida",
    verifyRegistrySignature(SIGNED_LIST, SIGNED_SIG, crypto()),
  );
  ok(
    "assinatura NÃO cobre uma lista adulterada",
    !verifyRegistrySignature([...SIGNED_LIST, "https://whatsapp.com/channel/HACK"], SIGNED_SIG, crypto()),
  );
  ok("sig ausente → recusa", !verifyRegistrySignature(SIGNED_LIST, undefined, crypto()));
  ok("canonicalize: array de strings", canonicalizeChannels(["a", "b"]) === '["a","b"]');
}

// --- resolveRequiredChannels ------------------------------------------
{
  const noNet = await resolveRequiredChannels({ fetch: false });
  ok("resolve: sem rede → default", noNet.source === "default" && noNet.channels.length === DEFAULT_REQUIRED_CHANNELS.length);

  const real = (globalThis as any).fetch;
  const okTrue = { verify: () => true };
  const okFalse = { verify: () => false };

  // JSON com lista + sig presente; o crypto stub decide se ela vale
  (globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => ({
      required_channels: ["https://whatsapp.com/channel/AAA", "BBB"],
      sig: "ZmFrZS1zaWc=",
    }),
  });
  try {
    const unsigned = await resolveRequiredChannels({ source: "https://x.test/c.json", crypto: okFalse });
    ok("resolve: JSON sem sig válida → default", unsigned.source === "default");

    const signed = await resolveRequiredChannels({ source: "https://x.test/c.json", crypto: okTrue });
    ok("resolve: JSON com sig válida → lista do JSON", signed.source === "fetch" && signed.channels.length === 2);
  } finally {
    (globalThis as any).fetch = real;
  }

  (globalThis as any).fetch = async () => ({ ok: false, json: async () => ({}) });
  try {
    const bad = await resolveRequiredChannels({ source: "https://x.test/404.json", crypto: okTrue });
    ok("resolve: resposta ruim → default", bad.source === "default");
  } finally {
    (globalThis as any).fetch = real;
  }

  // ponta a ponta com o crypto REAL: fixture assinado → aceito; adulterado → default
  (globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => ({ required_channels: SIGNED_LIST, sig: SIGNED_SIG }),
  });
  try {
    const r = await resolveRequiredChannels({ source: "https://x.test/c.json" });
    ok("resolve e2e: fixture assinado → source=fetch", r.source === "fetch");
  } finally {
    (globalThis as any).fetch = real;
  }
  (globalThis as any).fetch = async () => ({
    ok: true,
    json: async () => ({
      required_channels: [...SIGNED_LIST, "https://whatsapp.com/channel/LADRAO"],
      sig: SIGNED_SIG,
    }),
  });
  try {
    const r = await resolveRequiredChannels({ source: "https://x.test/c.json" });
    ok("resolve e2e: lista adulterada → default (canal oficial preservado)", r.source === "default");
  } finally {
    (globalThis as any).fetch = real;
  }
}

// --- w:mex: metadata + follow + ensureFollowing ----------------------
{
  // dublê de query: guarda o último <iq>, responde conforme o query_id.
  let lastIq: BinaryNode | undefined;
  let viewerRole = "GUEST";
  let followCalls = 0;

  const mkResult = (obj: unknown): BinaryNode =>
    node("iq", { type: "result" }, [node("result", {}, utf8Encode(JSON.stringify(obj)))]);

  const query = async (iq: BinaryNode): Promise<BinaryNode> => {
    lastIq = iq;
    const q = getBinaryNodeChild(iq, "query");
    const qid = q?.attrs.query_id;
    const vars = JSON.parse(utf8Decode(q!.content as Uint8Array)).variables;
    if (qid === "6620195908089573") {
      return mkResult({
        data: {
          xwa2_newsletter: {
            id: JID,
            thread_metadata: { name: { text: "Canal Oni" } },
            viewer_metadata: { view_role: viewerRole },
          },
        },
      });
    }
    if (qid === "9926858900719341") {
      followCalls++;
      ok("follow: manda o newsletter_id certo", vars.newsletter_id === JID);
      return mkResult({ data: { xwa2_newsletter_follow: { id: JID } } });
    }
    throw new Error("query_id inesperado: " + qid);
  };

  const ch = createChannelsLayer({ query });

  const meta = await ch.newsletterMetadata("invite", CODE);
  ok("metadata: <iq xmlns=w:mex type=get>", lastIq?.attrs.xmlns === "w:mex" && lastIq?.attrs.type === "get");
  ok("metadata: id do canal", meta.id === JID);
  ok("metadata: nome", meta.name === "Canal Oni");
  ok("metadata: viewerRole", meta.viewerRole === "GUEST");

  // GUEST → ensureFollowing deve seguir
  viewerRole = "GUEST";
  followCalls = 0;
  const r1 = await ch.ensureFollowing(`https://whatsapp.com/channel/${CODE}`);
  ok("ensure: GUEST → action=followed", r1.action === "followed" && r1.jid === JID);
  ok("ensure: GUEST → chamou follow 1x", followCalls === 1);

  // SUBSCRIBER → ensureFollowing NÃO segue de novo
  viewerRole = "SUBSCRIBER";
  followCalls = 0;
  const r2 = await ch.ensureFollowing(CODE);
  ok("ensure: SUBSCRIBER → action=already", r2.action === "already");
  ok("ensure: SUBSCRIBER → não chamou follow", followCalls === 0);
}

// --- ensureFollowing nunca lança --------------------------------------
{
  const ch = createChannelsLayer({
    query: async () => {
      throw new Error("boom");
    },
  });
  const r = await ch.ensureFollowing(`https://whatsapp.com/channel/${CODE}`);
  ok("ensure: erro → action=failed, sem throw", r.action === "failed" && !!r.error);
}

// --- ações novas: unfollow / mute / unmute / create / delete / react ---
{
  const seen: Array<{ qid?: string; vars: any }> = [];
  const last = () => seen[seen.length - 1];
  function mkRes3(obj: unknown): BinaryNode {
    return node("iq", { type: "result" }, [node("result", {}, utf8Encode(JSON.stringify(obj)))]);
  }
  const query3 = async (iq: BinaryNode): Promise<BinaryNode> => {
    const q = getBinaryNodeChild(iq, "query")!;
    const vars = JSON.parse(utf8Decode(q.content as Uint8Array)).variables;
    seen.push({ qid: q.attrs.query_id, vars });
    if (q.attrs.query_id === "6234210096708695") {
      return mkRes3({ data: { xwa2_newsletter_create: { id: JID, thread_metadata: { name: { text: vars.input.name } } } } });
    }
    return mkRes3({ data: {} });
  };
  const sent3: BinaryNode[] = [];
  const lastSent = () => sent3[sent3.length - 1]!;
  const ch3 = createChannelsLayer({ query: query3, sendNode: (n) => sent3.push(n), genId: () => "GID1" });

  await ch3.unfollowNewsletter(JID);
  ok("unfollow: query_id + newsletter_id", last()?.qid === "7238632346214362" && last()?.vars.newsletter_id === JID);

  await ch3.muteNewsletter(JID);
  ok("mute: query_id", last()?.qid === "25151904754424642");
  await ch3.unmuteNewsletter(JID);
  ok("unmute: query_id", last()?.qid === "7337137176362961");

  const created = await ch3.createNewsletter("Meu Canal", "desc");
  ok("create: query_id + input.name/description", last()?.qid === "6234210096708695" && last()?.vars.input.name === "Meu Canal" && last()?.vars.input.description === "desc");
  ok("create: devolve metadata com id", created.id === JID && created.name === "Meu Canal");

  await ch3.deleteNewsletter(JID);
  ok("delete: query_id", last()?.qid === "8316537688363079");

  ch3.newsletterReactMessage(JID, 42, "🔥");
  const rmsg = lastSent();
  ok("react: <message to=jid type=reaction server_id id>", rmsg.tag === "message" && rmsg.attrs.to === JID && rmsg.attrs.type === "reaction" && rmsg.attrs.server_id === "42" && rmsg.attrs.id === "GID1");
  const rchild = Array.isArray(rmsg.content) ? rmsg.content[0] : undefined;
  ok("react: <reaction code>", (rchild as BinaryNode)?.tag === "reaction" && (rchild as BinaryNode)?.attrs.code === "🔥");
  ok("react: sem edit attr quando reage", rmsg.attrs.edit === undefined);

  ch3.newsletterReactMessage(JID, 42, "");
  const rmsg2 = lastSent();
  const rchild2 = Array.isArray(rmsg2.content) ? (rmsg2.content[0] as BinaryNode) : undefined;
  ok("react vazio: edit=7 e <reaction> sem code", rmsg2.attrs.edit === "7" && !rchild2?.attrs.code);
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/channels [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
