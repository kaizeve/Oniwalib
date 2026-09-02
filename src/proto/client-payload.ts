// Serialização do `ClientPayload` de registro (QR) — byte a byte igual ao que
// a Baileys manda (`generateRegistrationNode`), conferido contra
// `WAProto/WAProto.proto` (master, 2026-08).
//
// WAProto usa `optional` (proto2): um campo setado É serializado mesmo valendo
// 0/false. Por isso os `*F` (force) do Writer aqui.

import { Writer } from "./wire";
import type { ClientPayload } from "./handshake";

// enums
const PLATFORM_WEB = 14;
const RELEASE_CHANNEL_RELEASE = 0;
const WEBSUB_WEB_BROWSER = 0;
const CONNECT_TYPE_WIFI_UNKNOWN = 1;
const CONNECT_REASON_USER_ACTIVATED = 1;
const DEVICEPROPS_PLATFORMTYPE_CHROME = 1;

function appVersion(v: { primary: number; secondary: number; tertiary: number }): Writer {
  return new Writer().uint(1, v.primary).uint(2, v.secondary).uint(3, v.tertiary);
}

// ClientPayload.UserAgent — campos 1..12
function userAgent(ua: ClientPayload["userAgent"]): Writer {
  return new Writer()
    .uint(1, PLATFORM_WEB) // platform
    .message(2, appVersion(ua.appVersion))
    .string(3, ua.mcc)
    .string(4, ua.mnc)
    .string(5, ua.osVersion)
    // 6 = manufacturer: a Baileys omite (string vazia)
    .string(7, ua.device)
    .string(8, ua.osBuildNumber)
    .uintF(10, RELEASE_CHANNEL_RELEASE) // releaseChannel, escrito mesmo 0
    .string(11, ua.localeLanguageIso6391)
    .string(12, ua.localeCountryIso31661Alpha2);
}

// DeviceProps.HistorySyncConfig — os mesmos bools que a Baileys manda.
function historySyncConfig(): Writer {
  return new Writer()
    .uint(3, 10240) // storageQuotaMb
    .boolF(4, true) // inlineInitialPayloadInE2EeMsg
    .boolF(6, false) // supportCallLogHistory
    .boolF(7, true) // supportBotUserAgentChatHistory
    .boolF(8, true) // supportCagReactionsAndPolls
    .boolF(9, true) // supportBizHostedMsg
    .boolF(10, true) // supportRecentSyncChunkMessageCountTuning
    .boolF(11, true) // supportHostedGroupMsg
    .boolF(12, true) // supportFbidBotChatHistory
    .boolF(14, true) // supportMessageAssociation
    .boolF(15, false); // supportGroupHistory
}

// DeviceProps — o blob de devicePairingData.deviceProps (campo 8).
export function encodeDeviceProps(opts: {
  os: string;
  version: { primary: number; secondary: number; tertiary: number };
  requireFullSync?: boolean;
}): Uint8Array {
  return new Writer()
    .string(1, opts.os)
    .message(2, appVersion(opts.version))
    .uint(3, DEVICEPROPS_PLATFORMTYPE_CHROME) // platformType
    .boolF(4, opts.requireFullSync ?? false) // requireFullSync, escrito
    .message(5, historySyncConfig())
    .finish();
}

// ClientPayload.DevicePairingRegistrationData — campos 1..8
function regData(r: NonNullable<ClientPayload["regData"]>): Writer {
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

// ClientPayload — ordem e presença iguais ao generateRegistrationNode:
// passive(3), userAgent(5), webInfo(6), connectType(12), connectReason(13),
// devicePairingData(19), pull(33).
export function encodeClientPayload(cp: ClientPayload): Uint8Array {
  const w = new Writer();
  if (cp.username) w.uint(1, cp.username);
  w.boolF(3, cp.passive); // passive, escrito mesmo false
  w.message(5, userAgent(cp.userAgent));
  w.message(6, new Writer().uintF(4, WEBSUB_WEB_BROWSER)); // webInfo{ webSubPlatform=0 }
  w.uint(12, CONNECT_TYPE_WIFI_UNKNOWN);
  w.uint(13, CONNECT_REASON_USER_ACTIVATED);
  if (cp.device !== undefined) w.uintF(18, cp.device); // optional proto2 — escrito mesmo 0
  if (cp.regData) w.message(19, regData(cp.regData));
  w.boolF(33, cp.pull ?? false); // pull — true no login
  return w.finish();
}
