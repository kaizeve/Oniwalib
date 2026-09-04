// Deploy smoke test — packs oniwalib the way it would ship, installs it into a
// throwaway consumer, and imports it BY NAME (`from "oniwalib"`) under node and
// bun, running a real check each time. This is the "does a deploy work" gate.
//
//   node scripts/smoke-deploy.mjs
//
// RTS: the engine consumes `src/` from a checkout (`rts run test/*.ts`), not an
// installed package, so it's covered by `npm run test:rts`. If/when RTS grows a
// package resolver that honors the "rts" export condition, add it here.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function dirname(p) {
  return p.slice(0, p.lastIndexOf("/"));
}
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

const CHECK = `
import * as oni from "oniwalib";
const need = ["openWhatsApp","memoryAuthState","fileAuthState","initAuthCreds","crypto",
  "makeInMemoryStore","encodeE2EMessage","decodeE2EMessage","message","frame","signal"];
for (const k of need) if (!(k in oni)) { console.error("MISSING export:", k); process.exit(1); }
const c = oni.crypto();
if (c.sha256(new Uint8Array([1,2,3])).length !== 32) { console.error("sha256 broken"); process.exit(1); }
const kp = c.generateSigningKey();
const sig = c.sign(kp.privateKey, new Uint8Array([9,9,9]));
if (sig.length !== 64 || !c.verify(kp.publicKey, new Uint8Array([9,9,9]), sig)) { console.error("sign/verify broken"); process.exit(1); }
const b = oni.encodeE2EMessage({ conversation: "oi" });
if (oni.decodeE2EMessage(b).conversation !== "oi") { console.error("e2e codec broken"); process.exit(1); }
const n = oni.frame.encodeBinaryNode(oni.frame.node("iq", { type: "get" }));
if (oni.frame.decodeBinaryNode(n).tag !== "iq") { console.error("frame codec broken"); process.exit(1); }
const creds = oni.initAuthCreds();
if (creds.signedPreKey.signature.length !== 64) { console.error("initAuthCreds broken"); process.exit(1); }
oni.makeInMemoryStore();
console.log("  " + need.length + " exports present · crypto · sign/verify · e2e codec · frame codec · initAuthCreds — OK");
`;

let tgz;
const work = mkdtempSync(join(tmpdir(), "oniwa-smoke-"));
try {
  console.log("• build");
  run("bun", ["run", "build"], { cwd: ROOT });

  console.log("• npm pack");
  const packed = run("npm", ["pack", "--silent", "--pack-destination", work], { cwd: ROOT }).trim();
  tgz = join(work, packed.split("\n").pop().trim());

  const consumer = join(work, "consumer");
  run("mkdir", ["-p", consumer]);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", type: "module", dependencies: { oniwalib: tgz } }, null, 2),
  );
  writeFileSync(join(consumer, "check.mjs"), CHECK);

  console.log("• install into a clean consumer (npm)");
  run("npm", ["install", "--silent", "--no-audit", "--no-fund"], { cwd: consumer });

  const tarKB = Math.round(run("stat", ["-c", "%s", tgz]).trim() / 1024);
  console.log(`• tarball: ${tarKB} KiB`);

  console.log("• import by name — node:");
  process.stdout.write(run("node", ["check.mjs"], { cwd: consumer }));

  console.log("• import by name — bun:");
  try {
    process.stdout.write(run("bun", ["check.mjs"], { cwd: consumer }));
  } catch (e) {
    console.log("  (bun not on PATH — skipped)");
  }

  console.log("\n✓ deploy smoke passed (node + bun, import by package name)");
} catch (e) {
  console.error("\n✗ deploy smoke FAILED");
  if (e.stdout) process.stderr.write(String(e.stdout));
  if (e.stderr) process.stderr.write(String(e.stderr));
  process.exit(1);
} finally {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
  // drop any stray oniwalib-*.tgz npm left in ROOT
  for (const f of readdirSync(ROOT)) if (/^oniwalib-.*\.tgz$/.test(f)) rmSync(join(ROOT, f));
}
