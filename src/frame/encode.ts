// WABinary encode — BinaryNode → bytes. Inverso exato de `decode.ts`:
// `decodeBinaryNode(encodeBinaryNode(n))` devolve `n`.
//
// Escolha de tag para uma string:
//   ""                         → LIST_EMPTY
//   está na tabela de 1 byte   → o próprio índice
//   senão                      → BINARY_8 / BINARY_20 / BINARY_32 por tamanho
//
// Packing NIBBLE/HEX e JID_PAIR são otimizações de tamanho que o servidor
// aceita mas não exige; entram depois (não afetam a semântica nem o round-trip).

import { BufferWriter, utf8Encode } from "./buffer";
import { SINGLE_BYTE_TOKENS, TAGS } from "./constants";
import type { BinaryNode } from "./node";

let SINGLE_BYTE_MAP: Map<string, number> | undefined;

function singleByteMap(): Map<string, number> {
  if (!SINGLE_BYTE_MAP) {
    SINGLE_BYTE_MAP = new Map();
    for (let i = 3; i < SINGLE_BYTE_TOKENS.length; i++) {
      const t = SINGLE_BYTE_TOKENS[i];
      if (t !== "" && !SINGLE_BYTE_MAP.has(t)) {
        SINGLE_BYTE_MAP.set(t, i);
      }
    }
  }
  return SINGLE_BYTE_MAP;
}

export function encodeBinaryNode(n: BinaryNode): Uint8Array {
  const w = new BufferWriter();
  writeNode(w, n);
  return w.toBuffer();
}

function writeListSize(w: BufferWriter, size: number): void {
  if (size === 0) {
    w.writeByte(TAGS.LIST_EMPTY);
  } else if (size < 256) {
    w.writeByte(TAGS.LIST_8);
    w.writeByte(size);
  } else {
    w.writeByte(TAGS.LIST_16);
    w.writeUint(size, 2);
  }
}

function writeString(w: BufferWriter, s: string): void {
  if (s === "") {
    w.writeByte(TAGS.LIST_EMPTY);
    return;
  }
  const idx = singleByteMap().get(s);
  if (idx !== undefined) {
    w.writeByte(idx);
    return;
  }
  writeBinary(w, utf8Encode(s));
}

function writeBinary(w: BufferWriter, bytes: Uint8Array): void {
  const len = bytes.length;
  if (len < 256) {
    w.writeByte(TAGS.BINARY_8);
    w.writeByte(len);
  } else if (len < 1 << 20) {
    w.writeByte(TAGS.BINARY_20);
    w.writeUint20(len);
  } else {
    w.writeByte(TAGS.BINARY_32);
    w.writeUint(len, 4);
  }
  w.writeBytes(bytes);
}

function writeNode(w: BufferWriter, n: BinaryNode): void {
  const attrKeys = Object.keys(n.attrs ?? {});
  const hasContent = n.content !== undefined && n.content !== null;
  const listSize = 1 + attrKeys.length * 2 + (hasContent ? 1 : 0);

  writeListSize(w, listSize);
  writeString(w, n.tag);

  for (const key of attrKeys) {
    writeString(w, key);
    writeString(w, n.attrs[key]);
  }

  if (!hasContent) {
    return;
  }
  const c = n.content;
  if (typeof c === "string") {
    writeString(w, c);
  } else if (c instanceof Uint8Array) {
    writeBinary(w, c);
  } else if (Array.isArray(c)) {
    writeListSize(w, c.length);
    for (const child of c) {
      writeNode(w, child);
    }
  } else {
    throw new Error("WABinary: conteúdo de node com tipo inválido");
  }
}
