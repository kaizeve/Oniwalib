// Fixture compartilhada: monta um `<pair-success>` VÁLIDO (o que o servidor do
// WhatsApp manda depois que o celular escaneia o QR), do ponto de vista de um
// `creds` de cliente. Usada por pairing.test.ts e client.test.ts.

import type { Crypto } from "../src/crypto/types";
import type { AuthCreds } from "../src/auth/state";
import { b64decode } from "../src/auth/state";
import { node, type BinaryNode } from "../src/frame/node";
import {
  encodeDeviceIdentity,
  encodeSignedDeviceIdentity,
  encodeSignedDeviceIdentityHMAC,
} from "../src/proto/adv";

function cat(...ps: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of ps) n += p.length;
  const o = new Uint8Array(n);
  let k = 0;
  for (const p of ps) {
    o.set(p, k);
    k += p.length;
  }
  return o;
}

export interface PairFixtureOpts {
  jid?: string;
  keyIndex?: number;
  /** Estraga o HMAC (pra testar a rejeição). */
  breakHmac?: boolean;
  /** Estraga a assinatura da conta (pra testar a rejeição). */
  breakAccountSig?: boolean;
}

export interface PairFixture {
  stanza: BinaryNode;
  jid: string;
  keyIndex: number;
  /** Par de chaves da "conta" — pra verificar a deviceSignature da resposta. */
  accountKey: { publicKey: Uint8Array; privateKey: Uint8Array };
  accountDetails: Uint8Array;
}

export function makePairSuccess(
  creds: AuthCreds,
  c: Crypto,
  opts: PairFixtureOpts = {},
): PairFixture {
  const jid = opts.jid ?? "5511999999999:23@s.whatsapp.net";
  const keyIndex = opts.keyIndex ?? 1;

  const accountKey = c.generateSigningKey();
  const idPub = creds.signedIdentityKey.publicKey;

  const accountDetails = encodeDeviceIdentity({
    rawId: 12345,
    timestamp: 1_756_500_000,
    keyIndex,
  });

  const accountMsg = cat(Uint8Array.from([6, 0]), accountDetails, idPub);
  let accountSignature = c.sign(accountKey.privateKey, accountMsg);
  if (opts.breakAccountSig) accountSignature = accountSignature.slice().fill(0);

  const account = {
    details: accountDetails,
    accountSignatureKey: accountKey.publicKey,
    accountSignature,
  };
  const signedIdentity = encodeSignedDeviceIdentity(account, true);

  let hmac = c.hmacSha256(b64decode(creds.advSecretKey), signedIdentity);
  if (opts.breakHmac) hmac = hmac.slice().fill(0);

  const hmacIdentity = encodeSignedDeviceIdentityHMAC({ details: signedIdentity, hmac });

  const stanza = node("iq", { from: "@s.whatsapp.net", type: "set", id: "pair-1" }, [
    node("pair-success", {}, [
      node("device-identity", {}, hmacIdentity),
      node("device", { jid }),
      node("platform", { name: "oniwalib-mock" }),
      node("biz", { name: "Conta de Teste" }),
    ]),
  ]);

  return { stanza, jid, keyIndex, accountKey, accountDetails };
}
