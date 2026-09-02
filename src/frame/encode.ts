// WABinary encode — BinaryNode → bytes. Portado de
// @whiskeysockets/baileys src/WABinary/encode.ts (master, 2026-08), byte a byte.
// Inverso exato de `decode.ts`: `decodeBinaryNode(encodeBinaryNode(n))` devolve `n`.
//
// Escolha de tag para uma string (na ordem da Baileys):
//   undefined / null           → LIST_EMPTY
//   ""                         → BINARY_8 com tamanho 0
//   está no TOKEN_MAP          → índice de 1 byte (+ byte de dicionário se double)
//   só [0-9.-]  (<= 127 chars) → NIBBLE_8 packed
//   só [0-9A-F] (<= 127 chars) → HEX_8 packed
//   parece um JID              → JID_PAIR / AD_JID
//   senão                      → BINARY_8 / BINARY_20 / BINARY_32 por tamanho
//
// Este módulo não importa plataforma (sem zlib): frames de saída não são
// comprimidos pelo cliente — o byte de flag vai sempre 0.

import { BufferWriter, utf8Encode } from "./buffer";
import { TAGS, TOKEN_MAP } from "./constants";
import { jidDecode, type FullJid } from "./jid";
import type { BinaryNode } from "./node";

export function encodeBinaryNode(n: BinaryNode): Uint8Array {
  const w = new BufferWriter();
  // Byte de flag do frame: 0 = sem compressão. O WhatsApp lê este byte antes
  // do node (bit 1 ligado = payload zlib-deflated). O decode espelha isto.
  w.writeByte(0);
  writeNode(w, n);
  return w.toBuffer();
}

function writeNode(w: BufferWriter, node: BinaryNode): void {
  const { tag, attrs, content } = node;

  const pushByte = (v: number) => w.writeByte(v & 0xff);
  const pushBytes = (bytes: Uint8Array | number[]) => {
    for (const b of bytes) w.writeByte(b & 0xff);
  };
  const pushInt16 = (v: number) => pushBytes([(v >> 8) & 0xff, v & 0xff]);
  const pushInt20 = (v: number) =>
    pushBytes([(v >> 16) & 0x0f, (v >> 8) & 0xff, v & 0xff]);

  const writeByteLength = (length: number) => {
    if (length >= 4294967296) {
      throw new Error("string too large to encode: " + length);
    }
    if (length >= 1 << 20) {
      pushByte(TAGS.BINARY_32);
      w.writeUint(length, 4);
    } else if (length >= 256) {
      pushByte(TAGS.BINARY_20);
      pushInt20(length);
    } else {
      pushByte(TAGS.BINARY_8);
      pushByte(length);
    }
  };

  const writeStringRaw = (str: string) => {
    const bytes = utf8Encode(str);
    writeByteLength(bytes.length);
    pushBytes(bytes);
  };

  const writeJid = ({ domainType, device, user, server }: FullJid) => {
    if (typeof device !== "undefined") {
      pushByte(TAGS.AD_JID);
      pushByte(domainType || 0);
      pushByte(device || 0);
      writeString(user);
    } else {
      pushByte(TAGS.JID_PAIR);
      if (user.length) writeString(user);
      else pushByte(TAGS.LIST_EMPTY);
      writeString(server);
    }
  };

  const packNibble = (char: string): number => {
    switch (char) {
      case "-":
        return 10;
      case ".":
        return 11;
      case "\0":
        return 15;
      default:
        if (char >= "0" && char <= "9") {
          return char.charCodeAt(0) - "0".charCodeAt(0);
        }
        throw new Error(`invalid byte for nibble "${char}"`);
    }
  };

  const packHex = (char: string): number => {
    if (char >= "0" && char <= "9") return char.charCodeAt(0) - "0".charCodeAt(0);
    if (char >= "A" && char <= "F")
      return 10 + char.charCodeAt(0) - "A".charCodeAt(0);
    if (char >= "a" && char <= "f")
      return 10 + char.charCodeAt(0) - "a".charCodeAt(0);
    if (char === "\0") return 15;
    throw new Error(`Invalid hex char "${char}"`);
  };

  const writePackedBytes = (str: string, type: "nibble" | "hex") => {
    if (str.length > TAGS.PACKED_MAX) throw new Error("Too many bytes to pack");

    pushByte(type === "nibble" ? TAGS.NIBBLE_8 : TAGS.HEX_8);

    let roundedLength = Math.ceil(str.length / 2.0);
    if (str.length % 2 !== 0) roundedLength |= 128;
    pushByte(roundedLength);

    const pack = type === "nibble" ? packNibble : packHex;
    const pair = (v1: string, v2: string) => (pack(v1) << 4) | pack(v2);

    const half = Math.floor(str.length / 2);
    for (let i = 0; i < half; i++) {
      pushByte(pair(str[2 * i]!, str[2 * i + 1]!));
    }
    if (str.length % 2 !== 0) {
      pushByte(pair(str[str.length - 1]!, "\x00"));
    }
  };

  const isNibble = (str?: string): boolean => {
    if (!str || str.length > TAGS.PACKED_MAX) return false;
    for (const char of str) {
      const inRange = char >= "0" && char <= "9";
      if (!inRange && char !== "-" && char !== ".") return false;
    }
    return true;
  };

  const isHex = (str?: string): boolean => {
    if (!str || str.length > TAGS.PACKED_MAX) return false;
    for (const char of str) {
      const inRange = char >= "0" && char <= "9";
      if (!inRange && !(char >= "A" && char <= "F")) return false;
    }
    return true;
  };

  const writeString = (str?: string): void => {
    if (str === undefined || str === null) {
      pushByte(TAGS.LIST_EMPTY);
      return;
    }
    if (str === "") {
      writeStringRaw(str);
      return;
    }

    const tokenIndex = TOKEN_MAP[str];
    if (tokenIndex) {
      if (typeof tokenIndex.dict === "number") {
        pushByte(TAGS.DICTIONARY_0 + tokenIndex.dict);
      }
      pushByte(tokenIndex.index);
    } else if (isNibble(str)) {
      writePackedBytes(str, "nibble");
    } else if (isHex(str)) {
      writePackedBytes(str, "hex");
    } else {
      const decodedJid = jidDecode(str);
      if (decodedJid) writeJid(decodedJid);
      else writeStringRaw(str);
    }
  };

  const writeListStart = (listSize: number) => {
    if (listSize === 0) {
      pushByte(TAGS.LIST_EMPTY);
    } else if (listSize < 256) {
      pushBytes([TAGS.LIST_8, listSize]);
    } else {
      pushByte(TAGS.LIST_16);
      pushInt16(listSize);
    }
  };

  if (!tag) throw new Error("Invalid node: tag cannot be undefined");

  const validAttributes = Object.keys(attrs || {}).filter(
    (k) => typeof attrs[k] !== "undefined" && attrs[k] !== null,
  );

  writeListStart(
    2 * validAttributes.length + 1 + (typeof content !== "undefined" ? 1 : 0),
  );
  writeString(tag);

  for (const key of validAttributes) {
    if (typeof attrs[key] === "string") {
      writeString(key);
      writeString(attrs[key]);
    }
  }

  if (typeof content === "string") {
    writeString(content);
  } else if (content instanceof Uint8Array) {
    writeByteLength(content.length);
    pushBytes(content);
  } else if (Array.isArray(content)) {
    const validContent = content.filter(
      (item) =>
        item &&
        (item.tag || item instanceof Uint8Array || typeof item === "string"),
    );
    writeListStart(validContent.length);
    for (const item of validContent) {
      writeNode(w, item);
    }
  } else if (typeof content === "undefined") {
    // nada
  } else {
    throw new Error(
      `invalid children for header "${tag}": ${content} (${typeof content})`,
    );
  }
}
