// oni-version: ordem de resolução, parse das fontes, buildHash.
//
// Nota: cada cenário é uma função própria. Blocos `{}` irmãos com `const` de
// mesmo nome disparam um bug de escopo do RTS (ReferenceError) — função dá
// escopo limpo e é o que o resto da suíte já usa.

import {
  DEFAULT_ONI_VERSION,
  fetchLatestOniVersion,
  memoryVersionStore,
  resolveOniVersion,
  versionBuildHash,
} from "../src/version";
import { crypto } from "../src/crypto";

const C = crypto();
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
const eqv = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

async function orderOverride() {
  const r = await resolveOniVersion({ override: [2, 1, 2], fetch: false });
  ok("override vence", r.source === "override" && eqv(r.version, [2, 1, 2]));
}

async function orderDefault() {
  const r = await resolveOniVersion({ fetch: false });
  ok("sem nada → default", r.source === "default" && eqv(r.version, DEFAULT_ONI_VERSION));
}

async function orderCache() {
  const store = memoryVersionStore();
  await store.set([2, 3000, 42]);
  const r = await resolveOniVersion({ fetch: false, store });
  ok("cache vence o default", r.source === "cache" && eqv(r.version, [2, 3000, 42]));
}

async function orderOverrideBeatsCache() {
  const store = memoryVersionStore();
  await store.set([2, 2, 2]);
  const r = await resolveOniVersion({ fetch: false, store, override: [9, 9, 9] });
  ok("override vence o cache", r.source === "override" && eqv(r.version, [9, 9, 9]));
}

async function withMockedFetch(
  handler: (url: string) => { ok: boolean; text: () => Promise<string> } | Promise<never>,
  body: () => Promise<void>,
) {
  const real = (globalThis as any).fetch;
  (globalThis as any).fetch = async (url: string) => handler(url);
  try {
    await body();
  } finally {
    (globalThis as any).fetch = real;
  }
}

async function parseSources() {
  await withMockedFetch(
    (url) =>
      url.endsWith(".json")
        ? { ok: true, text: async () => JSON.stringify({ version: [2, 3000, 777] }) }
        : { ok: true, text: async () => 'w={"client_revision":998877,"foo":1};' },
    async () => {
      const fromJson = await fetchLatestOniVersion(["https://example.test/oni-version.json"]);
      ok("parse do JSON", !!fromJson && eqv(fromJson, [2, 3000, 777]));

      const fromHtml = await fetchLatestOniVersion(["https://web.whatsapp.com/"]);
      ok("parse do client_revision", !!fromHtml && eqv(fromHtml, [2, 3000, 998877]));

      const store = memoryVersionStore();
      const r = await resolveOniVersion({
        store,
        sources: ["https://example.test/oni-version.json"],
      });
      ok("resolve com fetch", r.source === "fetch" && eqv(r.version, [2, 3000, 777]));
      ok("fetch gravou no cache", eqv((await store.get())!, [2, 3000, 777]));
    },
  );
}

async function deadSourceFallsThrough() {
  await withMockedFetch(
    (url) => {
      if (url.includes("dead")) throw new Error("network");
      return { ok: true, text: async () => JSON.stringify({ version: [2, 3000, 555] }) };
    },
    async () => {
      const v = await fetchLatestOniVersion([
        "https://dead.test/oni-version.json",
        "https://ok.test/oni-version.json",
      ]);
      ok("pula fonte morta", !!v && eqv(v, [2, 3000, 555]));
    },
  );
}

function buildHash() {
  const h = versionBuildHash([2, 3000, 1], C);
  ok("buildHash 16 bytes", h.length === 16);
  if (C.md5) {
    const direct = C.md5(Uint8Array.from("2.3000.1", (c) => c.charCodeAt(0)));
    ok("buildHash = md5 do texto da versão", Array.from(h).join(",") === Array.from(direct).join(","));
  } else {
    ok("buildHash (sem md5 no adapter, é fallback)", true);
  }
}

await orderOverride();
await orderDefault();
await orderCache();
await orderOverrideBeatsCache();
await parseSources();
await deadSourceFallsThrough();
buildHash();

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/version [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
