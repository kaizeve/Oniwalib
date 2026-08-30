// SessionCipher — cifra/decifra `msg`/`pkmsg` numa sessão 1:1.
//
//   encrypt(addr, plaintext) → { type: 1|3, body }
//       type 1 = "msg", type 3 = "pkmsg" (leva o envelope PreKeyWhisperMessage).
//   decryptPreKeyWhisperMessage(addr, bytes) → plaintext   (para "pkmsg")
//   decryptWhisperMessage(addr, bytes)       → plaintext   (para "msg")
//
// O passo do ratchet DH (`maybeStepRatchet`), o avanço da chain
// (`fillMessageKeys`) e o formato MAC são idênticos a
// `libsignal/src/session_cipher.js` (v6). A cripto passa por `Crypto`.

import {
  CHAIN_RECEIVING,
  CHAIN_SENDING,
  SessionEntry,
  SessionRecord,
  type Chain,
} from "./session-record";
import { deriveSecrets } from "./kdf";
import {
  MAC_LENGTH,
  VERSION_BYTE,
  decodeVersionByte,
  decodeWhisperMessage,
  encodeWhisperMessage,
  decodePreKeyWhisperMessage,
  encodePreKeyWhisperMessage,
} from "./protocol";
import { initIncoming, type SignalDeps } from "./session-builder";

const WHISPER_RATCHET = ascii("WhisperRatchet");
const WHISPER_MESSAGE_KEYS = ascii("WhisperMessageKeys");

function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
}
function copy(u: Uint8Array): Uint8Array {
  return u.slice();
}
function concat(...parts: Uint8Array[]): Uint8Array {
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
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}
const hasOwn = (o: object, k: PropertyKey) => Object.prototype.hasOwnProperty.call(o, k);

export interface EncryptResult {
  type: 1 | 3;
  body: Uint8Array;
  registrationId: number;
}

export async function encrypt(
  deps: SignalDeps,
  addr: string,
  data: Uint8Array,
): Promise<EncryptResult> {
  const { c, storage } = deps;
  const ourIdentityKey = storage.getOurIdentity();

  const record = await storage.loadSession(addr);
  if (!record) throw new Error(`encrypt: sem sessão com ${addr}`);
  const session = record.getOpenSession();
  if (!session) throw new Error(`encrypt: sem sessão aberta com ${addr}`);

  const chain = session.getChain(session.currentRatchet.ephemeralKeyPair.pubKey);
  if (!chain || chain.chainType === CHAIN_RECEIVING) {
    throw new Error("encrypt: chain de envio ausente / é de recepção");
  }

  fillMessageKeys(c, chain, chain.chainKey.counter + 1);
  const counter = chain.chainKey.counter;
  const [cipherKey, macKey, ivFull] = deriveSecrets(
    c,
    chain.messageKeys[counter]!,
    new Uint8Array(32),
    WHISPER_MESSAGE_KEYS,
  );
  delete chain.messageKeys[counter];

  const ciphertext = c.aesCbcEncrypt(cipherKey, ivFull.subarray(0, 16), data);
  const msgBuf = encodeWhisperMessage({
    ephemeralKey: session.currentRatchet.ephemeralKeyPair.pubKey,
    counter,
    previousCounter: session.currentRatchet.previousCounter,
    ciphertext,
  });
  const macInput = concat(
    ourIdentityKey.pubKey,
    session.indexInfo.remoteIdentityKey,
    Uint8Array.from([VERSION_BYTE]),
    msgBuf,
  );
  const mac = c.hmacSha256(macKey, macInput).subarray(0, MAC_LENGTH);
  const result = concat(Uint8Array.from([VERSION_BYTE]), msgBuf, mac);

  session.indexInfo.used = Date.now();
  await storage.storeSession(addr, record);

  if (session.pendingPreKey) {
    const pkm = encodePreKeyWhisperMessage({
      registrationId: storage.getOurRegistrationId(),
      preKeyId: session.pendingPreKey.preKeyId,
      signedPreKeyId: session.pendingPreKey.signedKeyId,
      baseKey: session.pendingPreKey.baseKey,
      identityKey: ourIdentityKey.pubKey,
      message: result,
    });
    return {
      type: 3,
      body: concat(Uint8Array.from([VERSION_BYTE]), pkm),
      registrationId: session.registrationId,
    };
  }
  return { type: 1, body: result, registrationId: session.registrationId };
}

export async function decryptWhisperMessage(
  deps: SignalDeps,
  addr: string,
  data: Uint8Array,
): Promise<Uint8Array> {
  const { storage } = deps;
  const record = await storage.loadSession(addr);
  if (!record) throw new Error("No session record");

  const errs: string[] = [];
  for (const session of record.getSessions()) {
    try {
      const plaintext = await doDecryptWhisperMessage(deps, data, session);
      session.indexInfo.used = Date.now();
      await storage.storeSession(addr, record);
      return plaintext;
    } catch (e) {
      errs.push((e as Error).message);
    }
  }
  throw new Error(`decrypt: nenhuma sessão serviu [${errs.join(" | ")}]`);
}

export async function decryptPreKeyWhisperMessage(
  deps: SignalDeps,
  addr: string,
  data: Uint8Array,
): Promise<Uint8Array> {
  const { storage } = deps;
  const [maxV, minV] = decodeVersionByte(data[0]!);
  if (minV > 3 || maxV < 3) throw new Error("pkmsg: versão incompatível");

  const preKeyProto = decodePreKeyWhisperMessage(data.subarray(1));

  // TOFU: registra a identidade do remetente (detecção de troca de identidade).
  if (preKeyProto.identityKey.length === 33) {
    await storage.saveIdentity(addr, preKeyProto.identityKey);
  }

  let record = await storage.loadSession(addr);
  if (!record) record = new SessionRecord();

  const preKeyId = await initIncoming(deps, record, preKeyProto);
  const session = record.getSession(preKeyProto.baseKey);
  if (!session) throw new Error("pkmsg: sessão não foi criada");

  const plaintext = await doDecryptWhisperMessage(deps, preKeyProto.message, session);
  await storage.storeSession(addr, record);
  if (preKeyId !== undefined) await storage.removePreKey(preKeyId);
  return plaintext;
}

async function doDecryptWhisperMessage(
  deps: SignalDeps,
  messageBuffer: Uint8Array,
  session: SessionEntry,
): Promise<Uint8Array> {
  const { c, storage } = deps;
  const [maxV, minV] = decodeVersionByte(messageBuffer[0]!);
  if (minV > 3 || maxV < 3) throw new Error("msg: versão incompatível");

  const messageProto = messageBuffer.subarray(1, messageBuffer.length - MAC_LENGTH);
  const mac = messageBuffer.subarray(messageBuffer.length - MAC_LENGTH);
  const message = decodeWhisperMessage(messageProto);

  maybeStepRatchet(deps, session, message.ephemeralKey, message.previousCounter);

  const chain = session.getChain(message.ephemeralKey);
  if (!chain || chain.chainType === CHAIN_SENDING) throw new Error("msg: chain de recepção ausente");

  fillMessageKeys(c, chain, message.counter);
  if (!hasOwn(chain.messageKeys, message.counter)) {
    throw new Error("Key used already or never filled");
  }
  const messageKey = chain.messageKeys[message.counter]!;
  delete chain.messageKeys[message.counter];

  const [cipherKey, macKey, ivFull] = deriveSecrets(
    c,
    messageKey,
    new Uint8Array(32),
    WHISPER_MESSAGE_KEYS,
  );
  const ourIdentityKey = storage.getOurIdentity();
  const macInput = concat(
    session.indexInfo.remoteIdentityKey,
    ourIdentityKey.pubKey,
    Uint8Array.from([VERSION_BYTE]),
    messageProto,
  );
  const calcMac = c.hmacSha256(macKey, macInput).subarray(0, MAC_LENGTH);
  if (!bytesEqual(calcMac, mac)) throw new Error("Bad MAC");

  const plaintext = c.aesCbcDecrypt(cipherKey, ivFull.subarray(0, 16), message.ciphertext);
  delete session.pendingPreKey;
  return plaintext;
}

function maybeStepRatchet(
  deps: SignalDeps,
  session: SessionEntry,
  remoteKey: Uint8Array,
  previousCounter: number,
): void {
  const { c, curve } = deps;
  if (session.getChain(remoteKey)) return;

  const ratchet = session.currentRatchet;
  const previousRatchet = session.getChain(ratchet.lastRemoteEphemeralKey);
  if (previousRatchet) {
    fillMessageKeys(c, previousRatchet, previousCounter);
    delete previousRatchet.chainKey.key; // fecha a chain antiga
  }

  calculateRatchet(deps, session, remoteKey, false);

  const prevSending = session.getChain(ratchet.ephemeralKeyPair.pubKey);
  if (prevSending) {
    ratchet.previousCounter = prevSending.chainKey.counter;
    session.deleteChain(ratchet.ephemeralKeyPair.pubKey);
  }
  ratchet.ephemeralKeyPair = curve.generateKeyPair();
  calculateRatchet(deps, session, remoteKey, true);
  ratchet.lastRemoteEphemeralKey = copy(remoteKey);
}

function calculateRatchet(
  deps: SignalDeps,
  session: SessionEntry,
  remoteKey: Uint8Array,
  sending: boolean,
): void {
  const { c, curve } = deps;
  const ratchet = session.currentRatchet;
  const sharedSecret = curve.calculateAgreement(remoteKey, ratchet.ephemeralKeyPair.privKey);
  const [newRoot, chainKey] = deriveSecrets(c, sharedSecret, ratchet.rootKey, WHISPER_RATCHET, 2);
  session.addChain(sending ? ratchet.ephemeralKeyPair.pubKey : remoteKey, {
    messageKeys: {},
    chainKey: { counter: -1, key: copy(chainKey) },
    chainType: sending ? CHAIN_SENDING : CHAIN_RECEIVING,
  });
  ratchet.rootKey = copy(newRoot);
}

function fillMessageKeys(c: SignalDeps["c"], chain: Chain, counter: number): void {
  if (chain.chainKey.counter >= counter) return;
  if (counter - chain.chainKey.counter > 2000) {
    throw new Error("Over 2000 messages into the future!");
  }
  while (chain.chainKey.counter < counter) {
    if (chain.chainKey.key === undefined) throw new Error("Chain closed");
    const key = chain.chainKey.key;
    chain.messageKeys[chain.chainKey.counter + 1] = c.hmacSha256(key, Uint8Array.from([1]));
    chain.chainKey.key = c.hmacSha256(key, Uint8Array.from([2]));
    chain.chainKey.counter += 1;
  }
}
