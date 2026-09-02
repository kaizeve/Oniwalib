// fileAuthState — persistência das credenciais + cofre de chaves Signal em UM
// arquivo, criptografado em repouso.
//
// Por que não uma pasta com um arquivo por chave (estilo Baileys
// `useMultiFileAuthState`): conta ativa = milhares de arquivinhos, um
// `writeFile` + `JSON.stringify` por mutação, sem atomicidade e com corrida
// entre leitura e escrita do mesmo arquivo. Por que não um JSON gigante
// re-cifrado a cada `set`: O(n) por escrita e um crash no meio corrompe tudo.
//
// Aqui: LOG APPEND-ONLY. Cada `set(id, valor)` é um registro no fim do arquivo;
// escrita O(1), à prova de crash (registro final torto é descartado no load).
// Compactação reescreve o arquivo quando ele passa de ~2x o tamanho vivo.
// Cada registro é cifrado sozinho (AES-256-GCM) — dá pra ler uma chave sem
// decifrar o arquivo todo, e um registro corrompido não derruba os outros.
//
// Formato do arquivo:
//   magic        "OWL1"            (4 bytes, só no início)
//   registro*    recLen(4, BE) ++ payload(recLen)
//   payload      typeLen(1) ++ type ++ idLen(2, BE) ++ id ++ nonce(12) ++ (ct++tag)
//   tombstone    = registro com (ct++tag) de tamanho 0
//   AAD do GCM   = type ++ 0x00 ++ id   (prende o texto cifrado à sua chave)
//
// Este é um dos poucos módulos da lib que importa plataforma (`node:fs`),
// como `crypto/node-adapter.ts`. O núcleo continua sem tocar em fs.

import * as fs from "node:fs";
import { utf8Decode, utf8Encode } from "../frame/buffer";
import { crypto as defaultCrypto } from "../crypto";
import type { Crypto } from "../crypto/types";
import {
  initAuthCreds,
  b64,
  b64decode,
  type AuthCreds,
  type AuthenticationState,
  type SignalDataType,
  type SignalKeyStore,
} from "./state";

const MAGIC = new Uint8Array([0x4f, 0x57, 0x4c, 0x31]); // "OWL1"
const NONCE = 12;
const CREDS_TYPE = "creds" as const;

export interface FileAuthOptions {
  /** Chave mestra de 32 bytes. Sem isto: `ONIWA_STORE_KEY` (hex/base64 de 32
   *  bytes) ou um keyfile `<path>.key` criado com permissão 0600. */
  key?: Uint8Array;
  /** Adapter de cripto. Default: o global de `crypto()`. */
  crypto?: Crypto;
  /** Chama `fsync` a cada escrita (durabilidade > throughput). Default: false,
   *  como a Baileys. */
  fsync?: boolean;
  /** Compacta quando `tamanho do arquivo > factor * tamanho vivo` (e > 64 KiB).
   *  Default: 2. */
  compactionFactor?: number;
}

export interface FileAuthState {
  state: AuthenticationState;
  /** Persiste `state.creds`. Chame depois de qualquer mutação nas credenciais
   *  (pareamento, bump de registro, prekeys subidas). */
  saveCreds(): Promise<void>;
}

// --- (de)serialização de valores ----------------------------------------
// Uint8Array vira { __b: base64 }. Espelha o BufferJSON da Baileys o bastante
// pra o código Signal portado (chaves como bytes) sobreviver ao round-trip.

function encodeValue(v: unknown): Uint8Array {
  const json = JSON.stringify(v, (_k, val) => {
    if (val instanceof Uint8Array) return { __b: b64(val) };
    // Buffer já passado por toJSON: { type:'Buffer', data:[...] }
    if (val && val.type === "Buffer" && Array.isArray(val.data)) {
      return { __b: b64(Uint8Array.from(val.data)) };
    }
    return val;
  });
  return utf8Encode(json);
}

function decodeValue(bytes: Uint8Array): unknown {
  const json = utf8Decode(bytes);
  return JSON.parse(json, (_k, val) => {
    if (val && typeof val === "object" && typeof val.__b === "string") {
      return b64decode(val.__b);
    }
    return val;
  });
}

// --- chave mestra -------------------------------------------------------

function resolveKey(path: string, c: Crypto, explicit?: Uint8Array): Uint8Array {
  if (explicit) {
    if (explicit.length !== 32) throw new Error("fileAuthState: key precisa ter 32 bytes");
    return explicit;
  }
  const env =
    typeof process !== "undefined" ? process.env?.ONIWA_STORE_KEY : undefined;
  if (env) {
    const raw = /^[0-9a-fA-F]{64}$/.test(env)
      ? Uint8Array.from(env.match(/../g)!.map((h) => parseInt(h, 16)))
      : b64decode(env);
    if (raw.length !== 32) {
      throw new Error("fileAuthState: ONIWA_STORE_KEY precisa decodificar a 32 bytes");
    }
    return raw;
  }
  const keyPath = path + ".key";
  if (fs.existsSync(keyPath)) {
    const raw = new Uint8Array(fs.readFileSync(keyPath));
    if (raw.length !== 32) throw new Error(`fileAuthState: keyfile ${keyPath} corrompido`);
    return raw;
  }
  const raw = c.randomBytes(32);
  fs.writeFileSync(keyPath, raw, { mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    /* fs sem chmod (ex.: alguns FS no Windows) — segue */
  }
  return raw;
}

// --- leitura/escrita de registros -------------------------------------

interface Rec {
  type: string;
  id: string;
  /** undefined = tombstone */
  value?: unknown;
}

function be32(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function rd32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}
function aad(type: string, id: string): Uint8Array {
  return utf8Encode(type + "\0" + id);
}

function frameRecord(c: Crypto, key: Uint8Array, r: Rec): Uint8Array {
  const typeB = utf8Encode(r.type);
  const idB = utf8Encode(r.id);
  const nonce = c.randomBytes(NONCE);
  const ct =
    r.value === undefined
      ? new Uint8Array(0)
      : c.aesGcmEncrypt(key, nonce, encodeValue(r.value), aad(r.type, r.id));

  const payloadLen = 1 + typeB.length + 2 + idB.length + NONCE + ct.length;
  const out = new Uint8Array(4 + payloadLen);
  let o = 0;
  out.set(be32(payloadLen), o); o += 4;
  out[o++] = typeB.length;
  out.set(typeB, o); o += typeB.length;
  out[o++] = (idB.length >>> 8) & 0xff;
  out[o++] = idB.length & 0xff;
  out.set(idB, o); o += idB.length;
  out.set(nonce, o); o += NONCE;
  out.set(ct, o);
  return out;
}

/** Erro de leitura que NÃO é cauda torta: registro estruturalmente completo que
 *  não decifra (chave errada) ou corrupção no meio do arquivo. Nesse caso o
 *  arquivo é deixado intocado — apagá-lo forçaria re-registro (e ban). */
export class AuthStoreCorruptError extends Error {}

/** Lê todos os registros. `goodLen` é o offset até onde o arquivo está íntegro:
 *  se for menor que o arquivo, a diferença é uma cauda torta por crash e pode
 *  ser truncada. Lança `AuthStoreCorruptError` se um registro completo não
 *  decifrar ou a estrutura quebrar no meio (não no fim). */
function readLog(
  buf: Uint8Array,
  c: Crypto,
  key: Uint8Array,
): { recs: Rec[]; goodLen: number } {
  const recs: Rec[] = [];
  if (buf.length <= 4 || !MAGIC.every((b, i) => buf[i] === b)) {
    if (buf.length > 4 && !MAGIC.every((b, i) => buf[i] === b)) {
      throw new AuthStoreCorruptError("fileAuthState: magic do arquivo não confere");
    }
    return { recs, goodLen: 0 }; // arquivo só com magic (ou vazio) → começa do zero
  }
  let o = 4;
  let goodLen = 4;
  // `torn`: o resto do arquivo não chega para um registro inteiro → crash no
  // meio da escrita, é seguro truncar. Só vale se for a ÚLTIMA coisa no arquivo.
  const torn = () => ({ recs, goodLen });
  const corrupt = (why: string) => {
    throw new AuthStoreCorruptError("fileAuthState: " + why);
  };

  while (o + 4 <= buf.length) {
    const payloadLen = rd32(buf, o);
    if (payloadLen < 1 + 2 + NONCE) {
      // recLen impossível. Se há bytes suficientes para ele "caber", é lixo no
      // meio; senão é cauda torta.
      return o + 4 + payloadLen > buf.length ? torn() : corrupt("recLen inválido no offset " + o);
    }
    if (o + 4 + payloadLen > buf.length) return torn(); // registro não fecha → cauda torta

    const p0 = o + 4;
    let p = p0;
    const typeLen = buf[p++]!;
    if (p + typeLen + 2 > p0 + payloadLen) corrupt("typeLen estoura o payload no offset " + o);
    const type = utf8Decode(buf.subarray(p, p + typeLen));
    p += typeLen;
    const idLen = (buf[p]! << 8) | buf[p + 1]!;
    p += 2;
    if (p + idLen + NONCE > p0 + payloadLen) corrupt("idLen estoura o payload no offset " + o);
    const id = utf8Decode(buf.subarray(p, p + idLen));
    p += idLen;
    const nonce = buf.subarray(p, p + NONCE);
    p += NONCE;
    const ct = buf.subarray(p, p0 + payloadLen);

    if (ct.length === 0) {
      recs.push({ type, id }); // tombstone
    } else {
      let value: unknown;
      try {
        value = decodeValue(c.aesGcmDecrypt(key, nonce, ct, aad(type, id)));
      } catch {
        // Registro íntegro na estrutura mas a tag GCM não bate: chave errada
        // ou bytes trocados. NÃO trunca — deixa o operador resolver.
        corrupt(`registro [${type}/${id}] não decifra (chave errada ou corrupção)`);
      }
      recs.push({ type, id, value });
    }
    o = p0 + payloadLen;
    goodLen = o;
  }
  return { recs, goodLen };
}

// --- store -------------------------------------------------------------

export function fileAuthState(path: string, opts: FileAuthOptions = {}): FileAuthState {
  const c = opts.crypto ?? defaultCrypto();
  const factor = opts.compactionFactor ?? 2;

  // Cria o diretório ANTES de qualquer escrita (o keyfile também vai nele).
  const dir = path.replace(/[/\\][^/\\]*$/, "");
  if (dir && dir !== path && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const key = resolveKey(path, c, opts.key);

  // índice em memória: type -> id -> value
  const idx = new Map<string, Map<string, unknown>>();
  const bucket = (t: string) => {
    let m = idx.get(t);
    if (!m) idx.set(t, (m = new Map()));
    return m;
  };

  if (fs.existsSync(path)) {
    const buf = new Uint8Array(fs.readFileSync(path));
    const { recs, goodLen } = readLog(buf, c, key);
    for (const r of recs) {
      if (r.value === undefined) bucket(r.type).delete(r.id);
      else bucket(r.type).set(r.id, r.value);
    }
    if (goodLen !== buf.length) {
      // descarta a cauda torta deixada por um crash
      fs.truncateSync(path, goodLen);
    }
  } else {
    fs.writeFileSync(path, MAGIC);
  }

  const concat = (parts: Uint8Array[]): Uint8Array => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const blob = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      blob.set(p, o);
      o += p.length;
    }
    return blob;
  };

  // Reescreve o arquivo com um registro por chave viva, quando ele passou de
  // `factor` vezes o tamanho estimado dos dados vivos (e de 64 KiB). Escreve
  // num tmp + rename → troca atômica, nunca deixa o arquivo pela metade.
  const maybeCompact = () => {
    let size: number;
    try {
      size = fs.statSync(path).size;
    } catch {
      return;
    }
    let live = 4;
    for (const [, m] of idx) live += m.size * 96;
    if (size < 65536 || size <= factor * live) return;

    const parts: Uint8Array[] = [MAGIC];
    for (const [type, m] of idx) {
      for (const [id, value] of m) parts.push(frameRecord(c, key, { type, id, value }));
    }
    const tmp = path + ".compact." + Date.now();
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, concat(parts));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, path);
  };

  const append = (records: Rec[]) => {
    if (!records.length) return;
    const blob = concat(records.map((r) => frameRecord(c, key, r)));
    if (opts.fsync) {
      const fd = fs.openSync(path, "a");
      try {
        fs.writeSync(fd, blob);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      fs.appendFileSync(path, blob);
    }
    maybeCompact();
  };

  // --- credenciais ---------------------------------------------------
  let creds: AuthCreds;
  const stored = bucket(CREDS_TYPE).get("me") as AuthCreds | undefined;
  if (stored) {
    creds = stored;
  } else {
    creds = initAuthCreds();
    append([{ type: CREDS_TYPE, id: "me", value: creds }]);
    bucket(CREDS_TYPE).set("me", creds);
  }

  const keys: SignalKeyStore = {
    async get(type: SignalDataType, ids: string[]) {
      const m = bucket(type);
      const out: Record<string, unknown> = {};
      for (const id of ids) {
        if (m.has(id)) out[id] = m.get(id);
      }
      return out;
    },
    async set(data) {
      const records: Rec[] = [];
      for (const type of Object.keys(data) as SignalDataType[]) {
        const entries = data[type]!;
        for (const id of Object.keys(entries)) {
          const value = entries[id];
          const m = bucket(type);
          if (value === null || value === undefined) {
            m.delete(id);
            records.push({ type, id }); // tombstone
          } else {
            m.set(id, value);
            records.push({ type, id, value });
          }
        }
      }
      append(records); // um append, um fsync (se ligado) para o lote todo
    },
  };

  return {
    state: { creds, keys },
    async saveCreds() {
      bucket(CREDS_TYPE).set("me", creds);
      append([{ type: CREDS_TYPE, id: "me", value: creds }]);
    },
  };
}
