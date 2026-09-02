// Assina o `channels.json` do repo SEPARADO `kaizeve/oni-registry` — só o dono
// roda isto, com a chave PRIVADA (curve25519 / XEdDSA, 32 bytes base64). Sem a
// assinatura válida a lib ignora a lista remota e usa a embutida
// (`DEFAULT_REQUIRED_CHANNELS`), então editar o JSON sem re-assinar não muda
// nada pra quem roda a oni.
//
//   bun scripts/sign-registry.ts                 # ../oni-registry/channels.json, chave em .registry-signing-key
//   bun scripts/sign-registry.ts --file <path>   # assina outro arquivo
//   ONI_REGISTRY_KEY=<b64> bun scripts/sign-registry.ts
//   bun scripts/sign-registry.ts --key <arquivo-da-chave>
//   bun scripts/sign-registry.ts --gen           # gera um par novo (imprime, não grava)
//
// Fluxo de deploy: edita `channels.json` no checkout do `oni-registry`, roda
// este script, faz commit/push NESSE repo. A lib lê o raw a cada connect.
//
// A chave NUNCA entra em repo nenhum (`.gitignore` cobre `.registry-signing-key`).
// A chave PÚBLICA correspondente tem que estar em src/channels/index.ts
// (`REGISTRY_PUBKEY`).

import * as fs from "node:fs";
import { crypto } from "../src/crypto";
import { canonicalizeChannels } from "../src/channels";

const c = crypto();
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const valAfter = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

if (has("--gen")) {
  const kp = c.generateSigningKey();
  console.log("par novo — guarde a privada FORA do repo:\n");
  console.log("  público  (src/channels/index.ts REGISTRY_PUBKEY):", b64(kp.publicKey));
  console.log("  privado  (registry/.signing-key ou ONI_REGISTRY_KEY):", b64(kp.privateKey));
  process.exit(0);
}

const REG = valAfter("--file") ?? "../oni-registry/channels.json";
const KEY_FILE = valAfter("--key") ?? ".registry-signing-key";

let privB64 = process.env.ONI_REGISTRY_KEY?.trim();
if (!privB64) {
  if (!fs.existsSync(KEY_FILE)) {
    console.error(
      `sem chave: defina ONI_REGISTRY_KEY=<b64>, ou ponha a chave em ${KEY_FILE}, ` +
        `ou passe --key <arquivo>. (--gen cria um par novo)`,
    );
    process.exit(1);
  }
  privB64 = fs.readFileSync(KEY_FILE, "utf8").trim();
}

const priv = Buffer.from(privB64, "base64");
if (priv.length !== 32) {
  console.error(`chave privada com ${priv.length} bytes (esperado 32, base64 de 32 bytes)`);
  process.exit(1);
}

const json = JSON.parse(fs.readFileSync(REG, "utf8")) as {
  required_channels?: unknown;
  sig?: string;
  [k: string]: unknown;
};
const canon = canonicalizeChannels(json.required_channels);
const sig = c.sign(new Uint8Array(priv), new TextEncoder().encode(canon));
json.sig = b64(sig);

// re-serializa mantendo a ordem legível: required_channels, sig, resto
const { required_channels, sig: _s, ...rest } = json;
const out = JSON.stringify({ required_channels, sig: json.sig, ...rest }, null, 2) + "\n";
fs.writeFileSync(REG, out);

// confere contra a pública embutida
const mod = await import("../src/channels");
const okPub = mod.verifyRegistrySignature(json.required_channels, json.sig, c);
console.log(`assinado: ${REG}`);
console.log(`  canon: ${canon}`);
console.log(`  sig  : ${json.sig}`);
console.log(
  okPub
    ? "  ✓ fecha com a REGISTRY_PUBKEY embutida"
    : "  ✗ NÃO fecha com a REGISTRY_PUBKEY de src/channels/index.ts — pública errada?",
);
if (!okPub) process.exit(1);
