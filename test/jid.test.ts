// Classificador de JID (src/frame/jid.ts): reconhece usuário, grupo/comunidade,
// canal (@newsletter), status, broadcast, lid, bot.

import {
  jidKind,
  isJidUser,
  isLidUser,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isJidBroadcast,
  isJidBot,
  jidDecode,
} from "../src/frame/jid";

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

const cases: [string, string][] = [
  ["5511999999999@s.whatsapp.net", "user"],
  ["5511999999999:12@s.whatsapp.net", "user"],
  ["5511999999999@c.us", "user"],
  ["18092345678@lid", "lid"],
  ["120363000000000001@g.us", "group"],
  ["120363000000000009@newsletter", "channel"],
  ["status@broadcast", "status"],
  ["1234567890-1234567890@broadcast", "broadcast"],
  ["12345@bot", "bot"],
  ["garbage", "unknown"],
  ["", "unknown"],
];
for (const [jid, kind] of cases) {
  ok(`jidKind("${jid}") = ${kind}`, jidKind(jid) === kind, jidKind(jid));
}
ok("jidKind(undefined) = unknown", jidKind(undefined) === "unknown");

ok("isJidUser só p/ s.whatsapp.net", isJidUser("5511@s.whatsapp.net") === true && !isJidUser("5511@lid"));
ok("isLidUser", isLidUser("5511@lid") === true && !isLidUser("5511@s.whatsapp.net"));
ok("isJidGroup", isJidGroup("x@g.us") === true && !isJidGroup("x@newsletter"));
ok("isJidNewsletter", isJidNewsletter("x@newsletter") === true && !isJidNewsletter("x@g.us"));
ok("isJidStatusBroadcast só o exato", isJidStatusBroadcast("status@broadcast") === true && !isJidStatusBroadcast("x@broadcast"));
ok("isJidBroadcast", isJidBroadcast("x@broadcast") === true);
ok("isJidBot", isJidBot("x@bot") === true && !isJidBot("x@s.whatsapp.net"));

// status@broadcast decodifica sem quebrar
ok("jidDecode(status@broadcast) tem server broadcast", jidDecode("status@broadcast")?.server === "broadcast");

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/jid [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
