// Serialização dos três frames do handshake.
//
// PLACEHOLDER: o WhatsApp usa o protobuf `HandshakeMessage` (clientHello /
// serverHello / clientFinish, cada um com campos `ephemeral` / `static` /
// `payload`). Enquanto o `proto/` de fio (decisão D3) não entra, isto usa um
// TLV simples — [tipo:1][n campos:1] então [len:2 BE][bytes]... — que é
// suficiente para o handshake rodar entre dois NoiseSockets nos testes.
// Trocar por protobuf real é reescrever só estas duas funções.

export type HandshakeKind = "clientHello" | "serverHello" | "clientFinish";

const KIND_TO_TAG: Record<HandshakeKind, number> = {
  clientHello: 1,
  serverHello: 2,
  clientFinish: 3,
};
const TAG_TO_KIND: Record<number, HandshakeKind> = {
  1: "clientHello",
  2: "serverHello",
  3: "clientFinish",
};

export interface HandshakeMessage {
  kind: HandshakeKind;
  fields: Uint8Array[];
}

export function encodeHandshake(msg: HandshakeMessage): Uint8Array {
  const parts: number[] = [KIND_TO_TAG[msg.kind], msg.fields.length];
  for (const f of msg.fields) {
    parts.push((f.length >> 8) & 0xff, f.length & 0xff);
    for (const b of f) parts.push(b);
  }
  return Uint8Array.from(parts);
}

export function decodeHandshake(bytes: Uint8Array): HandshakeMessage {
  const kind = TAG_TO_KIND[bytes[0]!];
  if (!kind) throw new Error(`handshake: tag desconhecida ${bytes[0]}`);
  const count = bytes[1]!;
  const fields: Uint8Array[] = [];
  let o = 2;
  for (let i = 0; i < count; i++) {
    const len = (bytes[o]! << 8) | bytes[o + 1]!;
    o += 2;
    fields.push(bytes.subarray(o, o + len));
    o += len;
  }
  return { kind, fields };
}
