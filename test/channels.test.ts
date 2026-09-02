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
