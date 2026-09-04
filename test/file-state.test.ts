// fileAuthState — persistência criptografada em log append-only. Script
// autocontido: roda em bun (`bun test/file-state.test.ts`) e no RTS.

import * as fs from "node:fs";
import { fileAuthState, AuthStoreCorruptError } from "../src/auth/file-state";

// `fileAuthState` é opt-in e node-only (`node:fs`). No RTS a suíte esbarra num
// `ENOENT` ao dar `stat` num arquivo recém-escrito — um edge de sequenciamento
// no `node:fs` do RTS, não da lib (use `memoryAuthState` no engine). Pula limpo.
if (
  typeof (globalThis as any).Bun === "undefined" &&
  typeof (globalThis as any).__rtsFetchText !== "undefined"
) {
  console.log("\noniwalib/file-state [rts]  0 pass, 0 fail  (pulado — node-only, ver README)");
  (globalThis as any).process?.exit?.(0);
}

let pass = 0;
let fail = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) pass++;
  else {
    fail++;
    fails.push(name + (detail ? ` — ${detail}` : ""));
  }
}
function eq(name: string, a: unknown, b: unknown): void {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  ok(name, sa === sb, sa === sb ? "" : `\n  got : ${sa}\n  want: ${sb}`);
}

const tmp =
  (typeof process !== "undefined" && process.env?.TMPDIR) || "/tmp";
const base = `${tmp}/oniwa-fs-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const path = base + "/auth.owl";
const KEY = new Uint8Array(32).fill(7);

function cleanup() {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

try {
  // --- 1. cria arquivo, persiste creds -------------------------------
  {
    const { state } = fileAuthState(path, { key: KEY });
    ok("arquivo criado", fs.existsSync(path));
    ok("creds tem registrationId", typeof state.creds.registrationId === "number");
    ok("creds.registered começa false", state.creds.registered === false);
  }

  // --- 2. reabre → mesmas creds ------------------------------------
  let regId: number;
  {
    const { state } = fileAuthState(path, { key: KEY });
    regId = state.creds.registrationId;
    const { state: again } = fileAuthState(path, { key: KEY });
    eq("registrationId sobrevive ao restart", again.creds.registrationId, regId);
  }

  // --- 3. saveCreds persiste mutação -----------------------------
  {
    const h = fileAuthState(path, { key: KEY });
    h.state.creds.registered = true;
    h.state.creds.me = { id: "5511999999999@s.whatsapp.net", name: "Kai" };
    await h.saveCreds();

    const { state } = fileAuthState(path, { key: KEY });
    ok("registered persistiu", state.creds.registered === true);
    eq("me.name persistiu", state.creds.me?.name, "Kai");
  }

  // --- 4. keys.set / keys.get com bytes -------------------------
  {
    const h = fileAuthState(path, { key: KEY });
    await h.state.keys.set({
      "pre-key": {
        "1": { private: new Uint8Array([1, 2, 3]), public: new Uint8Array([9, 8, 7]) },
        "2": { private: new Uint8Array([4, 5, 6]), public: new Uint8Array([6, 5, 4]) },
      },
      session: { "5511@s": new Uint8Array([255, 0, 128]) },
    });

    const { state } = fileAuthState(path, { key: KEY });
    const got = await state.keys.get("pre-key", ["1", "2", "3"]);
    ok("pre-key 1 e 2 voltam, 3 não", !!got["1"] && !!got["2"] && !("3" in got));
    ok(
      "bytes da pre-key preservados",
      got["1"] instanceof Object &&
        Array.from((got["1"] as any).private) + "" === "1,2,3" &&
        (got["1"] as any).private instanceof Uint8Array,
    );
    const sess = await state.keys.get("session", ["5511@s"]);
    ok(
      "session bytes preservados",
      sess["5511@s"] instanceof Uint8Array &&
        Array.from(sess["5511@s"] as Uint8Array) + "" === "255,0,128",
    );
  }

  // --- 5. delete (tombstone) sobrevive ao restart --------------
  {
    const h = fileAuthState(path, { key: KEY });
    await h.state.keys.set({ "pre-key": { "1": null as unknown as undefined } });
    const { state } = fileAuthState(path, { key: KEY });
    const got = await state.keys.get("pre-key", ["1", "2"]);
    ok("pre-key 1 apagada, 2 fica", !("1" in got) && !!got["2"]);
  }

  // --- 6. recuperação de crash: cauda de lixo é truncada -------
  {
    const before = fs.statSync(path).size;
    fs.appendFileSync(path, Uint8Array.from([0, 0, 1, 200, 42, 42, 42])); // recLen absurdo
    const { state } = fileAuthState(path, { key: KEY });
    const after = fs.statSync(path).size;
    ok("cauda torta truncada", after === before, `${after} vs ${before}`);
    ok("dados intactos após truncar", state.creds.registrationId === regId);
    const got = await state.keys.get("pre-key", ["2"]);
    ok("pre-key 2 ainda lá após truncar", !!got["2"]);
  }

  // --- 7. chave errada LANÇA (não apaga o arquivo → não força re-registro) --
  {
    const wrong = new Uint8Array(32).fill(9);
    const sizeBefore = fs.statSync(path).size;
    let threw: unknown;
    try {
      fileAuthState(path, { key: wrong });
    } catch (e) {
      threw = e;
    }
    ok("chave errada lança AuthStoreCorruptError", threw instanceof AuthStoreCorruptError);
    ok("arquivo intocado após chave errada", fs.statSync(path).size === sizeBefore);
    // chave certa continua lendo tudo
    const { state } = fileAuthState(path, { key: KEY });
    ok("chave certa ainda lê após tentativa errada", state.creds.registrationId === regId);
  }

  // --- 8. compactação mantém o arquivo limitado ----------------
  {
    const p2 = base + "/compact.owl";
    const h = fileAuthState(p2, { key: KEY });
    for (let i = 0; i < 400; i++) {
      await h.state.keys.set({
        session: { fixo: new Uint8Array(200).fill(i & 0xff) },
      });
    }
    const size = fs.statSync(p2).size;
    ok("arquivo compactado fica pequeno", size < 20000, `${size} bytes`);
    const { state } = fileAuthState(p2, { key: KEY });
    const got = await state.keys.get("session", ["fixo"]);
    ok(
      "último valor sobrevive à compactação",
      got["fixo"] instanceof Uint8Array &&
        (got["fixo"] as Uint8Array)[0] === ((399) & 0xff),
    );
  }
} finally {
  cleanup();
}

const runtime =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";

console.log(`\noniwalib/file-state [${runtime}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
