import nodeCrypto from "node:crypto";
import { nodeAdapter } from "./node-adapter";
import { rtsAdapter } from "./rts-adapter";
import type { Crypto } from "./types";

export type { Crypto, KeyPair } from "./types";
export { RTS_GAPS } from "./types";
export { nodeAdapter } from "./node-adapter";
export { rtsAdapter } from "./rts-adapter";

// Escolhe o adapter pelo que o runtime oferece. Bun/Node têm
// `generateKeyPairSync` (KeyObjects); o RTS não, mas tem o trio X25519 cru.
function detect(): Crypto {
  const c = nodeCrypto as unknown as Record<string, unknown>;
  if (typeof c.generateKeyPairSync === "function") {
    return nodeAdapter;
  }
  if (typeof c.generateX25519KeyPair === "function") {
    return rtsAdapter;
  }
  // Sem nenhum dos dois: fica no node-adapter e falha alto no primeiro uso de curva.
  return nodeAdapter;
}

let current: Crypto = detect();

export function crypto(): Crypto {
  return current;
}

export function setCrypto(adapter: Crypto): void {
  current = adapter;
}
