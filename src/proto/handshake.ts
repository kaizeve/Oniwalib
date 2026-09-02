// Formas do `HandshakeMessage` e do `ClientPayload` — o que vai DENTRO dos
// frames do handshake Noise, em protobuf. Montado como objeto JS (o shape que o
// protobufjs produziria); a serialização real entra com o `proto/` de fio (D3).

import type { AuthCreds } from "../auth/state";
import type { ClientProfile } from "../profiles/index";
import { jidDecode } from "../frame/jid";

export interface HandshakeMessage {
  clientHello?: { ephemeral: Uint8Array };
  serverHello?: {
    ephemeral: Uint8Array;
    static: Uint8Array;
    payload: Uint8Array;
  };
  clientFinish?: { static: Uint8Array; payload: Uint8Array };
}

export interface ClientPayload {
  username?: number; // número de telefone como inteiro, quando já registrado
  passive: boolean;
  pull?: boolean; // `true` no login (reconexão já registrada)
  userAgent: {
    platform: "WEB";
    appVersion: { primary: number; secondary: number; tertiary: number };
    mcc: string;
    mnc: string;
    osVersion: string;
    manufacturer: string;
    device: string;
    osBuildNumber: string;
    releaseChannel: "RELEASE";
    localeLanguageIso6391: string;
    localeCountryIso31661Alpha2: string;
  };
  webInfo: { webSubPlatform: "WEB_BROWSER" };
  connectType: "WIFI_UNKNOWN";
  connectReason: "USER_ACTIVATED";
  device?: number;
  // fluxo de registro (primeiro login, via pairing code / QR)
  regData?: {
    eRegid: Uint8Array; // registrationId big-endian 4 bytes
    eKeytype: Uint8Array; // 0x05
    eIdent: Uint8Array; // pública da identidade
    eSkeyId: Uint8Array; // signedPreKey.keyId 3 bytes
    eSkeyVal: Uint8Array; // signedPreKey pública
    eSkeySig: Uint8Array; // assinatura da signedPreKey
    buildHash: Uint8Array;
    deviceProps: Uint8Array;
  };
}

function u32be(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function u24be(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

export function buildClientPayload(
  creds: AuthCreds,
  profile: ClientProfile,
  opts: {
    phoneNumber?: string;
    /** md5(`major.minor.patch`) — obrigatório no registro real. */
    buildHash?: Uint8Array;
    /** `DeviceProps` serializado (ver `encodeDeviceProps`). */
    deviceProps?: Uint8Array;
    countryCode?: string;
  } = {},
): ClientPayload {
  const [primary, secondary, tertiary] = profile.waVersion;
  // Valores que a Baileys manda (validate-connection.ts getUserAgent):
  const base: ClientPayload = {
    passive: false,
    connectType: "WIFI_UNKNOWN",
    connectReason: "USER_ACTIVATED",
    webInfo: { webSubPlatform: "WEB_BROWSER" },
    userAgent: {
      platform: "WEB",
      appVersion: { primary, secondary, tertiary },
      mcc: "000",
      mnc: "000",
      osVersion: "0.1",
      manufacturer: "",
      device: "Desktop",
      osBuildNumber: "0.1",
      releaseChannel: "RELEASE",
      localeLanguageIso6391: "en",
      localeCountryIso31661Alpha2: opts.countryCode ?? "US",
    },
  };

  // Login (reconexão já registrada): número e device saem do JID do próprio
  // dispositivo (`creds.me.id`), como o `generateLoginNode` da Baileys. Sem
  // regData — só `username` + `device` + `pull`.
  const meJid = creds.registered ? creds.me?.id : undefined;
  if (meJid) {
    const dec = jidDecode(meJid);
    base.passive = true;
    base.pull = true;
    base.username = Number((dec?.user ?? "").replace(/\D/g, ""));
    base.device = dec?.device ?? 0;
    return base;
  }

  if (creds.registered && opts.phoneNumber) {
    base.passive = true;
    base.pull = true;
    base.username = Number(opts.phoneNumber.replace(/\D/g, ""));
    base.device = 0;
    return base;
  }

  // primeiro login (QR) — carrega os dados de registro
  base.passive = false;
  base.regData = {
    eRegid: u32be(creds.registrationId),
    eKeytype: Uint8Array.from([0x05]),
    eIdent: creds.signedIdentityKey.publicKey,
    eSkeyId: u24be(creds.signedPreKey.keyId),
    eSkeyVal: creds.signedPreKey.keyPair.publicKey,
    eSkeySig: creds.signedPreKey.signature,
    // md5("major.minor.patch") — ver `versionBuildHash`. Sem ele, 16 zeros
    // (o servidor recusa; passe `opts.buildHash` no registro real).
    buildHash: opts.buildHash ?? new Uint8Array(16),
    deviceProps: opts.deviceProps ?? new Uint8Array(0),
  };
  return base;
}
