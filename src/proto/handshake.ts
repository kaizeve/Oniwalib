// Formas do `HandshakeMessage` e do `ClientPayload` — o que vai DENTRO dos
// frames do handshake Noise, em protobuf. Montado como objeto JS (o shape que o
// protobufjs produziria); a serialização real entra com o `proto/` de fio (D3).

import type { AuthCreds } from "../auth/state";
import type { ClientProfile } from "../profiles/index";

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
  opts: { phoneNumber?: string } = {},
): ClientPayload {
  const [primary, secondary, tertiary] = profile.waVersion;
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
      osVersion: profile.browser[2],
      manufacturer: "",
      device: profile.browser[1],
      osBuildNumber: profile.browser[2],
      releaseChannel: "RELEASE",
      localeLanguageIso6391: "pt",
      localeCountryIso31661Alpha2: "BR",
    },
  };

  if (creds.registered && opts.phoneNumber) {
    base.username = Number(opts.phoneNumber.replace(/\D/g, ""));
    base.device = creds.me ? 0 : 0;
    return base;
  }

  // primeiro login — carrega os dados de registro
  base.passive = false;
  base.regData = {
    eRegid: u32be(creds.registrationId),
    eKeytype: Uint8Array.from([0x05]),
    eIdent: creds.signedIdentityKey.publicKey,
    eSkeyId: u24be(creds.signedPreKey.keyId),
    eSkeyVal: creds.signedPreKey.keyPair.publicKey,
    eSkeySig: creds.signedPreKey.signature,
    buildHash: new Uint8Array(16), // md5 do appVersion — preenchido no proto de fio
    deviceProps: new Uint8Array(0),
  };
  return base;
}
