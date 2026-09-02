// Adapters de cripto — `node-adapter` (bun/node, via `curve25519-js`) e
// `rts-adapter` (RTS, via `node:crypto` + trio X25519 cru + XEdDSA nativo de
// UrubuCode/rts#2609). Cobre: paridade entre os dois no que ambos conseguem
// fazer sobre bun (hash/HMAC/HKDF/AES/X25519), e XEdDSA de verdade — round-trip,
// detecção de adulteração, chave errada e o Z aleatório (duas assinaturas
// diferentes da mesma mensagem, ambas válidas).

import nodeCrypto from "node:crypto";
import { nodeAdapter, rtsAdapter, RTS_GAPS } from "../src/crypto";

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

const eq = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const bytes = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

// Runtime probe. bun/node: KeyObjects (`generateKeyPairSync`) + `curve25519-js`,
// mas NÃO o trio X25519 cru nem `xeddsaSign`. RTS: o inverso. Só sobre bun os
// dois adapters conseguem rodar o mesmo caminho de curva/assinatura, então a
// paridade cruzada de X25519/XEdDSA e os testes do `nodeAdapter` que usam
// `curve25519-js` ficam atrás de `nodeOk`.
const rawCrypto = nodeCrypto as unknown as Record<string, unknown>;
const hasRawCurve = typeof rawCrypto.generateX25519KeyPair === "function";
const hasXeddsa = typeof rawCrypto.xeddsaSign === "function";
const nodeOk = typeof rawCrypto.generateKeyPairSync === "function";

// --- RTS_GAPS vazio (cripto do RTS fechada) ------------------------------
ok("RTS_GAPS está vazio", RTS_GAPS.length === 0, `sobrou: ${RTS_GAPS.join(", ")}`);

// --- paridade node vs rts no que os dois fazem sobre bun ----------------
{
  const msg = bytes("oniwalib parity check — hash/hmac/hkdf");
  ok("sha256 igual", eq(nodeAdapter.sha256(msg), rtsAdapter.sha256(msg)));

  const key = nodeAdapter.randomBytes(32);
  ok("hmacSha256 igual", eq(nodeAdapter.hmacSha256(key, msg), rtsAdapter.hmacSha256(key, msg)));

  const ikm = nodeAdapter.randomBytes(32);
  const salt = nodeAdapter.randomBytes(32);
  const info = bytes("WhisperText");
  ok(
    "hkdf 80 bytes igual",
    eq(
      nodeAdapter.hkdf(ikm, 80, { salt, info }),
      rtsAdapter.hkdf(ikm, 80, { salt, info }),
    ),
  );

  if (nodeAdapter.md5 && rtsAdapter.md5) {
    ok("md5 igual", eq(nodeAdapter.md5(msg), rtsAdapter.md5(msg)));
  }
}

// --- AES-GCM/CBC: cifra num adapter, decifra no outro ------------------
{
  const key = nodeAdapter.randomBytes(32);
  const iv = nodeAdapter.randomBytes(12);
  const aad = bytes("v2");
  const pt = bytes("mensagem que atravessa os dois adapters");

  const ct = nodeAdapter.aesGcmEncrypt(key, iv, pt, aad);
  ok("aes-gcm: node→rts round-trip", eq(rtsAdapter.aesGcmDecrypt(key, iv, ct, aad), pt));
  ok("aes-gcm: rts→node round-trip",
    eq(nodeAdapter.aesGcmDecrypt(key, iv, rtsAdapter.aesGcmEncrypt(key, iv, pt, aad), aad), pt));

  let tampered = false;
  try {
    const bad = ct.slice();
    bad[0] ^= 1;
    rtsAdapter.aesGcmDecrypt(key, iv, bad, aad);
  } catch {
    tampered = true;
  }
  ok("aes-gcm: tag adulterada lança", tampered);

  const iv16 = nodeAdapter.randomBytes(16);
  const cbc = nodeAdapter.aesCbcEncrypt(key, iv16, pt);
  ok("aes-cbc: node→rts round-trip", eq(rtsAdapter.aesCbcDecrypt(key, iv16, cbc), pt));
}

// --- X25519: as duas pontas chegam ao mesmo segredo -------------------
if (!hasRawCurve || !nodeOk) {
  console.log("  ~ x25519 paridade cruzada: pulada (runtime não tem os dois adapters de curva)");
} else {
  const a = nodeAdapter.generateX25519();
  const b = rtsAdapter.generateX25519();
  ok("x25519: DH concorda entre adapters",
    eq(nodeAdapter.x25519(a.privateKey, b.publicKey), rtsAdapter.x25519(b.privateKey, a.publicKey)));
}

// --- XEdDSA no node-adapter (curve25519-js) --------------------------
if (!nodeOk) {
  console.log("  ~ node-adapter XEdDSA: pulado (runtime sem curve25519-js/KeyObjects — esperado no RTS)");
} else {
  const kp = nodeAdapter.generateSigningKey();
  ok("signing key: 32/32 bytes", kp.privateKey.length === 32 && kp.publicKey.length === 32);

  const msg = bytes("\x05" + "corpo assinado pela identidade");
  const sig = nodeAdapter.sign(kp.privateKey, msg);
  ok("sign: 64 bytes", sig.length === 64);
  ok("verify: assinatura boa passa", nodeAdapter.verify(kp.publicKey, msg, sig));

  const msgBad = msg.slice();
  msgBad[3] ^= 1;
  ok("verify: mensagem alterada falha", !nodeAdapter.verify(kp.publicKey, msgBad, sig));

  const sigBad = sig.slice();
  sigBad[10] ^= 1;
  ok("verify: assinatura alterada falha", !nodeAdapter.verify(kp.publicKey, msg, sigBad));

  const other = nodeAdapter.generateSigningKey();
  ok("verify: outra chave falha", !nodeAdapter.verify(other.publicKey, msg, sig));

  // Z aleatório: assinar duas vezes dá assinaturas diferentes, ambas válidas.
  const sig2 = nodeAdapter.sign(kp.privateKey, msg);
  ok("sign: Z aleatório → assinaturas diferentes", !eq(sig, sig2));
  ok("sign: a segunda também verifica", nodeAdapter.verify(kp.publicKey, msg, sig2));
}

// --- XEdDSA no rts-adapter — só roda onde `xeddsaSign` existe (RTS) ---
{
  if (!hasXeddsa) {
    console.log("  ~ rts-adapter XEdDSA: pulado (runtime sem xeddsaSign — esperado em bun/node)");
  } else {
    const kp = rtsAdapter.generateSigningKey();
    const msg = bytes("\x05" + "assinado no RTS");
    const sig = rtsAdapter.sign(kp.privateKey, msg);
    ok("rts XEdDSA: sign 64 bytes", sig.length === 64);
    ok("rts XEdDSA: verify passa", rtsAdapter.verify(kp.publicKey, msg, sig));
    const bad = msg.slice();
    bad[0] ^= 1;
    ok("rts XEdDSA: mensagem alterada falha", !rtsAdapter.verify(kp.publicKey, bad, sig));
    // Cross-check: o node-adapter aceita o que o RTS assinou (mesma curva/esquema).
    // Só dá pra fazer onde os dois adapters rodam — ou seja, nunca ao mesmo
    // tempo hoje (bun tem node-adapter sem xeddsa nativo; RTS o inverso).
    if (nodeOk) {
      ok("rts XEdDSA: node-adapter verifica a assinatura do RTS",
        nodeAdapter.verify(kp.publicKey, msg, sig));
    }
  }
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/crypto [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
