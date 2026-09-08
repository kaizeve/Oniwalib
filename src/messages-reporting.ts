// Reporting token para conteúdo de broadcast (status@broadcast) — porta fiel do
// `Utils/reporting-utils.ts` da Baileys. O WhatsApp moderno exige o
// `<reporting><reporting_token v="2">` na stanza de status; sem ele o servidor
// aceita mas não faz o fan-out (o status aparece só pra você, com 0 views).
//
// O token é um HMAC-SHA256 (16 bytes) de um subconjunto whitelistado dos campos
// do Message proto, chaveado por um segredo derivado via HKDF de
// `messageContextInfo.messageSecret`.

import type { Crypto } from "./crypto/types";
import { node, type BinaryNode } from "./frame/node";

// Whitelist de campos que entram no token (idêntica à da Baileys).
type FieldSpec = { f: number; s?: FieldSpec[]; m?: boolean };
const reportingFields: FieldSpec[] = [
  { f: 1 },
  { f: 3, s: [{ f: 2 }, { f: 3 }, { f: 8 }, { f: 11 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 25 }] },
  { f: 4, s: [{ f: 1 }, { f: 16 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }] },
  { f: 5, s: [{ f: 3 }, { f: 4 }, { f: 5 }, { f: 16 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }] },
  { f: 6, s: [{ f: 1 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 30 }] },
  { f: 7, s: [{ f: 2 }, { f: 7 }, { f: 10 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 20 }] },
  { f: 8, s: [{ f: 2 }, { f: 7 }, { f: 9 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 21 }] },
  { f: 9, s: [{ f: 2 }, { f: 6 }, { f: 7 }, { f: 13 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 20 }] },
  { f: 12, s: [{ f: 1 }, { f: 2 }, { f: 14, m: true }, { f: 15 }] },
  { f: 18, s: [{ f: 6 }, { f: 16 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }] },
  { f: 26, s: [{ f: 4 }, { f: 5 }, { f: 8 }, { f: 13 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }] },
  { f: 28, s: [{ f: 1 }, { f: 2 }, { f: 4 }, { f: 5 }, { f: 6 }, { f: 7, s: [{ f: 21 }, { f: 22 }] }] },
  { f: 37, s: [{ f: 1, m: true }] },
  { f: 49, s: [{ f: 2 }, { f: 3, s: [{ f: 1 }, { f: 2 }] }, { f: 5, s: [{ f: 21 }, { f: 22 }] }, { f: 8, s: [{ f: 1 }, { f: 2 }] }] },
  { f: 53, s: [{ f: 1, m: true }] },
  { f: 55, s: [{ f: 1, m: true }] },
  { f: 58, s: [{ f: 1, m: true }] },
  { f: 59, s: [{ f: 1, m: true }] },
  { f: 60, s: [{ f: 2 }, { f: 3, s: [{ f: 1 }, { f: 2 }] }, { f: 5, s: [{ f: 21 }, { f: 22 }] }, { f: 8, s: [{ f: 1 }, { f: 2 }] }] },
  { f: 64, s: [{ f: 2 }, { f: 3, s: [{ f: 1 }, { f: 2 }] }, { f: 5, s: [{ f: 21 }, { f: 22 }] }, { f: 8, s: [{ f: 1 }, { f: 2 }] }] },
  { f: 66, s: [{ f: 2 }, { f: 6 }, { f: 7 }, { f: 13 }, { f: 17, s: [{ f: 21 }, { f: 22 }] }, { f: 20 }] },
  { f: 74, s: [{ f: 1, m: true }] },
  { f: 87, s: [{ f: 1, m: true }] },
  { f: 88, s: [{ f: 1 }, { f: 2, s: [{ f: 1 }] }, { f: 3, s: [{ f: 21 }, { f: 22 }] }] },
  { f: 92, s: [{ f: 1, m: true }] },
  { f: 93, s: [{ f: 1, m: true }] },
  { f: 94, s: [{ f: 1, m: true }] },
];

type CompiledField = { m?: boolean; children?: Map<number, CompiledField> };
const compile = (fields: FieldSpec[]): Map<number, CompiledField> => {
  const map = new Map<number, CompiledField>();
  for (const f of fields) map.set(f.f, { m: f.m, children: f.s ? compile(f.s) : undefined });
  return map;
};
const COMPILED = compile(reportingFields);
const EMPTY = new Map<number, CompiledField>();

const WIRE = { VARINT: 0, FIXED64: 1, BYTES: 2, FIXED32: 5 } as const;

const decodeVarint = (buf: Uint8Array, offset: number): { value: number; bytes: number; ok: boolean } => {
  let value = 0;
  let bytes = 0;
  let shift = 0;
  while (offset + bytes < buf.length) {
    const cur = buf[offset + bytes]!;
    value |= (cur & 0x7f) << shift;
    bytes++;
    if ((cur & 0x80) === 0) return { value, bytes, ok: true };
    shift += 7;
    if (shift > 35) return { value: 0, bytes: 0, ok: false };
  }
  return { value: 0, bytes: 0, ok: false };
};

const encodeVarint = (value: number): Uint8Array => {
  const parts: number[] = [];
  let rem = value >>> 0;
  while (rem > 0x7f) {
    parts.push((rem & 0x7f) | 0x80);
    rem >>>= 7;
  }
  parts.push(rem);
  return Uint8Array.from(parts);
};

const cat = (chunks: Uint8Array[]): Uint8Array => {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
};

// Filtra `data` (Message proto codificado) mantendo só os campos da whitelist,
// re-serializa ordenado por número de campo. Igual ao algoritmo da Baileys.
const extract = (data: Uint8Array, cfg: Map<number, CompiledField>): Uint8Array | null => {
  const out: Array<{ num: number; bytes: Uint8Array }> = [];
  let i = 0;
  while (i < data.length) {
    const tag = decodeVarint(data, i);
    if (!tag.ok) return null;
    const fieldNum = tag.value >> 3;
    const wire = tag.value & 0x7;
    const fieldStart = i;
    i += tag.bytes;
    const fieldCfg = cfg.get(fieldNum);

    if (wire === WIRE.VARINT) {
      const v = decodeVarint(data, i);
      if (!v.ok) return null;
      const end = i + v.bytes;
      if (end > data.length) return null;
      if (fieldCfg) out.push({ num: fieldNum, bytes: data.subarray(fieldStart, end) });
      i = end;
      continue;
    }
    if (wire === WIRE.FIXED64 || wire === WIRE.FIXED32) {
      const end = i + (wire === WIRE.FIXED64 ? 8 : 4);
      if (end > data.length) return null;
      if (fieldCfg) out.push({ num: fieldNum, bytes: data.subarray(fieldStart, end) });
      i = end;
      continue;
    }
    if (wire === WIRE.BYTES) {
      const len = decodeVarint(data, i);
      if (!len.ok) return null;
      const valStart = i + len.bytes;
      const valEnd = valStart + len.value;
      if (valEnd > data.length) return null;
      if (!fieldCfg) {
        i = valEnd;
        continue;
      }
      if (fieldCfg.m || fieldCfg.children) {
        const sub = extract(data.subarray(valStart, valEnd), fieldCfg.children ?? EMPTY);
        if (sub === null) return null;
        if (sub.length > 0) {
          out.push({ num: fieldNum, bytes: cat([encodeVarint(tag.value), encodeVarint(sub.length), sub]) });
        }
        i = valEnd;
        continue;
      }
      out.push({ num: fieldNum, bytes: data.subarray(fieldStart, valEnd) });
      i = valEnd;
      continue;
    }
    return null;
  }
  if (out.length === 0) return new Uint8Array(0);
  out.sort((a, b) => a.num - b.num);
  return cat(out.map((f) => f.bytes));
};

const REPORT_TOKEN_LABEL = "Report Token";

/** Deriva o `<reporting>` node para uma stanza de status. `encodedMsg` é o
 *  Message proto codificado (com `messageContextInfo.messageSecret`). Retorna
 *  `null` se não houver segredo ou se o conteúdo filtrado for vazio. */
export function buildReportingNode(args: {
  crypto: Crypto;
  encodedMsg: Uint8Array;
  messageSecret: Uint8Array;
  msgId: string;
  from: string;
  to: string;
}): BinaryNode | null {
  const { crypto: c, encodedMsg, messageSecret, msgId, from, to } = args;
  if (!messageSecret || !messageSecret.length || !msgId) return null;

  const enc = new TextEncoder();
  const info = cat([enc.encode(msgId), enc.encode(from), enc.encode(to), enc.encode(REPORT_TOKEN_LABEL)]);
  const reportingSecret = c.hkdf(messageSecret, 32, { info });

  const content = extract(encodedMsg, COMPILED);
  if (!content || content.length === 0) return null;

  const token = c.hmacSha256(reportingSecret, content).subarray(0, 16);
  return node("reporting", {}, [node("reporting_token", { v: "2" }, token)]);
}
