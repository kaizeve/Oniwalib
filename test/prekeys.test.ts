// Pré-chaves — geração + o <iq xmlns="encrypt"> de upload.

import { memoryAuthState } from "../src/auth/state";
import { crypto } from "../src/crypto";
import {
  generateOrGetPreKeys,
  buildPreKeyUploadNode,
  buildPreKeyFetchNode,
  parsePreKeyBundles,
} from "../src/signal/prekeys";
import { getBinaryNodeChild, getBinaryNodeChildren, node } from "../src/frame/node";

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

// --- fetch: nó de get ------------------------------------------------
{
  const iq = buildPreKeyFetchNode(["55119@s.whatsapp.net", "55119:23@s.whatsapp.net"]);
  ok("fetch: iq get / xmlns encrypt / to s.whatsapp.net",
    iq.tag === "iq" && iq.attrs.type === "get" && iq.attrs.xmlns === "encrypt" && iq.attrs.to === "@s.whatsapp.net");
  const users = getBinaryNodeChildren(getBinaryNodeChild(iq, "key"), "user");
  ok("fetch: 2 <user jid>", users.length === 2 && users[1]?.attrs.jid === "55119:23@s.whatsapp.net");
}

// --- fetch: parse do <list><user> ---------------------------------
{
  const be = (n: number, len: number) => {
    const a = new Uint8Array(len);
    let r = n;
    for (let i = len - 1; i >= 0; i--) { a[i] = r & 0xff; r = Math.floor(r / 256); }
    return a;
  };
  const b = (len: number, fill: number) => new Uint8Array(len).fill(fill);
  const result = node("iq", { type: "result" }, [
    node("list", {}, [
      node("user", { jid: "55119:0@s.whatsapp.net" }, [
        node("registration", {}, be(4242, 4)),
        node("type", {}, Uint8Array.from([5])),
        node("identity", {}, b(32, 0xaa)),
        node("skey", {}, [
          node("id", {}, be(7, 3)),
          node("value", {}, b(32, 0xbb)),
          node("signature", {}, b(64, 0xcc)),
        ]),
        node("key", {}, [node("id", {}, be(99, 3)), node("value", {}, b(32, 0xdd))]),
      ]),
      node("user", { jid: "55119:1@s.whatsapp.net" }, [node("error", { code: "503" })]),
    ]),
  ]);
  const bundles = parsePreKeyBundles(result);
  const d0 = bundles["55119:0@s.whatsapp.net"];
  ok("parse: device 0 presente", !!d0);
  ok("parse: registrationId BE", d0?.registrationId === 4242);
  ok("parse: identityKey prefixado 0x05 (33B)",
    d0?.identityKey.length === 33 && d0?.identityKey[0] === 5 && d0?.identityKey[1] === 0xaa);
  ok("parse: signedPreKey keyId + 33B + sig 64B",
    d0?.signedPreKey.keyId === 7 && d0?.signedPreKey.publicKey.length === 33 && d0?.signedPreKey.signature.length === 64);
  ok("parse: one-time preKey keyId 99 + 33B", d0?.preKey?.keyId === 99 && d0?.preKey?.publicKey.length === 33);
  ok("parse: device com <error> fica de fora", !bundles["55119:1@s.whatsapp.net"]);
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
