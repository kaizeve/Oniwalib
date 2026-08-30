// connectOni — abre o WebSocket, roda o handshake Noise, devolve um
// `NoiseSocket` conectado. É o ponto de entrada para falar com o WhatsApp.
//
// O que ainda NÃO faz: validar o certificado Noise do servidor (issue #6),
// parear (issue #3), decifrar mensagens (libsignal, issue #5). Depois do
// handshake você recebe os nodes crus em `socket.events.on("node.recv", …)`.

import { inflateSync } from "node:zlib";
import { crypto } from "./crypto";
import type { AuthenticationState } from "./auth/state";
import { b64 } from "./auth/state";
import { NoiseSocket } from "./noise/socket";
import type { Transport } from "./transport/types";
import { WA_WS_ENDPOINT, WA_WS_ORIGIN, type Connector } from "./transport/types";
import { WebSocketTransport } from "./transport/websocket";
import { STOCK, type ClientProfile } from "./profiles/index";
import { buildClientPayload } from "./proto/handshake";
import { encodeClientPayload, encodeDeviceProps } from "./proto/client-payload";
import { resolveOniVersion, versionBuildHash, type OniVersion } from "./version";
import {
  getBinaryNodeChild,
  getBinaryNodeChildren,
  type BinaryNode,
} from "./frame/node";
import { utf8Decode } from "./frame/buffer";

export interface ConnectOptions {
  auth: AuthenticationState;
  profile?: ClientProfile;
  /** Fixa a versão do protocolo. Sem isto, `resolveOniVersion()`. */
  version?: OniVersion;
  url?: string;
  /** Conector de transporte. Default: `WebSocketTransport.connect` (bun/node). */
  connector?: Connector;
  countryCode?: string;
  timeout?: number;
  /** Chamado com o `NoiseSocket` recém-criado, ANTES do `connect()` — para
   *  registrar listeners de `node.recv` sem correr risco de perder o primeiro
   *  stanza (o `<pair-device>` / `<success>` chega logo após o handshake). */
  onSocket?: (socket: NoiseSocket) => void;
}

export interface Connection {
  socket: NoiseSocket;
  transport: Transport;
  version: OniVersion;
}

export async function connectOni(opts: ConnectOptions): Promise<Connection> {
  const c = crypto();
  const version = opts.version ?? (await resolveOniVersion()).version;

  const profile: ClientProfile = {
    ...(opts.profile ?? STOCK),
    waVersion: version,
  };

  const buildHash = versionBuildHash(version, c);
  const deviceProps = encodeDeviceProps({
    os: profile.browser[0],
    version: { primary: 10, secondary: 15, tertiary: 7 },
  });
  const payload = buildClientPayload(opts.auth.creds, profile, {
    buildHash,
    deviceProps,
    countryCode: opts.countryCode,
  });

  const connect = opts.connector ?? WebSocketTransport.connect;
  const transport = await connect({
    url: opts.url ?? WA_WS_ENDPOINT,
    origin: WA_WS_ORIGIN,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    },
    timeout: opts.timeout ?? 20000,
  });

  const socket = new NoiseSocket({
    transport,
    crypto: c,
    staticKey: opts.auth.creds.noiseKey,
    clientPayload: encodeClientPayload(payload),
    inflate: (d) => new Uint8Array(inflateSync(d)),
  });

  opts.onSocket?.(socket);

  await socket.connect();
  return { socket, transport, version };
}

// --- QR --------------------------------------------------------------

export interface PairDeviceRefs {
  /** Os refs `<ref>` que o servidor manda; o primeiro é o corrente. */
  refs: string[];
  ttlMs: number;
}

/** Extrai os refs de um `<iq><pair-device>` que o servidor envia no fluxo QR. */
export function readPairDevice(iq: BinaryNode): PairDeviceRefs | undefined {
  const pd = getBinaryNodeChild(iq, "pair-device");
  if (!pd) return undefined;
  const refs = getBinaryNodeChildren(pd, "ref").map((r) =>
    typeof r.content === "string"
      ? r.content
      : r.content instanceof Uint8Array
        ? utf8Decode(r.content)
        : "",
  );
  return { refs: refs.filter(Boolean), ttlMs: 20000 };
}

/** Monta a string do QR: `ref,noiseKeyB64,identityKeyB64,advSecretKeyB64`. */
export function buildQrString(ref: string, auth: AuthenticationState): string {
  const { creds } = auth;
  return [
    ref,
    b64(creds.noiseKey.publicKey),
    b64(creds.signedIdentityKey.publicKey),
    creds.advSecretKey,
  ].join(",");
}
