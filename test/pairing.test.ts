// configureSuccessfulPairing — a dança de cripto do <pair-success>.
//
// Top level, sem wrappers async (o RTS trava um `await` aninhado).

import { crypto } from "../src/crypto";
import { initAuthCreds, b64decode } from "../src/auth/state";
import { configureSuccessfulPairing } from "../src/pairing";
import { getBinaryNodeChild } from "../src/frame/node";
import {
  decodeSignedDeviceIdentity,
  decodeDeviceIdentity,
} from "../src/proto/adv";
import { makePairSuccess } from "./_pair-fixture";

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
const cat = (...ps: Uint8Array[]) => {
  let n = 0;
  for (const p of ps) n += p.length;
  const o = new Uint8Array(n);
  let k = 0;
  for (const p of ps) {
    o.set(p, k);
    k += p.length;
  }
  return o;
};

// --- caminho feliz --------------------------------------------------

const creds = initAuthCreds();
const fx = makePairSuccess(creds, C, { jid: "5511988887777:19@s.whatsapp.net", keyIndex: 2 });

const res = configureSuccessfulPairing(fx.stanza, creds, C);

ok("devolve um <iq type=result>", res.reply.tag === "iq" && res.reply.attrs.type === "result");
ok("mantém o id do <iq>", res.reply.attrs.id === "pair-1");
ok("<iq> endereçado a s.whatsapp.net", res.reply.attrs.to === "@s.whatsapp.net");

const sign = getBinaryNodeChild(res.reply, "pair-device-sign");
const devIdent = getBinaryNodeChild(sign, "device-identity");
ok("tem <pair-device-sign><device-identity>", !!devIdent);
ok("key-index bate com o do servidor", devIdent?.attrs["key-index"] === "2");

// A identidade da resposta: reassinada, SEM accountSignatureKey.
const replyBytes = devIdent!.content as Uint8Array;
const replyIdent = decodeSignedDeviceIdentity(replyBytes);
ok("resposta sem accountSignatureKey", !replyIdent.accountSignatureKey);
ok("resposta tem deviceSignature (64B)", replyIdent.deviceSignature?.length === 64);
ok(
  "resposta preserva os details da conta",
  !!replyIdent.details.length &&
    decodeDeviceIdentity(replyIdent.details).keyIndex === 2,
);

// A deviceSignature tem que fechar:  verify(idPub, 0x06 0x01 || details || idPub || accSigKey)
const idPub = creds.signedIdentityKey.publicKey;
const deviceMsg = cat(Uint8Array.from([6, 1]), fx.accountDetails, idPub, fx.accountKey.publicKey);
ok(
  "deviceSignature verifica sob a identidade do cliente",
  C.verify(idPub, deviceMsg, replyIdent.deviceSignature!),
);

// --- patch de credenciais ----------------------------------------

ok("creds.me.id = jid do <device>", res.creds.me?.id === "5511988887777:19@s.whatsapp.net");
ok("creds.me.name vem do <biz>", res.creds.me?.name === "Conta de Teste");
ok("creds.registered = true", res.creds.registered === true);
ok("creds.platform = <platform name>", res.creds.platform === "oniwalib-mock");
ok("creds.account guardado", !!res.creds.account);
ok(
  "signalIdentities: 1 entrada, com a chave da conta prefixada 0x05",
  res.creds.signalIdentities?.length === 1 &&
    res.creds.signalIdentities[0]!.identifierKey.length === 33 &&
    res.creds.signalIdentities[0]!.identifierKey[0] === 5 &&
    res.creds.signalIdentities[0]!.identifier.name === "5511988887777:19@s.whatsapp.net",
);

// --- rejeições --------------------------------------------------

const creds2 = initAuthCreds();
let threwHmac = false;
try {
  configureSuccessfulPairing(makePairSuccess(creds2, C, { breakHmac: true }).stanza, creds2, C);
} catch {
  threwHmac = true;
}
ok("rejeita HMAC de identidade errado", threwHmac);

const creds3 = initAuthCreds();
let threwSig = false;
try {
  configureSuccessfulPairing(
    makePairSuccess(creds3, C, { breakAccountSig: true }).stanza,
    creds3,
    C,
  );
} catch {
  threwSig = true;
}
ok("rejeita assinatura de conta inválida", threwSig);

// HMAC é ligado ao advSecretKey certo: creds diferente não valida.
const credsA = initAuthCreds();
const credsB = initAuthCreds();
let threwWrongCreds = false;
try {
  configureSuccessfulPairing(makePairSuccess(credsA, C).stanza, credsB, C);
} catch {
  threwWrongCreds = true;
}
ok("rejeita <pair-success> de outro advSecretKey", threwWrongCreds);

void b64decode;

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/pairing [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
