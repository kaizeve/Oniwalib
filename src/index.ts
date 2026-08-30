// oniwalib — cliente WhatsApp Multi-Device sobre o RTS (nome provisório).
//
// Estado (2026-08-30). Roda em bun/node HOJE; roda no RTS nas partes que não
// dependem da Fase 0.
//
//   frame/    codec WABinary (encode/decode de binary node)     ✔  RTS ✔
//   noise/    handshake XX + enquadramento — LÓGICA pura          ✔  RTS ✔ (lógica)
//   crypto/   interface + adapter node:crypto de referência       ✔  RTS parcial
//   proto/    builders de body de mensagem + shapes de handshake  ✔  RTS ✔
//   auth/     credenciais + cofre de chaves Signal                ✔  RTS parcial
//   events/   superfície de eventos tipada                        ✔  RTS ✔ (esqueleto)
//   profiles/ camada original vs modificada                       ✔  RTS ✔ (esqueleto)
//
// Bloqueado na Fase 0 (cripto no motor do RTS): AES-GCM/CBC via createCipheriv,
// X25519, assinatura Ed25519. Sem isso: transport/, registro, e o adapter
// nativo do RTS.

export * as frame from "./frame/index";
export * as message from "./proto/message";
export * as handshakeProto from "./proto/handshake";

export { NoiseHandshake, type HandshakeResult } from "./noise/handshake";
export { FrameDecoder, encodeFrame, introHeader } from "./noise/frame";

export {
  crypto,
  setCrypto,
  nodeAdapter,
  rtsAdapter,
  RTS_GAPS,
  type Crypto,
  type KeyPair,
} from "./crypto";

export {
  initAuthCreds,
  memoryAuthState,
  b64,
  b64decode,
  type AuthCreds,
  type AuthenticationState,
  type SignalKeyStore,
} from "./auth/state";

export { Emitter, type OniwalibEvents, type MessageKey } from "./events/emitter";
export {
  STOCK,
  MODIFIED,
  resolveProfile,
  type ClientProfile,
} from "./profiles/index";
