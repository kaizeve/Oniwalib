// WABinary decode — portado de @whiskeysockets/baileys src/WABinary/decode.ts.
// A lógica é a de lá, byte a byte; só a descompressão zlib é injetada (mantém
// este módulo sem import de plataforma — `connect.ts` passa `zlib.inflateSync`).

import { DOUBLE_BYTE_TOKENS, SINGLE_BYTE_TOKENS, TAGS } from "./constants";
import { jidEncode, WAJIDDomains } from "./jid";
import type { BinaryNode } from "./node";

export type Inflate = (data: Uint8Array) => Uint8Array;

const dec = new TextDecoder();

export function decodeBinaryNode(buf: Uint8Array, inflate?: Inflate): BinaryNode {
  const flag = buf[0] ?? 0;
  let body = buf.subarray(1);
  if (flag & 2) {
    if (!inflate) throw new Error("WABinary: frame comprimido (flag & 2) — passe um inflate");
    body = inflate(body);
  }
  return decodeDecompressed(body, { index: 0 });
}

function decodeDecompressed(buffer: Uint8Array, ref: { index: number }): BinaryNode {
  const checkEOS = (n: number) => {
    if (ref.index + n > buffer.length) throw new Error("end of stream");
  };
  const next = () => buffer[ref.index++]!;
  const readByte = () => {
    checkEOS(1);
    return next();
  };
  const readBytes = (n: number) => {
    checkEOS(n);
    const v = buffer.subarray(ref.index, ref.index + n);
    ref.index += n;
    return v;
  };
  const readStringFromChars = (n: number) => dec.decode(readBytes(n));
  const readInt = (n: number, littleEndian = false) => {
    checkEOS(n);
    let val = 0;
    for (let i = 0; i < n; i++) {
      const shift = littleEndian ? i : n - 1 - i;
      val |= next() << (shift * 8);
    }
    return val >>> 0;
  };
  const readInt20 = () => {
    checkEOS(3);
    return ((next() & 15) << 16) + (next() << 8) + next();
  };

  const unpackHex = (v: number) => {
    if (v >= 0 && v < 16) return v < 10 ? 48 + v : 65 + v - 10;
    throw new Error("invalid hex: " + v);
  };
  const unpackNibble = (v: number) => {
    if (v >= 0 && v <= 9) return 48 + v;
    if (v === 10) return 45; // -
    if (v === 11) return 46; // .
    if (v === 15) return 0;
    throw new Error("invalid nibble: " + v);
  };
  const unpackByte = (tag: number, v: number) =>
    tag === TAGS.NIBBLE_8 ? unpackNibble(v) : tag === TAGS.HEX_8 ? unpackHex(v) : (() => {
      throw new Error("unknown tag: " + tag);
    })();
  const readPacked8 = (tag: number) => {
    const startByte = readByte();
    let value = "";
    for (let i = 0; i < (startByte & 127); i++) {
      const cur = readByte();
      value += String.fromCharCode(unpackByte(tag, (cur & 0xf0) >> 4));
      value += String.fromCharCode(unpackByte(tag, cur & 0x0f));
    }
    if (startByte >> 7 !== 0) value = value.slice(0, -1);
    return value;
  };

  const isListTag = (tag: number) =>
    tag === TAGS.LIST_EMPTY || tag === TAGS.LIST_8 || tag === TAGS.LIST_16;
  const readListSize = (tag: number) => {
    if (tag === TAGS.LIST_EMPTY) return 0;
    if (tag === TAGS.LIST_8) return readByte();
    if (tag === TAGS.LIST_16) return readInt(2);
    throw new Error("invalid tag for list size: " + tag);
  };

  const getTokenDouble = (i1: number, i2: number) => {
    const dict = DOUBLE_BYTE_TOKENS[i1];
    if (!dict) throw new Error(`Invalid double token dict (${i1})`);
    const v = dict[i2];
    if (typeof v === "undefined") throw new Error(`Invalid double token (${i2})`);
    return v;
  };

  const readJidPair = () => {
    const i = readString(readByte());
    const j = readString(readByte());
    if (j) return (i || "") + "@" + j;
    throw new Error("invalid jid pair: " + i + ", " + j);
  };
  const readAdJid = () => {
    const domainType = Number(readByte());
    const device = readByte();
    const user = readString(readByte());
    let server = "s.whatsapp.net";
    if (domainType === WAJIDDomains.LID) server = "lid";
    else if (domainType === WAJIDDomains.HOSTED) server = "hosted";
    else if (domainType === WAJIDDomains.HOSTED_LID) server = "hosted.lid";
    return jidEncode(user, server, device);
  };
  const readFbJid = () => {
    const user = readString(readByte());
    const device = readInt(2);
    const server = readString(readByte());
    return `${user}:${device}@${server}`;
  };
  const readInteropJid = () => {
    const user = readString(readByte());
    const device = readInt(2);
    const integrator = readInt(2);
    let server = "interop";
    const before = ref.index;
    try {
      server = readString(readByte());
    } catch {
      ref.index = before;
    }
    return `${integrator}-${user}:${device}@${server}`;
  };

  const readString = (tag: number): string => {
    if (tag >= 1 && tag < SINGLE_BYTE_TOKENS.length) {
      return SINGLE_BYTE_TOKENS[tag] || "";
    }
    switch (tag) {
      case TAGS.DICTIONARY_0:
      case TAGS.DICTIONARY_1:
      case TAGS.DICTIONARY_2:
      case TAGS.DICTIONARY_3:
        return getTokenDouble(tag - TAGS.DICTIONARY_0, readByte());
      case TAGS.LIST_EMPTY:
        return "";
      case TAGS.BINARY_8:
        return readStringFromChars(readByte());
      case TAGS.BINARY_20:
        return readStringFromChars(readInt20());
      case TAGS.BINARY_32:
        return readStringFromChars(readInt(4));
      case TAGS.JID_PAIR:
        return readJidPair();
      case TAGS.FB_JID:
        return readFbJid();
      case TAGS.INTEROP_JID:
        return readInteropJid();
      case TAGS.AD_JID:
        return readAdJid();
      case TAGS.HEX_8:
      case TAGS.NIBBLE_8:
        return readPacked8(tag);
      default:
        throw new Error("invalid string with tag: " + tag);
    }
  };

  const readList = (tag: number) => {
    const items: BinaryNode[] = [];
    const size = readListSize(tag);
    for (let i = 0; i < size; i++) items.push(decodeDecompressed(buffer, ref));
    return items;
  };

  const listSize = readListSize(readByte());
  const header = readString(readByte());
  if (!listSize || !header.length) throw new Error("invalid node");

  const attrs: Record<string, string> = {};
  const attributesLength = (listSize - 1) >> 1;
  for (let i = 0; i < attributesLength; i++) {
    const key = readString(readByte());
    attrs[key] = readString(readByte());
  }

  let content: BinaryNode["content"];
  if (listSize % 2 === 0) {
    const tag = readByte();
    if (isListTag(tag)) {
      content = readList(tag);
    } else {
      switch (tag) {
        case TAGS.BINARY_8:
          content = readBytes(readByte());
          break;
        case TAGS.BINARY_20:
          content = readBytes(readInt20());
          break;
        case TAGS.BINARY_32:
          content = readBytes(readInt(4));
          break;
        default:
          content = readString(tag);
          break;
      }
    }
  }

  return { tag: header, attrs, content };
}
