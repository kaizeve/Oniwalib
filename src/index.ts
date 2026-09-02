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
export { Reader as ProtoReader, Writer as ProtoWriter } from "./proto/wire";
export { encodeClientPayload } from "./proto/client-payload";
export { buildClientPayload } from "./proto/handshake";
export {
  decodeSignedDeviceIdentityHMAC,
  decodeSignedDeviceIdentity,
  encodeSignedDeviceIdentity,
  decodeDeviceIdentity,
  encodeDeviceIdentity,
  type ADVSignedDeviceIdentity,
  type ADVSignedDeviceIdentityHMAC,
  type ADVDeviceIdentity,
} from "./proto/adv";

export { NoiseHandshake, type HandshakeResult } from "./noise/handshake";
export { FrameDecoder, encodeFrame, introHeader } from "./noise/frame";
export { NoiseSocket, type NoiseSocketOptions } from "./noise/socket";
export {
  type Transport,
  type Connector,
  type ConnectOptions,
  WA_WS_ENDPOINT,
  WA_WS_ORIGIN,
} from "./transport/types";
export { mockTransportPair } from "./transport/mock";
export {
  connectOni,
  readPairDevice,
  buildQrString,
  type Connection,
  type ConnectOptions as ConnectOniOptions,
  type PairDeviceRefs,
} from "./connect";
export { WebSocketTransport } from "./transport/websocket";
export { encodeDeviceProps } from "./proto/client-payload";

export {
  configureSuccessfulPairing,
  type PairingResult,
} from "./pairing";
export {
  openWhatsApp,
  type OpenOptions,
  type OniConnection,
} from "./client";

export {
  createMessagesLayer,
  type MessagesLayer,
  type MessagesLayerOptions,
} from "./messages";

export {
  createMediaLayer,
  type MediaLayer,
  type MediaLayerOptions,
  type MediaType,
  type AudioOptions,
  type ImageOptions,
  type VideoOptions,
  type DocumentOptions,
  type StickerOptions,
  type FetchLike,
} from "./media";
export {
  createProfileLayer,
  type ProfileLayer,
  type ProfileLayerOptions,
} from "./profile";
export {
  createPrivacyLayer,
  type PrivacyLayer,
  type PrivacyLayerOptions,
  type PrivacyCategory,
  type PrivacyValue,
  type PrivacySettings,
} from "./privacy";
export {
  createUSyncLayer,
  jidNormalizedUser,
  type USyncLayer,
  type USyncLayerOptions,
} from "./usync";
export {
  createGroupsLayer,
  extractGroupMetadata,
  type GroupsLayer,
  type GroupsLayerOptions,
  type GroupMetadata,
  type GroupParticipant,
} from "./groups";

export {
  createPresenceLayer,
  type PresenceLayer,
  type PresenceLayerOptions,
} from "./presence";
export {
  createNotificationsLayer,
  type NotificationsLayer,
  type NotificationsLayerOptions,
} from "./notifications";

export * as signal from "./signal/index";
export {
  encodeE2EMessage,
  decodeE2EMessage,
  messageText,
  type E2EMessage,
  type E2EAudioMessage,
  type E2EImageMessage,
  type E2EVideoMessage,
  type E2EDocumentMessage,
  type E2EStickerMessage,
  type E2EButtonsMessage,
  type E2EListMessage,
  type E2EListRow,
  type E2EMessageKey,
  type E2EReactionMessage,
  type E2EProtocolMessage,
} from "./proto/e2e-message";

export { MockWaServer, type MockMessage } from "./transport/mock-wa-server";

export {
  OniBot,
  asciiTable,
  type IncomingMessage,
  type CommandHandler,
  type CommandReply,
  type OniBotOptions,
} from "./bot/bot";
export { Monitor, humanBytes, humanDuration, type Stats } from "./bot/monitor";

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
  type SignalDataType,
  type SignalKeyStore,
  type SignalIdentity,
} from "./auth/state";
export {
  fileAuthState,
  AuthStoreCorruptError,
  type FileAuthState,
  type FileAuthOptions,
} from "./auth/file-state";

export {
  Emitter,
  type OniwalibEvents,
  type MessageKey,
  type WAPresence,
  type PresenceData,
  type ContactUpdate,
} from "./events/emitter";
export {
  STOCK,
  MODIFIED,
  resolveProfile,
  type ClientProfile,
} from "./profiles/index";

export {
  resolveOniVersion,
  fetchLatestOniVersion,
  versionBuildHash,
  memoryVersionStore,
  DEFAULT_ONI_VERSION,
  DEFAULT_SOURCES,
  type OniVersion,
  type VersionStore,
  type ResolveOptions,
  type ResolvedVersion,
} from "./version";
