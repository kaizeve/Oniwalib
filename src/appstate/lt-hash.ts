// LT-Hash — hash por SOMA que mantém a integridade de um conjunto de dados ao
// longo de uma série de mutações (add/remove). Aplicar a mesma série em ordem
// qualquer dá o mesmo hash.
//
// Porte fiel do `@whiskeysockets/baileys` `src/Utils/lt-hash.ts` (versões 6.x,
// antes de virar `whatsapp-rust-bridge`):
//
//   state: 128 bytes = 64 lanes uint16 little-endian
//   por mutação:  h = HKDF-SHA256(valueMac, 128, info="WhatsApp Patch Integrity")
//   add:      state[i] = (state[i] + h[i]) mod 2^16   (pointwise, por lane)
//   subtract: state[i] = (state[i] - h[i]) mod 2^16
//
// O `valueMac` de entrada é o MAC de 32 bytes do valor da mutação (para adds) ou
// o MAC antigo (para o subtract de uma reescrita/remoção).

import type { Crypto } from "../crypto/types";
import { utf8Encode } from "../frame/buffer";

const SALT = utf8Encode("WhatsApp Patch Integrity");
const OUT = 128;

function pointwise(
  state: Uint8Array,
  expanded: Uint8Array,
  add: boolean,
): Uint8Array {
  const out = new Uint8Array(state.length);
  for (let i = 0; i < state.length; i += 2) {
    const a = state[i]! | (state[i + 1]! << 8);
    const b = expanded[i]! | (expanded[i + 1]! << 8);
    const r = (add ? a + b : a - b) & 0xffff;
    out[i] = r & 0xff;
    out[i + 1] = (r >> 8) & 0xff;
  }
  return out;
}

export interface LtHash {
  add(state: Uint8Array, values: Uint8Array[]): Uint8Array;
  subtract(state: Uint8Array, values: Uint8Array[]): Uint8Array;
  /** `add(subtract(state, sub), add)` — a mesma ordem que o WA Web usa ao
   *  aplicar um patch (tira os MACs antigos, põe os novos). */
  subtractThenAdd(
    state: Uint8Array,
    sub: Uint8Array[],
    add: Uint8Array[],
  ): Uint8Array;
}

export function makeLtHash(c: Crypto): LtHash {
  function addSingle(state: Uint8Array, value: Uint8Array, add: boolean): Uint8Array {
    const expanded = c.hkdf(value, OUT, { info: SALT });
    return pointwise(state, expanded, add);
  }
  function add(state: Uint8Array, values: Uint8Array[]): Uint8Array {
    let s = state;
    for (const v of values) s = addSingle(s, v, true);
    return s;
  }
  function subtract(state: Uint8Array, values: Uint8Array[]): Uint8Array {
    let s = state;
    for (const v of values) s = addSingle(s, v, false);
    return s;
  }
  function subtractThenAdd(
    state: Uint8Array,
    sub: Uint8Array[],
    addValues: Uint8Array[],
  ): Uint8Array {
    return add(subtract(state, sub), addValues);
  }
  return { add, subtract, subtractThenAdd };
}
