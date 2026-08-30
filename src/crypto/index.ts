import { nodeAdapter } from "./node-adapter";
import type { Crypto } from "./types";

export type { Crypto, KeyPair } from "./types";
export { RTS_GAPS } from "./types";
export { nodeAdapter } from "./node-adapter";

// O adapter default. Quando o RTS ganhar as primitivas da Fase 0, aqui vira uma
// checagem: se rodando no RTS e o nativo estiver completo, usa `rtsAdapter`.
let current: Crypto = nodeAdapter;

export function crypto(): Crypto {
  return current;
}

export function setCrypto(adapter: Crypto): void {
  current = adapter;
}
