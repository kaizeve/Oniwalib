// Pré-chaves — geração + o <iq xmlns="encrypt"> de upload.

import { memoryAuthState } from "../src/auth/state";
import { crypto } from "../src/crypto";
import { generateOrGetPreKeys, buildPreKeyUploadNode } from "../src/signal/prekeys";
import { getBinaryNodeChild, getBinaryNodeChildren } from "../src/frame/node";

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

// --- geração avança os contadores ----------------------------------
{
  const { creds } = memoryAuthState(); // nextPreKeyId=2, firstUnuploadedPreKeyId=2
  const { newPreKeys, lastPreKeyId, preKeysRange } = generateOrGetPreKeys(creds, 5, C);
  ok("gera 5 pré-chaves", Object.keys(newPreKeys).length === 5, `${Object.keys(newPreKeys)}`);
  ok("ids 2..6", !!newPreKeys[2] && !!newPreKeys[6] && !newPreKeys[7]);
  ok("lastPreKeyId = 6", lastPreKeyId === 6);
  ok("preKeysRange = [2,5]", preKeysRange[0] === 2 && preKeysRange[1] === 5);
  ok("cada par tem public/private de 32 bytes", newPreKeys[2]!.public.length === 32 && newPreKeys[2]!.private.length === 32);
}

// --- nó de upload -------------------------------------------------
{
  const auth = memoryAuthState();
  const { node, update, count } = await buildPreKeyUploadNode(auth, 5, C);
  ok("tag iq", node.tag === "iq");
  ok("xmlns=encrypt type=set", node.attrs.xmlns === "encrypt" && node.attrs.type === "set");
  ok("count = 5", count === 5);

  const reg = getBinaryNodeChild(node, "registration");
  ok("<registration> 4 bytes BE", reg?.content instanceof Uint8Array && (reg.content as Uint8Array).length === 4);
  const type = getBinaryNodeChild(node, "type");
  ok("<type> = 0x05", type?.content instanceof Uint8Array && (type.content as Uint8Array)[0] === 5);
  const ident = getBinaryNodeChild(node, "identity");
  ok("<identity> 32 bytes", ident?.content instanceof Uint8Array && (ident.content as Uint8Array).length === 32);

  const list = getBinaryNodeChild(node, "list");
  const keyNodes = getBinaryNodeChildren(list, "key");
  ok("<list> tem 5 <key>", keyNodes.length === 5);
  const first = keyNodes[0]!;
  const id0 = getBinaryNodeChild(first, "id");
  const val0 = getBinaryNodeChild(first, "value");
  ok("<key><id> 3 bytes BE", id0?.content instanceof Uint8Array && (id0.content as Uint8Array).length === 3);
  ok("<key><value> 32 bytes", val0?.content instanceof Uint8Array && (val0.content as Uint8Array).length === 32);

  const skey = getBinaryNodeChild(node, "skey");
  ok("<skey><signature> 64 bytes", (getBinaryNodeChild(skey, "signature")?.content as Uint8Array)?.length === 64);

  ok("update.nextPreKeyId = 7", update.nextPreKeyId === 7);
  ok("update.firstUnuploadedPreKeyId = 7", update.firstUnuploadedPreKeyId === 7);

  // as pré-chaves ficaram no cofre
  const stored = await auth.keys.get("pre-key", ["2", "6"]);
  ok("pré-chaves persistidas no cofre", !!stored["2"] && !!stored["6"]);
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/prekeys [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
