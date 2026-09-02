// reviveqr — ressuscita a sessão do bot quando ela entra em parafuso (loop de
// upload de pré-chave, `auth.owl` inchando, envio de grupo saindo com "SKDM p/
// 0 device(s)", contato preso no "aguarde…").
//
//   npm run reviveqr                 # padrão: limpa pre-key/session/sender-key
//                                    # e zera os contadores de prekey nas creds.
//                                    # MANTÉM identidade + pareamento (sem QR).
//   npm run reviveqr -- --prekeys    # conservador: só os registros pre-key + contadores
//   npm run reviveqr -- --wipe       # nuclear: move oni-auth/ pra um .bak → QR novo no próximo boot
//   npm run reviveqr -- --dry        # só conta os registros vivos, não escreve nada
//
//   flags extras:
//     --path <arquivo>   default ./oni-auth/auth.owl
//     --restart          para o oni-bot (pm2) antes, sobe depois
//     --yes | -y         não pergunta
//     --force            deixa mexer no arquivo mesmo com o oni-bot online
//
// Sem dependências: só `node:*`. Espelha o formato de src/auth/file-state.ts
// (magic "OWL1", recLen be32, cada registro cifrado sozinho em AES-256-GCM,
// AAD = type ++ 0x00 ++ id, tag de 16 bytes colada no fim do ciphertext).

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as readline from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const MAGIC = Buffer.from([0x4f, 0x57, 0x4c, 0x31]); // "OWL1"
const NONCE = 12;
const TAG = 16;

// pre-key: os lotes de pré-chave 1:1. session: sessões Signal pairwise (voltam
// sozinhas quando o outro lado te manda um pkmsg). sender-key / -memory: chaves
// de grupo (voltam no próximo SKDM). identity-key e app-state-sync-* ficam.
const KEYS_MODE = new Set(["pre-key", "session", "sender-key", "sender-key-memory"]);
const PREKEYS_MODE = new Set(["pre-key"]);

// --- args --------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const mode = has("--wipe") ? "wipe" : has("--prekeys") ? "prekeys" : "keys";
const dry = has("--dry");
const AUTH_PATH = resolve(ROOT, valOf("--path") ?? "./oni-auth/auth.owl");
const doRestart = has("--restart");
const assumeYes = has("--yes") || has("-y");
const force = has("--force");

// --- pm2 guard -------------------------------------------------------------
function pm2Status() {
  const r = spawnSync("npx", ["--yes", "pm2", "jlist"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) return null;
  try {
    const p = JSON.parse(r.stdout).find((x) => x.name === "oni-bot");
    return p ? p.pm2_env.status : null;
  } catch {
    return null;
  }
}
function pm2(action) {
  console.log(`  pm2 ${action} oni-bot`);
  spawnSync("npx", ["--yes", "pm2", action, "oni-bot"], { cwd: ROOT, encoding: "utf8", stdio: "ignore" });
}

// --- chave mestra (espelha resolveKey de file-state.ts) --------------------
function resolveKey(path) {
  const env = process.env.ONIWA_STORE_KEY;
  if (env) {
    const raw = /^[0-9a-fA-F]{64}$/.test(env)
      ? Buffer.from(env, "hex")
      : Buffer.from(env, "base64");
    if (raw.length !== 32) throw new Error("ONIWA_STORE_KEY não decodifica a 32 bytes");
    return raw;
  }
  const kp = path + ".key";
  if (!fs.existsSync(kp)) throw new Error(`sem keyfile ${kp} e sem ONIWA_STORE_KEY`);
  const raw = fs.readFileSync(kp);
  if (raw.length !== 32) throw new Error(`keyfile ${kp} corrompido (${raw.length} bytes)`);
  return raw;
}

const aad = (type, id) => Buffer.from(type + "\0" + id, "utf8");
function dec(key, nonce, ct, type, id) {
  const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(aad(type, id));
  d.setAuthTag(ct.subarray(ct.length - TAG));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - TAG)), d.final()]);
}
function enc(key, nonce, plain, type, id) {
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad(type, id));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

// --- leitura do log (espelha readLog, com o mesmo rigor: cauda torta OK,
//     corrupção no meio aborta) --------------------------------------------
function readLog(buf, key) {
  const recs = [];
  if (buf.length <= 4 || !buf.subarray(0, 4).equals(MAGIC)) {
    if (buf.length > 4) throw new Error("magic do arquivo não confere");
    return recs;
  }
  let o = 4;
  while (o + 4 <= buf.length) {
    const payloadLen = buf.readUInt32BE(o);
    if (payloadLen < 1 + 2 + NONCE) {
      if (o + 4 + payloadLen > buf.length) break; // cauda torta
      throw new Error(`recLen inválido no offset ${o}`);
    }
    if (o + 4 + payloadLen > buf.length) break; // registro não fecha → cauda torta
    const p0 = o + 4;
    let p = p0;
    const typeLen = buf[p++];
    if (p + typeLen + 2 > p0 + payloadLen) throw new Error(`typeLen estoura o payload no offset ${o}`);
    const type = buf.toString("utf8", p, p + typeLen);
    p += typeLen;
    const idLen = buf.readUInt16BE(p);
    p += 2;
    if (p + idLen + NONCE > p0 + payloadLen) throw new Error(`idLen estoura o payload no offset ${o}`);
    const id = buf.toString("utf8", p, p + idLen);
    p += idLen;
    const nonce = buf.subarray(p, p + NONCE);
    p += NONCE;
    const ct = buf.subarray(p, p0 + payloadLen);
    if (ct.length === 0) {
      recs.push({ type, id }); // tombstone
    } else {
      let plain;
      try {
        plain = dec(key, nonce, ct, type, id);
      } catch {
        throw new Error(`registro [${type}/${id}] não decifra (chave errada ou corrupção)`);
      }
      recs.push({ type, id, plain });
    }
    o = p0 + payloadLen;
  }
  return recs;
}

function frame(key, type, id, plain) {
  const typeB = Buffer.from(type, "utf8");
  const idB = Buffer.from(id, "utf8");
  const nonce = crypto.randomBytes(NONCE);
  const ct = enc(key, nonce, plain, type, id);
  const payloadLen = 1 + typeB.length + 2 + idB.length + NONCE + ct.length;
  const out = Buffer.alloc(4 + payloadLen);
  let w = 0;
  out.writeUInt32BE(payloadLen, w); w += 4;
  out.writeUInt8(typeB.length, w); w += 1;
  typeB.copy(out, w); w += typeB.length;
  out.writeUInt16BE(idB.length, w); w += 2;
  idB.copy(out, w); w += idB.length;
  nonce.copy(out, w); w += NONCE;
  ct.copy(out, w);
  return out;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function confirm(q) {
  if (assumeYes || !process.stdin.isTTY) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((res) => rl.question(`${q} [s/N] `, res));
  rl.close();
  return /^s(im)?$/i.test(a.trim());
}

// --- wipe ----------------------------------------------------------------
async function doWipe() {
  const dir = dirname(AUTH_PATH);
  if (!fs.existsSync(dir)) {
    console.log(`nada a fazer: ${dir} não existe`);
    return;
  }
  console.log(`--wipe: vai MOVER ${dir} → ${dir}.bak.${"<stamp>"} (o bot pede QR novo no próximo boot)`);
  if (!(await confirm("confirmar wipe?"))) return console.log("abortado.");
  const bak = `${dir}.bak.${stamp()}`;
  fs.renameSync(dir, bak);
  console.log(`ok. backup: ${bak}`);
  console.log("→ suba o bot e escaneie o QR: `npm run bot`  (ou `npm run bot:restart` se estiver no pm2)");
}

// --- surgery (keys / prekeys) ------------------------------------------
async function doSurgery() {
  if (!fs.existsSync(AUTH_PATH)) throw new Error(`não achei ${AUTH_PATH}`);
  const drop = mode === "prekeys" ? PREKEYS_MODE : KEYS_MODE;
  const key = resolveKey(AUTH_PATH);
  const buf = fs.readFileSync(AUTH_PATH);
  const recs = readLog(buf, key);

  // replay: última escrita vence, tombstone apaga
  const live = new Map();
  for (const r of recs) {
    const k = r.type + "\0" + r.id;
    if (r.plain === undefined) live.delete(k);
    else live.set(k, r);
  }

  const tally = (it) => {
    const t = {};
    for (const r of it) t[r.type] = (t[r.type] || 0) + 1;
    return t;
  };
  console.log(`arquivo: ${AUTH_PATH}  (${buf.length} bytes, ${recs.length} registros brutos)`);
  console.log("vivos por tipo:", tally(live.values()));

  let credsInfo;
  const cm = live.get("creds\0me");
  if (cm) {
    const o = JSON.parse(cm.plain.toString("utf8"));
    credsInfo = { registered: o.registered, me: o.me?.id, nextPreKeyId: o.nextPreKeyId, firstUnuploadedPreKeyId: o.firstUnuploadedPreKeyId };
    console.log("creds:", credsInfo);
  }

  const keep = [];
  let dropped = 0;
  for (const r of live.values()) {
    if (drop.has(r.type)) { dropped++; continue; }
    if (r.type === "creds" && r.id === "me") {
      const o = JSON.parse(r.plain.toString("utf8"));
      o.nextPreKeyId = 2;
      o.firstUnuploadedPreKeyId = 2;
      r.plain = Buffer.from(JSON.stringify(o), "utf8");
    }
    keep.push(r);
  }

  console.log(`\nmodo: ${mode}  →  descarta ${dropped} registros (${[...drop].join(", ")})`);
  console.log(`mantém ${keep.length} (${Object.entries(tally(keep)).map(([t, n]) => `${t}:${n}`).join(", ")})`);
  if (credsInfo) console.log("contadores de prekey nas creds → nextPreKeyId: 2, firstUnuploadedPreKeyId: 2");

  if (dry) return console.log("\n--dry: nada escrito.");
  if (!keep.some((r) => r.type === "creds" && r.id === "me")) {
    throw new Error("creds/me não está entre os vivos — abortando, nada escrito");
  }
  if (!(await confirm("\naplicar?"))) return console.log("abortado.");

  const blob = Buffer.concat([MAGIC, ...keep.map((r) => frame(key, r.type, r.id, r.plain))]);
  // auto-check: re-lê o que vamos gravar
  readLog(blob, key);

  const bak = `${AUTH_PATH}.bak.${stamp()}`;
  fs.copyFileSync(AUTH_PATH, bak);
  const tmp = `${AUTH_PATH}.reviveqr.${Date.now()}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, blob);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, AUTH_PATH);
  console.log(`\nok. ${buf.length} → ${blob.length} bytes.  backup: ${bak}`);
}

// --- main --------------------------------------------------------------
async function main() {
  const status = pm2Status();
  const online = status === "online";
  if (online && !doRestart && !force && !dry) {
    console.error(
      "oni-bot está ONLINE no pm2 — ele reescreve o auth.owl a cada reconexão e ia\n" +
        "atropelar esta cirurgia. Rode com --restart (paro e subo pra você) ou --force.",
    );
    process.exit(1);
  }

  if (online && doRestart) pm2("stop");
  try {
    if (mode === "wipe") await doWipe();
    else await doSurgery();
  } finally {
    if (online && doRestart) pm2("restart");
  }
  if (!doRestart && status) {
    console.log("\n→ reinicie o bot: `npm run bot:restart`  (ele reconecta sem QR nos modos keys/prekeys)");
  }
}

main().catch((e) => {
  console.error("reviveqr:", e.message);
  process.exit(1);
});
