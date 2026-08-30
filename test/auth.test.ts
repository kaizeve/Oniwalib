// Inicialização de credenciais + base64 próprio + ClientPayload de registro.

import { nodeAdapter, setCrypto } from "../src/crypto";
import { initAuthCreds, memoryAuthState, b64, b64decode } from "../src/auth/state";
import { buildClientPayload } from "../src/proto/handshake";
import { MODIFIED } from "../src/profiles/index";

setCrypto(nodeAdapter);

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

// --- base64 round-trip (impl própria, sem Buffer) ---------------------
{
  for (const len of [0, 1, 2, 3, 16, 31, 32, 100]) {
    const src = nodeAdapter.randomBytes(len);
    const back = b64decode(b64(src));
    ok(
      `b64 round-trip len=${len}`,
      back.length === src.length && back.every((v, i) => v === src[i]),
    );
  }
  ok("b64 conhecido", b64(Uint8Array.from([0x66, 0x6f, 0x6f])) === "Zm9v");
}

// --- creds ------------------------------------------------------------
{
  const creds = initAuthCreds();
  ok("noiseKey 32 bytes", creds.noiseKey.publicKey.length === 32);
  ok("identidade 32 bytes", creds.signedIdentityKey.publicKey.length === 32);
  ok("signedPreKey assinada (64b)", creds.signedPreKey.signature.length === 64);
  ok("registrationId em faixa", creds.registrationId >= 0 && creds.registrationId < 0x4000);
  ok("advSecretKey base64 de 32b", b64decode(creds.advSecretKey).length === 32);
  ok("não registrado no init", creds.registered === false);

  // a assinatura da signedPreKey verifica contra a identidade
  const signed = new Uint8Array(33);
  signed[0] = 0x05;
  signed.set(creds.signedPreKey.keyPair.publicKey, 1);
  ok(
    "assinatura da signedPreKey confere",
    nodeAdapter.verify(creds.signedIdentityKey.publicKey, signed, creds.signedPreKey.signature),
  );
}

// --- ClientPayload de registro --------------------------------------
{
  const { creds } = memoryAuthState();
  const payload = buildClientPayload(creds, MODIFIED);
  ok("payload tem regData (primeiro login)", !!payload.regData);
  ok("eRegid 4 bytes", payload.regData!.eRegid.length === 4);
  ok("eKeytype = 0x05", payload.regData!.eKeytype[0] === 0x05);
  ok("eSkeyId 3 bytes", payload.regData!.eSkeyId.length === 3);
  ok("userAgent WEB", payload.userAgent.platform === "WEB");
  ok(
    "appVersion do profile",
    payload.userAgent.appVersion.primary === MODIFIED.waVersion[0],
  );
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/auth [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
