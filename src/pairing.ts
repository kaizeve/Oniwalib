// configureSuccessfulPairing — a dança de cripto do `<pair-success>`.
//
// Depois que o celular escaneia o QR, o servidor manda um
// `<iq type="set"><pair-success>` com a identidade do dispositivo assinada pela
// conta. Aqui a gente:
//
//   1. confere o HMAC da identidade (chave = advSecretKey do QR);
//   2. verifica a assinatura DA CONTA sobre  0x06 0x00 || details || idPub;
//   3. assina de volta:  deviceSignature = sign(idPriv,
//        0x06 0x01 || details || idPub || accountSignatureKey);
//   4. devolve o `<iq type="result"><pair-device-sign>` com a identidade
//      reassinada (sem a accountSignatureKey), e o patch de credenciais.
//
// Byte a byte igual a @whiskeysockets/baileys `configureSuccessfulPairing`
// (src/Utils/validate-connection.ts, master 2026-08). Toda a cripto passa pela
// interface `Crypto` — este módulo é puro.

import type { Crypto } from "./crypto/types";
import type { AuthCreds, SignalIdentity } from "./auth/state";
import { b64decode } from "./auth/state";
import { node, getBinaryNodeChild, type BinaryNode } from "./frame/node";
import { utf8Encode } from "./frame/buffer";
import {
  decodeSignedDeviceIdentityHMAC,
  decodeSignedDeviceIdentity,
  encodeSignedDeviceIdentity,
  decodeDeviceIdentity,
} from "./proto/adv";

const S_WHATSAPP_NET = "@s.whatsapp.net";

export interface PairingResult {
  /** Node a enviar de volta (`<iq type="result"><pair-device-sign>…`). */
  reply: BinaryNode;
  /** Campos a mesclar em `creds` (e persistir). */
  creds: Partial<AuthCreds>;
}

export function configureSuccessfulPairing(
  stanza: BinaryNode,
  creds: AuthCreds,
  c: Crypto,
): PairingResult {
  const msgId = stanza.attrs.id;
  if (!msgId) throw new Error("pair-success: <iq> sem id");

  const pairSuccess = getBinaryNodeChild(stanza, "pair-success");
  if (!pairSuccess) throw new Error("pair-success: nó <pair-success> ausente");

  const deviceIdentityNode = getBinaryNodeChild(pairSuccess, "device-identity");
  const platformNode = getBinaryNodeChild(pairSuccess, "platform");
  const deviceNode = getBinaryNodeChild(pairSuccess, "device");
  const bizNode = getBinaryNodeChild(pairSuccess, "biz");

  if (!deviceIdentityNode || !deviceNode) {
    throw new Error("pair-success: falta <device-identity> ou <device>");
  }
  const jid = deviceNode.attrs.jid;
  if (!jid) throw new Error("pair-success: <device> sem jid");

  const hmacIdent = decodeSignedDeviceIdentityHMAC(asBytes(deviceIdentityNode.content));

  const advSecret = b64decode(creds.advSecretKey);
  const advSign = c.hmacSha256(advSecret, hmacIdent.details);
  if (!bytesEqual(hmacIdent.hmac, advSign)) {
    throw new Error("pair-success: HMAC da identidade não confere");
  }

  const account = decodeSignedDeviceIdentity(hmacIdent.details);
  if (!account.accountSignatureKey) {
    throw new Error("pair-success: accountSignatureKey ausente");
  }

  const idPub = creds.signedIdentityKey.publicKey;

  const accountMsg = concatBytes(Uint8Array.from([6, 0]), account.details, idPub);
  if (!c.verify(account.accountSignatureKey, accountMsg, account.accountSignature)) {
    throw new Error("pair-success: assinatura da conta inválida");
  }

  const deviceMsg = concatBytes(
    Uint8Array.from([6, 1]),
    account.details,
    idPub,
    account.accountSignatureKey,
  );
  account.deviceSignature = c.sign(creds.signedIdentityKey.privateKey, deviceMsg);

  const keyIndex = decodeDeviceIdentity(account.details).keyIndex;

  // resposta: identidade reassinada, SEM a accountSignatureKey
  const accountEnc = encodeSignedDeviceIdentity(account, false);

  const reply = node("iq", { to: S_WHATSAPP_NET, type: "result", id: msgId }, [
    node("pair-device-sign", {}, [
      node("device-identity", { "key-index": String(keyIndex) }, accountEnc),
    ]),
  ]);

  const identity: SignalIdentity = {
    identifier: { name: jid, deviceId: 0 },
    identifierKey: prependKeyType(account.accountSignatureKey),
  };

  return {
    reply,
    creds: {
      me: { id: jid, name: bizNode?.attrs.name },
      account,
      signalIdentities: [...(creds.signalIdentities ?? []), identity],
      platform: platformNode?.attrs.name,
      registered: true,
      pairingCode: undefined,
    },
  };
}

// --- helpers ------------------------------------------------------------

function asBytes(content: BinaryNode["content"]): Uint8Array {
  if (content instanceof Uint8Array) return content;
  if (typeof content === "string") return utf8Encode(content);
  throw new Error("pair-success: <device-identity> sem conteúdo binário");
}

function prependKeyType(pub: Uint8Array): Uint8Array {
  if (pub.length === 33) return pub;
  const out = new Uint8Array(pub.length + 1);
  out[0] = 5;
  out.set(pub, 1);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
