// SenderKey — a cifra de grupo (src/signal/sender-key.ts). Duas partes em
// memória: Alice distribui o SKDM e publica; Bob processa e decifra. Cobre
// ordem, fora de ordem, assinatura inválida e round-trip da serialização.

import { crypto } from "../src/crypto";
import {
  SenderKeyRecord,
  createSenderKeyDistribution,
  processSenderKeyDistribution,
  groupEncrypt,
  groupDecrypt,
} from "../src/signal/sender-key";

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
const enc = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
const dec = (u: Uint8Array) => String.fromCharCode(...u);
// Padding estilo WhatsApp: 1..16 bytes, todos iguais ao tamanho do padding.
// O cipher de grupo não pada — quem chama pada, igual ao `messages.ts`.
const pad16 = (u: Uint8Array) => {
  const p = (u.length % 15) + 1;
  const out = new Uint8Array(u.length + p);
  out.set(u);
  out.fill(p, u.length);
  return out;
};
const unpad = (u: Uint8Array) => u.subarray(0, u.length - u[u.length - 1]!);

// --- distribuição + primeira mensagem --------------------------------
const alice = new SenderKeyRecord();
const skdm = createSenderKeyDistribution(C, alice);
ok("SKDM tem bytes", skdm.length > 40);
ok("Alice tem estado próprio", !alice.isEmpty());

const bob = new SenderKeyRecord();
processSenderKeyDistribution(bob, skdm);
ok("Bob não está mais vazio", !bob.isEmpty());

{
  const ct = groupEncrypt(C, alice, pad16(enc("oi grupo")));
  const pt = unpad(groupDecrypt(C, bob, ct));
  ok("Bob decifra a 1ª", dec(pt) === "oi grupo", dec(pt));
}

// --- várias em ordem ------------------------------------------------
for (let i = 0; i < 5; i++) {
  const ct = groupEncrypt(C, alice, pad16(enc(`msg ${i}`)));
  const pt = unpad(groupDecrypt(C, bob, ct));
  ok(`ordem: msg ${i}`, dec(pt) === `msg ${i}`, dec(pt));
}

// --- fora de ordem -------------------------------------------------
{
  const a = groupEncrypt(C, alice, pad16(enc("A")));
  const b = groupEncrypt(C, alice, pad16(enc("B")));
  const c2 = groupEncrypt(C, alice, pad16(enc("C")));
  ok("fora de ordem: C primeiro", dec(unpad(groupDecrypt(C, bob, c2))) === "C");
  ok("fora de ordem: A depois (message key guardada)", dec(unpad(groupDecrypt(C, bob, a))) === "A");
  ok("fora de ordem: B depois", dec(unpad(groupDecrypt(C, bob, b))) === "B");
}

// --- replay de uma iteração já consumida falha --------------------
{
  const x = groupEncrypt(C, alice, pad16(enc("once")));
  ok("consome uma vez", dec(unpad(groupDecrypt(C, bob, x))) === "once");
  let threw = "";
  try {
    groupDecrypt(C, bob, x);
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("replay da mesma iteração lança", threw.includes("velha demais"), threw);
}

// --- assinatura adulterada é rejeitada ---------------------------
{
  const ct = groupEncrypt(C, alice, pad16(enc("assinado")));
  const tampered = ct.slice();
  tampered[tampered.length - 1] ^= 0x01; // mexe no último byte da assinatura
  let threw = "";
  try {
    groupDecrypt(C, bob, tampered);
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("assinatura inválida lança", threw.includes("assinatura"), threw);
}

// --- estado desconhecido (SKDM não chegou) ----------------------
{
  const stranger = new SenderKeyRecord();
  const other = new SenderKeyRecord();
  createSenderKeyDistribution(C, stranger);
  const ct = groupEncrypt(C, stranger, pad16(enc("?")));
  let threw = "";
  try {
    groupDecrypt(C, other, ct);
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("sem estado → erro claro", threw.includes("sem estado"), threw);
}

// --- serialização round-trip ----------------------------------
{
  const raw = JSON.parse(JSON.stringify(bob.serialize()));
  const revived = SenderKeyRecord.deserialize(raw);
  const ct = groupEncrypt(C, alice, pad16(enc("depois do save")));
  ok("record revivido decifra", dec(unpad(groupDecrypt(C, revived, ct))) === "depois do save");
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/sender-key [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
