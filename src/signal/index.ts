// Camada Signal nativa do oniwalib — Double Ratchet + X3DH 1:1, escrita sobre a
// interface `Crypto` (portável pro RTS). Estudada da `libsignal-node`
// (WhiskeySockets), não importada.
//
// Fase 1: conversa 1:1 em texto + LEITURA de grupo (sender keys — ver
// `sender-key.ts`). Enviar em grupo, retry receipts e USync são fase 2.

export {
  KEY_TYPE,
  prefixKey,
  stripKey,
  makeCurve,
  type Curve,
  type SignalKeyPair,
} from "./curve";
export { deriveSecrets } from "./kdf";
export {
  CIPHERTEXT_MESSAGE_VERSION,
  MAC_LENGTH,
  VERSION_BYTE,
  decodeVersionByte,
  encodeWhisperMessage,
  decodeWhisperMessage,
  encodePreKeyWhisperMessage,
  decodePreKeyWhisperMessage,
  type WhisperMessage,
  type PreKeyWhisperMessage,
} from "./protocol";
export {
  SessionEntry,
  SessionRecord,
  CHAIN_SENDING,
  CHAIN_RECEIVING,
  BASE_KEY_OURS,
  BASE_KEY_THEIRS,
} from "./session-record";
export {
  initOutgoing,
  initIncoming,
  type SignalDeps,
  type PreKeyBundle,
} from "./session-builder";
export {
  encrypt,
  decryptWhisperMessage,
  decryptPreKeyWhisperMessage,
  type EncryptResult,
} from "./session-cipher";
export { makeSignalStorage, type SignalStorage } from "./store";
export {
  SenderKeyRecord,
  processSenderKeyDistribution,
  groupDecrypt,
  createSenderKeyDistribution,
  groupEncrypt,
  buildSKDM,
} from "./sender-key";
export {
  generateOrGetPreKeys,
  buildPreKeyUploadNode,
  type PreKeyUpload,
  type PreKeyPair,
} from "./prekeys";
