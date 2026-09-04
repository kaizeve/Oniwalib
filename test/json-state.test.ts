// jsonAuthState / jsonFileAuthState — portable auth persistence (no `stat`,
// plain read/write). Round-trips creds + key buckets incl. Uint8Array.

import { jsonAuthState, jsonFileAuthState } from "../src/auth/json-state";

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
const eqBytes = (a: unknown, b: number[]) =>
  a instanceof Uint8Array && a.length === b.length && b.every((x, i) => a[i] === x);

// --- callback-backed: save/load round-trip -------------------------
{
  let blob: string | undefined;
  const a1 = jsonAuthState(
    () => blob,
    (j) => (blob = j),
  );
  ok("creds criadas do zero", !!a1.creds && !!a1.creds.noiseKey && a1.creds.registered === false);
  ok("nada salvo ainda (só get, sem set)", blob === undefined);

  await a1.keys.set({
    "pre-key": { "1": { public: new Uint8Array([1, 2, 3]), private: new Uint8Array([9, 9]) } },
    session: { "addr.0": { some: "record", n: 5 } },
  });
  ok("keys.set dispara flush", typeof blob === "string" && blob!.length > 0);

  a1.creds.registered = true;
  a1.saveCreds();
  ok("saveCreds persiste creds mutadas", JSON.parse(blob!).creds.registered === true);

  // recarrega de um novo estado a partir do MESMO blob
  const b1 = jsonAuthState(() => blob, undefined);
  ok("recarrega: registered", b1.creds.registered === true);
  const got = await b1.keys.get("pre-key", ["1", "naoexiste"]);
  ok("recarrega: pre-key só a que existe", Object.keys(got).length === 1);
  ok("recarrega: Uint8Array volta como bytes", eqBytes((got["1"] as any).public, [1, 2, 3]) && eqBytes((got["1"] as any).private, [9, 9]));
  const sess = await b1.keys.get("session", ["addr.0"]);
  ok("recarrega: session record", (sess["addr.0"] as any).n === 5 && (sess["addr.0"] as any).some === "record");
}

// --- set com valor undefined/null apaga a chave ------------------
{
  const a2 = jsonAuthState();
  await a2.keys.set({ "pre-key": { "7": { x: 1 } } });
  await a2.keys.set({ "pre-key": { "7": undefined as never } });
  const got = await a2.keys.get("pre-key", ["7"]);
  ok("set(undefined) apaga", !("7" in got));
}

// --- blob corrompido → começa limpo ----------------------------
{
  const a3 = jsonAuthState(() => "{ nao é json", undefined);
  ok("json inválido → creds novas, sem lançar", !!a3.creds && !!a3.creds.signedIdentityKey);
}

// --- jsonFileAuthState: escreve e relê de um arquivo -----------
{
  const fs = require("node:fs") as typeof import("node:fs");
  const path = `${(typeof process !== "undefined" && process.env?.TMPDIR) || "/tmp"}/oniwa-json-auth-${Date.now()}.json`;
  try {
    const af = jsonFileAuthState(path);
    af.creds.platform = "test-platform";
    af.saveCreds();
    await af.keys.set({ "app-state-sync-key": { k1: { keyData: new Uint8Array([5, 6, 7, 8]) } } });
    ok("arquivo criado", fs.existsSync(path));

    const bf = jsonFileAuthState(path);
    ok("relê do arquivo: platform", bf.creds.platform === "test-platform");
    const k = await bf.keys.get("app-state-sync-key", ["k1"]);
    ok("relê do arquivo: keyData bytes", eqBytes((k["k1"] as any).keyData, [5, 6, 7, 8]));

    // sobrescrita: um novo set reescreve o arquivo inteiro sem stat
    await bf.keys.set({ "app-state-sync-key": { k2: { keyData: new Uint8Array([1]) } } });
    const cf = jsonFileAuthState(path);
    const both = await cf.keys.get("app-state-sync-key", ["k1", "k2"]);
    ok("sobrescrita mantém as duas chaves", Object.keys(both).length === 2);
  } finally {
    try {
      fs.unlinkSync(path);
    } catch {
      /* ok */
    }
  }
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).__rtsFetchText !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/json-state [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
