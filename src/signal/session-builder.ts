// SessionBuilder — X3DH. Cria a `SessionEntry` inicial dos dois lados:
//
//   initOutgoing(addr, bundle)  — nós iniciamos (Alice). Buscamos o bundle de
//     pré-chaves do par, geramos a `baseKey` efêmera, derivamos a rootKey e já
//     montamos a primeira sending chain. A `pendingPreKey` vira o envelope
//     `pkmsg` na 1ª mensagem.
//   initIncoming(record, pkmsg) — recebemos um `pkmsg` (Bob). Refazemos os
//     mesmos DHs do outro lado, consumindo a nossa pré-chave e a signedPreKey.
//
// Portado passo a passo de `libsignal/src/session_builder.js` (v6). Toda a
// cripto passa por `Crypto`/`Curve`.

import type { Crypto } from "../crypto/types";
import { type Curve, type SignalKeyPair } from "./curve";
import { deriveSecrets } from "./kdf";
import type { SignalStorage } from "./store";
import type { PreKeyWhisperMessage } from "./protocol";
import {
  SessionEntry,
  SessionRecord,
  CHAIN_SENDING,
  BASE_KEY_OURS,
  BASE_KEY_THEIRS,
} from "./session-record";

export interface SignalDeps {
  c: Crypto;
  curve: Curve;
  storage: SignalStorage;
}

export interface PreKeyBundle {
  registrationId: number;
  /** 33 bytes (DJB). */
  identityKey: Uint8Array;
  signedPreKey: { keyId: number; publicKey: Uint8Array; signature: Uint8Array };
  preKey?: { keyId: number; publicKey: Uint8Array };
}

const WHISPER_TEXT = ascii("WhisperText");
const WHISPER_RATCHET = ascii("WhisperRatchet");

function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
}
function copy(u: Uint8Array): Uint8Array {
  return u.slice();
}

async function initSession(
  deps: SignalDeps,
  isInitiator: boolean,
  ourEphemeralKey: SignalKeyPair | undefined,
  ourSignedKey: SignalKeyPair | undefined,
  theirIdentityPubKey: Uint8Array,
  theirEphemeralPubKey: Uint8Array | undefined,
  theirSignedPubKey: Uint8Array | undefined,
  registrationId: number,
): Promise<SessionEntry> {
  const { c, curve, storage } = deps;

  if (isInitiator) {
    if (ourSignedKey) throw new Error("initSession: initiator não passa ourSignedKey");
    ourSignedKey = ourEphemeralKey;
  } else {
    if (theirSignedPubKey) throw new Error("initSession: responder não passa theirSignedPubKey");
    theirSignedPubKey = theirEphemeralPubKey;
  }

  const sharedSecret =
    !ourEphemeralKey || !theirEphemeralPubKey
      ? new Uint8Array(32 * 4)
      : new Uint8Array(32 * 5);
  for (let i = 0; i < 32; i++) sharedSecret[i] = 0xff;

  const ourIdentityKey = storage.getOurIdentity();
  const a1 = curve.calculateAgreement(theirSignedPubKey!, ourIdentityKey.privKey);
  const a2 = curve.calculateAgreement(theirIdentityPubKey, ourSignedKey!.privKey);
  const a3 = curve.calculateAgreement(theirSignedPubKey!, ourSignedKey!.privKey);
  if (isInitiator) {
    sharedSecret.set(a1, 32);
    sharedSecret.set(a2, 32 * 2);
  } else {
    sharedSecret.set(a1, 32 * 2);
    sharedSecret.set(a2, 32);
  }
  sharedSecret.set(a3, 32 * 3);
  if (ourEphemeralKey && theirEphemeralPubKey) {
    const a4 = curve.calculateAgreement(theirEphemeralPubKey, ourEphemeralKey.privKey);
    sharedSecret.set(a4, 32 * 4);
  }

  // Só a rootKey ([0]) é usada aqui; a chain vem depois (Alice via
  // calculateSendingRatchet, Bob via calculateRatchet no 1º maybeStepRatchet).
  const [rootKey] = deriveSecrets(c, sharedSecret, new Uint8Array(32), WHISPER_TEXT);

  const session = new SessionEntry();
  session.registrationId = registrationId;
  session.currentRatchet = {
    rootKey: copy(rootKey),
    ephemeralKeyPair: isInitiator ? curve.generateKeyPair() : ourSignedKey!,
    lastRemoteEphemeralKey: copy(theirSignedPubKey!),
    previousCounter: 0,
  };
  session.indexInfo = {
    created: Date.now(),
    used: Date.now(),
    remoteIdentityKey: copy(theirIdentityPubKey),
    baseKey: isInitiator ? ourEphemeralKey!.pubKey : copy(theirEphemeralPubKey!),
    baseKeyType: isInitiator ? BASE_KEY_OURS : BASE_KEY_THEIRS,
    closed: -1,
  };

  if (isInitiator) calculateSendingRatchet(deps, session, theirSignedPubKey!);
  return session;
}

function calculateSendingRatchet(deps: SignalDeps, session: SessionEntry, remoteKey: Uint8Array): void {
  const { c, curve } = deps;
  const ratchet = session.currentRatchet;
  const sharedSecret = curve.calculateAgreement(remoteKey, ratchet.ephemeralKeyPair.privKey);
  const [newRoot, chainKey] = deriveSecrets(c, sharedSecret, ratchet.rootKey, WHISPER_RATCHET);
  session.addChain(ratchet.ephemeralKeyPair.pubKey, {
    messageKeys: {},
    chainKey: { counter: -1, key: copy(chainKey) },
    chainType: CHAIN_SENDING,
  });
  ratchet.rootKey = copy(newRoot);
}

export async function initOutgoing(deps: SignalDeps, addr: string, bundle: PreKeyBundle): Promise<void> {
  const { curve, storage } = deps;
  if (!(await storage.isTrustedIdentity(addr, bundle.identityKey))) {
    throw new Error(`initOutgoing: identidade de ${addr} não confiável`);
  }
  // A libsignal pula a verificação da assinatura da signedPreKey no fluxo de
  // saída (isInit=true). Verificamos por higiene, sem abortar.
  if (
    bundle.signedPreKey.signature.length === 64 &&
    !curve.verifySignature(bundle.identityKey, bundle.signedPreKey.publicKey, bundle.signedPreKey.signature)
  ) {
    // eslint-disable-next-line no-console
    console.warn(`initOutgoing: assinatura da signedPreKey de ${addr} não confere`);
  }

  const baseKey = curve.generateKeyPair();
  const session = await initSession(
    deps,
    true,
    baseKey,
    undefined,
    bundle.identityKey,
    bundle.preKey?.publicKey,
    bundle.signedPreKey.publicKey,
    bundle.registrationId,
  );
  session.pendingPreKey = {
    signedKeyId: bundle.signedPreKey.keyId,
    baseKey: baseKey.pubKey,
    ...(bundle.preKey ? { preKeyId: bundle.preKey.keyId } : {}),
  };

  let record = await storage.loadSession(addr);
  if (!record) {
    record = new SessionRecord();
  } else {
    const open = record.getOpenSession();
    if (open) record.closeSession(open);
  }
  record.setSession(session);
  await storage.storeSession(addr, record);
}

export async function initIncoming(
  deps: SignalDeps,
  record: SessionRecord,
  message: PreKeyWhisperMessage,
): Promise<number | undefined> {
  const { storage } = deps;

  if (record.getSession(message.baseKey)) return undefined; // já criada (ainda não respondemos)

  const preKeyPair =
    message.preKeyId !== undefined ? await storage.loadPreKey(message.preKeyId) : undefined;
  if (message.preKeyId !== undefined && !preKeyPair) {
    throw new Error(`initIncoming: preKey ${message.preKeyId} não encontrada`);
  }
  const signedPreKeyPair = await storage.loadSignedPreKey(message.signedPreKeyId);
  if (!signedPreKeyPair) throw new Error("initIncoming: signedPreKey ausente");

  const open = record.getOpenSession();
  if (open) record.closeSession(open);

  record.setSession(
    await initSession(
      deps,
      false,
      preKeyPair,
      signedPreKeyPair,
      message.identityKey,
      message.baseKey,
      undefined,
      message.registrationId,
    ),
  );
  return message.preKeyId;
}
