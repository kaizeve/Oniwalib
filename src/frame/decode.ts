// WABinary decode — bytes → BinaryNode.
//
// Estrutura de um node no fio:
//   listSize   (via tag LIST_8 / LIST_16 / LIST_EMPTY)
//   descrTag   → a string da tag (token, ou BINARY_*)
//   pares de (key, value) de atributo   → (listSize - 1) >> 1 pares
//   conteúdo   → presente só quando listSize é PAR
//
// O conteúdo, por sua vez, é: uma lista de nodes, ou bytes crus, ou uma string.

import { BufferReader } from "./buffer";
import {
  DOUBLE_BYTE_TOKENS,
  HEX_ALPHABET,
  NIBBLE_ALPHABET,
  SINGLE_BYTE_TOKENS,
  TAGS,
} from "./constants";
import type { BinaryNode } from "./node";

export function decodeBinaryNode(buf: Uint8Array): BinaryNode {
  return readNode(new BufferReader(buf));
}

function readListSize(r: BufferReader, tag: number): number {
  if (tag === TAGS.LIST_EMPTY) return 0;
  if (tag === TAGS.LIST_8) return r.readByte();
  if (tag === TAGS.LIST_16) return r.readUint(2);
  throw new Error(`WABinary: tag de lista inválida ${tag}`);
}

function token(dict: string[], index: number): string {
  const s = dict[index];
  if (s === undefined || s === "") {
    throw new Error(
      `WABinary: token desconhecido (índice ${index}). ` +
        `A tabela de tokens precisa ser atualizada para a versão do protocolo.`,
    );
  }
  return s;
}

function unpackByte(alphabet: string, packed: boolean, value: number): string {
  // No modo packed, cada nibble indexa o alfabeto. 15 (0x0F) = sem segundo nibble.
  void packed;
  return alphabet[value] ?? "";
}

function readPacked(r: BufferReader, alphabet: string): string {
  const header = r.readByte();
  const half = (header & 0x80) !== 0; // bit alto: o último byte tem só 1 nibble
  const len = header & 0x7f;
  let out = "";
  for (let k = 0; k < len; k++) {
    const b = r.readByte();
    out += unpackByte(alphabet, true, (b >> 4) & 0x0f);
    if (!(half && k === len - 1)) {
      out += unpackByte(alphabet, true, b & 0x0f);
    }
  }
  return out;
}

function readJidPair(r: BufferReader): string {
  const user = readString(r, r.readByte());
  const server = readString(r, r.readByte());
  return user !== "" ? `${user}@${server}` : server;
}

function readAdJid(r: BufferReader): string {
  // AD_JID (247): agent, device, e então o user como string/packed.
  const agent = r.readByte();
  const device = r.readByte();
  const user = readString(r, r.readByte());
  const server = agent === 0 ? "s.whatsapp.net" : "lid";
  const dev = device ? `:${device}` : "";
  return `${user}${dev}@${server}`;
}

function readString(r: BufferReader, tag: number): string {
  if (tag === TAGS.LIST_EMPTY) return "";

  if (tag >= 1 && tag < SINGLE_BYTE_TOKENS.length && tag !== TAGS.STREAM_END) {
    // Faixa dos tokens de 1 byte (fora as tags estruturais no topo).
    if (tag < TAGS.DICTIONARY_0) {
      return token(SINGLE_BYTE_TOKENS, tag);
    }
  }

  switch (tag) {
    case TAGS.DICTIONARY_0:
    case TAGS.DICTIONARY_1:
    case TAGS.DICTIONARY_2:
    case TAGS.DICTIONARY_3: {
      const dict = tag - TAGS.DICTIONARY_0;
      return token(DOUBLE_BYTE_TOKENS[dict] ?? [], r.readByte());
    }
    case TAGS.JID_PAIR:
      return readJidPair(r);
    case TAGS.AD_JID:
      return readAdJid(r);
    case TAGS.HEX_8:
      return readPacked(r, HEX_ALPHABET);
    case TAGS.NIBBLE_8:
      return readPacked(r, NIBBLE_ALPHABET);
    case TAGS.BINARY_8:
      return r.readUtf8(r.readByte());
    case TAGS.BINARY_20:
      return r.readUtf8(r.readUint20());
    case TAGS.BINARY_32:
      return r.readUtf8(r.readUint(4));
    default:
      throw new Error(`WABinary: tag de string inválida ${tag}`);
  }
}

function readBytesOrString(r: BufferReader, tag: number): Uint8Array | string {
  switch (tag) {
    case TAGS.BINARY_8:
      return r.readBytes(r.readByte());
    case TAGS.BINARY_20:
      return r.readBytes(r.readUint20());
    case TAGS.BINARY_32:
      return r.readBytes(r.readUint(4));
    default:
      return readString(r, tag);
  }
}

function readNode(r: BufferReader): BinaryNode {
  const listSize = readListSize(r, r.readByte());
  const descrTag = r.readByte();
  if (descrTag === TAGS.STREAM_END) {
    throw new Error("WABinary: STREAM_END inesperado");
  }
  const tag = readString(r, descrTag);

  const attrs: Record<string, string> = {};
  const attrCount = (listSize - 1) >> 1;
  for (let k = 0; k < attrCount; k++) {
    const key = readString(r, r.readByte());
    attrs[key] = readString(r, r.readByte());
  }

  let content: BinaryNode["content"];
  if (listSize % 2 === 0) {
    const ct = r.readByte();
    if (ct === TAGS.LIST_EMPTY || ct === TAGS.LIST_8 || ct === TAGS.LIST_16) {
      const n = readListSize(r, ct);
      const children: BinaryNode[] = [];
      for (let k = 0; k < n; k++) {
        children.push(readNode(r));
      }
      content = children;
    } else {
      content = readBytesOrString(r, ct);
    }
  }

  return { tag, attrs, content };
}
