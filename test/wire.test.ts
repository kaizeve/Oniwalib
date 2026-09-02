// Codec protobuf: vetores conhecidos + round-trips, e o HandshakeMessage real.

import { Reader, Writer } from "../src/proto/wire";
import { decodeHandshake, encodeHandshake } from "../src/noise/wire";
import { encodeClientPayload } from "../src/proto/client-payload";
import { buildClientPayload } from "../src/proto/handshake";
import { memoryAuthState } from "../src/auth/state";
import { MODIFIED } from "../src/profiles/index";
import { crypto } from "../src/crypto";

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
const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

// --- vetores conhecidos do wire format --------------------------------
// field 1, varint 150 → 08 96 01  (exemplo canônico da doc do protobuf)
ok("varint 150 no campo 1", hex(new Writer().uint(1, 150).finish()) === "089601");
// field 1, string "testing" → 0a 07 74 65 73 74 69 6e 67
ok(
  "string no campo 1",
  hex(new Writer().string(1, "testing").finish()) === "0a0774657374696e67",
);
// field 2, bool true → 10 01
ok("bool true no campo 2", hex(new Writer().bool(2, true).finish()) === "1001");
// zero/false/vazio não emitem nada (proto3)
ok("zero não emite", new Writer().uint(1, 0).bool(2, false).string(3, "").finish().length === 0);

// --- round-trips --------------------------------------------------
{
  const w = new Writer()
    .uint(1, 5511999999999)
    .bool(3, true)
    .string(4, "acentuação 🔌")
    .bytes(5, Uint8Array.from([0, 1, 254, 255]));
  const f = new Reader(w.finish()).fields();
  ok("uint grande (nº de telefone)", f.get(1)?.[0] === 5511999999999);
  ok("bool", f.get(3)?.[0] === 1);
  ok(
    "bytes preservados",
    hex(f.get(5)?.[0] as Uint8Array) === "0001feff",
  );
  ok("string ausente = campo ausente", f.get(2) === undefined);
}

// --- HandshakeMessage real -------------------------------------
{
  const eph = C.randomBytes(32);
  const stat = C.randomBytes(48);
  const payload = C.randomBytes(120);

  const ch = encodeHandshake({ clientHello: { ephemeral: eph } });
  const chBack = decodeHandshake(ch);
  ok("clientHello.ephemeral round-trip", hex(chBack.clientHello!.ephemeral!) === hex(eph));
  ok("clientHello sem serverHello", chBack.serverHello === undefined);

  const sh = encodeHandshake({
    serverHello: { ephemeral: eph, static: stat, payload },
  });
  const shBack = decodeHandshake(sh);
  ok("serverHello.static round-trip", hex(shBack.serverHello!.static!) === hex(stat));
  ok("serverHello.payload round-trip", hex(shBack.serverHello!.payload!) === hex(payload));

  const cf = encodeHandshake({ clientFinish: { static: stat, payload } });
  const cfBack = decodeHandshake(cf);
  ok("clientFinish.static round-trip", hex(cfBack.clientFinish!.static!) === hex(stat));
  ok("clientFinish.payload round-trip", hex(cfBack.clientFinish!.payload!) === hex(payload));

  // tag correta: HandshakeMessage.serverHello é o campo 3
  ok("serverHello usa o campo 3", (sh[0]! >> 3) === 3);
}

// --- ClientPayload de registro → protobuf ----------------------
{
  const { creds } = memoryAuthState();
  const cp = buildClientPayload(creds, MODIFIED);
  const bytes = encodeClientPayload(cp);
  ok("ClientPayload serializa e não é vazio", bytes.length > 50);

  // Parse genérico: os campos de topo esperados aparecem.
  const f = new Reader(bytes).fields();
  // WAProto é proto2/optional: passive=false vai no fio explícito (18 00),
  // como a Baileys manda.
  ok("passive escrito explícito (proto2)", f.get(3)?.[0] === 0);
  ok("userAgent presente (campo 5, sub-mensagem)", f.get(5)?.[0] instanceof Uint8Array);
  ok("connectType presente (campo 12, valor 1)", f.get(12)?.[0] === 1);
  ok("connectReason presente (campo 13, valor 1)", f.get(13)?.[0] === 1);
  ok("regData presente (campo 19)", f.get(19)?.[0] instanceof Uint8Array);

  // O userAgent decodifica e traz a versão do profile.
  const ua = new Reader(f.get(5)![0] as Uint8Array).fields();
  const appVer = new Reader(ua.get(2)![0] as Uint8Array).fields();
  ok("appVersion.primary = profile.waVersion[0]", appVer.get(1)?.[0] === MODIFIED.waVersion[0]);

  // regData: eRegid tem 4 bytes, eKeytype é 0x05.
  const rd = new Reader(f.get(19)![0] as Uint8Array).fields();
  ok("regData.eRegid 4 bytes", (rd.get(1)?.[0] as Uint8Array)?.length === 4);
  ok("regData.eKeytype = 0x05", (rd.get(2)?.[0] as Uint8Array)?.[0] === 0x05);
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/wire [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
