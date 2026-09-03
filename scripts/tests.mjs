// Roda a suíte inteira e, quando tudo passa no bun, sincroniza a contagem de
// testes no README (o badge e a seção "Tests"). É o runner de `npm test` e
// `npm run test:rts`.
//
//   node scripts/tests.mjs          # bun  (+ atualiza o README)
//   node scripts/tests.mjs --rts    # RTS  (só roda e reporta, não mexe no README)
//
// Sem dependências: só `node:child_process` e `node:fs`.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// A mesma ordem de sempre. Editar aqui é editar a suíte.
const FILES = [
  "version", "wire", "wabinary", "jid", "e2e-message", "crypto", "noise", "auth",
  "file-state", "socket", "signal", "lid", "sender-key", "prekeys", "messages", "media",
  "profile", "privacy", "usync", "groups", "appstate", "channels", "reaction", "presence",
  "calls", "blocklist", "notifications", "bot", "pairing", "client",
];

const rts = process.argv.includes("--rts");
const label = rts ? "rts" : "bun";
const run = (f) =>
  rts
    ? spawnSync("../rts/target/fast/rts", ["run", `test/${f}.test.ts`], { cwd: ROOT, encoding: "utf8" })
    : spawnSync("bun", [`test/${f}.test.ts`], { cwd: ROOT, encoding: "utf8" });

const SUMMARY = /oniwalib\/[\w-]+ \[\w+\]\s+(\d+) pass, (\d+) fail/;

const counts = {};
let totalPass = 0;
let broke = false;

for (const f of FILES) {
  const r = run(f);
  const out = (r.stdout || "") + (r.stderr || "");
  process.stdout.write(out.trimEnd() + "\n");
  const m = out.match(SUMMARY);
  if (r.status !== 0 || !m || Number(m[2]) > 0) {
    broke = true;
    if (!m) console.error(`  ✗ ${f}: sem linha de resumo (status ${r.status})`);
    continue;
  }
  counts[f] = Number(m[1]);
  totalPass += Number(m[1]);
}

console.log(`\n──────────\ntotal [${label}]  ${totalPass} pass` + (broke ? "  ·  SUÍTE VERMELHA" : ""));

if (broke) process.exit(1);
if (rts) process.exit(0); // RTS roda um subconjunto — o README fala do bun

// --- sincroniza o README -------------------------------------------------
const path = join(ROOT, "README.md");
let readme = readFileSync(path, "utf8");
const before = readme;

// badge: tests-<n>%2F<n>%20passing
readme = readme.replace(/tests-\d+(?:%2F|\/)\d+%20passing/g, `tests-${totalPass}%2F${totalPass}%20passing`);

// contagens por arquivo na prosa: `nome` 28  →  `nome` <novo>
for (const [f, n] of Object.entries(counts)) {
  readme = readme.replace(new RegExp("(`" + f.replace(/[-]/g, "\\$&") + "`)\\s+\\d+"), `$1 ${n}`);
}

// total: "233 / 233 on bun"
readme = readme.replace(/\d+ \/ \d+ on bun/g, `${totalPass} / ${totalPass} on bun`);

if (readme !== before) {
  writeFileSync(path, readme);
  console.log(`README sincronizado → ${totalPass}/${totalPass} on bun`);
} else {
  console.log(`README já em ${totalPass}/${totalPass} on bun`);
}
