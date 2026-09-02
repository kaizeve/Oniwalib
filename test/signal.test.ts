// Camada Signal 1:1 — vetores cruzados, SEM servidor. Dois cofres em memória
// (Alice/Bob): um lado cifra, o outro decifra. Cobre X3DH (pkmsg), ida e volta,
// re-key após troca, fora de ordem (skipped keys) e o round-trip de
// serialização (todo encrypt/decrypt grava e relê o SessionRecord).

import { memoryAuthState } from "../src/auth/state";
import { crypto } from "../src/crypto";
import {
  makeCurve,
  makeSignalStorage,
  prefixKey,
  initOutgoing,
  encrypt,
  decryptWhisperMessage,
  decryptPreKeyWhisperMessage,
  type PreKeyBundle,
  type SignalDeps,
} from "../src/signal/index";

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

const bytes = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));
const str = (u: Uint8Array) => String.fromCharCode(...u);

function party(): { auth: ReturnType<typeof memoryAuthState>; deps: SignalDeps } {
  const auth = memoryAuthState();
  return { auth, deps: { c: C, curve: makeCurve(C), storage: makeSignalStorage(auth) } };
}

async function bundleFor(
  auth: ReturnType<typeof memoryAuthState>,
  preKeyId: number,
): Promise<PreKeyBundle> {
  const kp = C.generateX25519();
  await auth.keys.set({
    "pre-key": { [String(preKeyId)]: { public: kp.publicKey, private: kp.privateKey } },
  });
  return {
    registrationId: auth.creds.registrationId,
    identityKey: prefixKey(auth.creds.signedIdentityKey.publicKey),
    signedPreKey: {
      keyId: auth.creds.signedPreKey.keyId,
      publicKey: prefixKey(auth.creds.signedPreKey.keyPair.publicKey),
      signature: auth.creds.signedPreKey.signature,
    },
    preKey: { keyId: preKeyId, publicKey: prefixKey(kp.publicKey) },
  };
}

// --- fluxo completo ---------------------------------------------------
{
  const alice = party();
  const bob = party();
  const A = "bob.0"; // endereço de Bob no cofre da Alice
  const B = "alice.0"; // endereço da Alice no cofre do Bob

  const bobBundle = await bundleFor(bob.auth, 31337);
  await initOutgoing(alice.deps, A, bobBundle);

  // msg 1 e 2 — pkmsg (Alice ainda tem pendingPreKey)
  const e1 = await encrypt(alice.deps, A, bytes("oi bob"));
  ok("msg1 é pkmsg", e1.type === 3, `type=${e1.type}`);
  ok("msg1 decifra no Bob", str(await decryptPreKeyWhisperMessage(bob.deps, B, e1.body)) === "oi bob");

  const e2 = await encrypt(alice.deps, A, bytes("tudo bem?"));
  ok("msg2 ainda pkmsg", e2.type === 3);
  ok("msg2 decifra no Bob", str(await decryptPreKeyWhisperMessage(bob.deps, B, e2.body)) === "tudo bem?");

  // Bob responde — "msg" normal
  const r1 = await encrypt(bob.deps, B, bytes("e ai alice"));
  ok("resposta do Bob é msg (não pkmsg)", r1.type === 1, `type=${r1.type}`);
  ok("resposta decifra na Alice", str(await decryptWhisperMessage(alice.deps, A, r1.body)) === "e ai alice");

  // Alice manda de novo — pendingPreKey já limpo → msg normal, novo ratchet
  const e3 = await encrypt(alice.deps, A, bytes("de novo"));
  ok("msg3 não é mais pkmsg", e3.type === 1, `type=${e3.type}`);
  ok("msg3 decifra no Bob", str(await decryptWhisperMessage(bob.deps, B, e3.body)) === "de novo");

  // fora de ordem: Alice manda 4 e 5, Bob decifra 5 antes de 4
  const e4 = await encrypt(alice.deps, A, bytes("quatro"));
  const e5 = await encrypt(alice.deps, A, bytes("cinco"));
  ok("msg5 decifra primeiro", str(await decryptWhisperMessage(bob.deps, B, e5.body)) === "cinco");
  ok("msg4 decifra depois (skipped key)", str(await decryptWhisperMessage(bob.deps, B, e4.body)) === "quatro");

  // várias trocas seguidas — força ratchets repetidos nos dois sentidos
  let okPingPong = true;
  for (let i = 0; i < 12; i++) {
    const q = await encrypt(alice.deps, A, bytes(`ping ${i}`));
    if (str(await decryptWhisperMessage(bob.deps, B, q.body)) !== `ping ${i}`) okPingPong = false;
    const p = await encrypt(bob.deps, B, bytes(`pong ${i}`));
    if (str(await decryptWhisperMessage(alice.deps, A, p.body)) !== `pong ${i}`) okPingPong = false;
  }
  ok("12 rodadas de ping-pong com re-key", okPingPong);
}

// --- pkmsg sem one-time prekey (bundle só com signedPreKey) ----------
{
  const alice = party();
  const bob = party();
  const A = "bob.0";
  const B = "alice.0";
  const bundle: PreKeyBundle = {
    registrationId: bob.auth.creds.registrationId,
    identityKey: prefixKey(bob.auth.creds.signedIdentityKey.publicKey),
    signedPreKey: {
      keyId: bob.auth.creds.signedPreKey.keyId,
      publicKey: prefixKey(bob.auth.creds.signedPreKey.keyPair.publicKey),
      signature: bob.auth.creds.signedPreKey.signature,
    },
  };
  await initOutgoing(alice.deps, A, bundle);
  const e = await encrypt(alice.deps, A, bytes("sem otk"));
  ok("pkmsg sem one-time prekey decifra", str(await decryptPreKeyWhisperMessage(bob.deps, B, e.body)) === "sem otk");
}

// --- MAC ruim é rejeitado -------------------------------------------
{
  const alice = party();
  const bob = party();
  const A = "bob.0";
  const B = "alice.0";
  await initOutgoing(alice.deps, A, await bundleFor(bob.auth, 7));
  const e = await encrypt(alice.deps, A, bytes("intacto"));
  await decryptPreKeyWhisperMessage(bob.deps, B, e.body);
  const r = await encrypt(bob.deps, B, bytes("resposta intacta")); // "msg" type 1: [ver][proto][mac8]
  const tampered = r.body.slice();
  tampered[tampered.length - 1] ^= 0xff; // corrompe o último byte do MAC
  let threw = false;
  try {
    await decryptWhisperMessage(alice.deps, A, tampered);
  } catch {
    threw = true;
  }
  ok("MAC corrompido é rejeitado", threw);
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/signal [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
