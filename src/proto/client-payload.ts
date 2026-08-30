// Serialização do `ClientPayload` para protobuf — o que vai cifrado no
// ClientFinish do handshake.
//
// NÚMEROS DE CAMPO: best-effort do WAProto da Baileys. Precisam ser conferidos
// contra a versão fixada (decisão D5) — um número errado aqui e o servidor
// rejeita o login. Os testes fazem round-trip (encode→decode→igual), que prova
// o codec; a correspondência com o WhatsApp real se confirma diffando o WAProto.

import { Writer } from "./wire";
import type { ClientPayload } from "./handshake";

// enums (valores do WAProto — CONFERIR na versão fixada, D5).
// Atenção proto3: valor 0 = default = NÃO vai no fio. Por isso os que precisam
// ir têm valor != 0.
const PLATFORM_WEB = 6; // UserAgent.Platform.WEB
const RELEASE_CHANNEL_RELEASE = 0; // ReleaseChannel.RELEASE (omitido — é o default)
const WEBSUB_WEB_BROWSER = 0; // WebInfo...WEB_BROWSER (omitido — default)
const CONNECT_TYPE_WIFI_UNKNOWN = 1; // ConnectType.WIFI_UNKNOWN
const CONNECT_REASON_USER_ACTIVATED = 1; // ConnectReason.USER_ACTIVATED

function encodeAppVersion(v: { primary: number; secondary: number; tertiary: number }): Writer {
  return new Writer().uint(1, v.primary).uint(2, v.secondary).uint(3, v.tertiary);
}

function encodeUserAgent(ua: ClientPayload["userAgent"]): Writer {
  return new Writer()
    .uint(1, PLATFORM_WEB)
    .message(2, encodeAppVersion(ua.appVersion))
    .string(3, ua.mcc)
    .string(4, ua.mnc)
    .string(5, ua.osVersion)
    .string(6, ua.manufacturer)
    .string(7, ua.device)
    .string(8, ua.osBuildNumber)
    .uint(10, RELEASE_CHANNEL_RELEASE)
    .string(12, ua.localeLanguageIso6391)
    .string(13, ua.localeCountryIso31661Alpha2);
}

function encodeRegData(r: NonNullable<ClientPayload["regData"]>): Writer {
  return new Writer()
    .bytes(1, r.eRegid)
    .bytes(2, r.eKeytype)
    .bytes(3, r.eIdent)
    .bytes(4, r.eSkeyId)
    .bytes(5, r.eSkeyVal)
    .bytes(6, r.eSkeySig)
    .bytes(7, r.buildHash)
    .bytes(8, r.deviceProps);
}

export function encodeClientPayload(cp: ClientPayload): Uint8Array {
  const w = new Writer();
  if (cp.username) w.uint(1, cp.username);
  w.bool(3, cp.passive);
  w.message(5, encodeUserAgent(cp.userAgent));
  w.message(6, new Writer().uint(7, WEBSUB_WEB_BROWSER));
  w.uint(12, CONNECT_TYPE_WIFI_UNKNOWN);
  w.uint(13, CONNECT_REASON_USER_ACTIVATED);
  if (cp.device !== undefined) w.uint(18, cp.device);
  if (cp.regData) w.message(19, encodeRegData(cp.regData));
  return w.finish();
}
