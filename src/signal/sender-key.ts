// SenderKey — a cifra de GRUPO do Signal (o "skmsg" do WhatsApp).
//
// Um grupo não usa Double Ratchet: cada participante tem UMA cadeia simétrica
// (`SenderChainKey`) e uma chave de assinatura. Ele distribui o estado inicial
// (chainKey + signingKey pública) para os outros via um
// `SenderKeyDistributionMessage` (SKDM) mandado 1:1 (cifrado no pairwise), e a
// partir daí publica `SenderKeyMessage` no grupo, assinadas, que todo mundo
// decifra com o estado que recebeu.
//
//   processSenderKeyDistribution(rec, skdmBytes)  guarda o estado de um par
//   groupDecrypt(deps, rec, skmsgBytes)           decifra um <enc type=skmsg>
//   createSenderKeyDistribution(deps, rec)        cria/pega o NOSSO estado + SKDM
//   groupEncrypt(deps, rec, plaintext)            cifra (precisa do NOSSO estado)
//
// Estudado de `libsignal/src/groups/` (WhiskeySockets v6) — não importado; toda
// a cripto passa por `Crypto`, então roda no RTS. Serialização é nossa (JSON com
// bytes em base64), gravada pelo `SignalKeyStore` no tipo `sender-key`.

import type { Crypto } from "../crypto/types";
import { b64, b64decode } from "../auth/state";
import { Reader, Writer } from "../proto/wire";
import { makeCurve, prefixKey, stripKey, type SignalKeyPair } from "./curve";
import { deriveSecrets } from "./kdf";

// (3 << 4) | 3 — o mesmo byte de versão do 1:1.
const SENDER_KEY_VERSION = 0x33;
const MESSAGE_KEY_SEED = Uint8Array.from([0x01]);
const CHAIN_KEY_SEED = Uint8Array.from([0x02]);
const WHISPER_GROUP = Uint8Array.from("WhisperGroup", (ch) => ch.charCodeAt(0) & 0xff);
const MAX_STATES = 5;
const MAX_MESSAGE_KEYS = 2000;
const MAX_FORWARD_JUMP = 2000;

// --- protobufs -----------------------------------------------------------

interface SenderKeyMessageParts {
  id: number;
  iteration: number;
  ciphertext: Uint8Array;
  /** `version || protobuf`, sem a assinatura — o que é assinado/verificado. */
  signed: Uint8Array;
  signature: Uint8Array;
}

function parseSenderKeyMessage(bytes: Uint8Array): SenderKeyMessageParts {
  if (bytes.length < 1 + 64) throw new Error("skmsg: curto demais");
  const version = bytes[0]! >> 4;
  if (version < 3) throw new Error(`skmsg: versão ${version} não suportada`);
  const signed = bytes.subarray(0, bytes.length - 64);
  const signature = bytes.subarray(bytes.length - 64);
  const f = new Reader(bytes.subarray(1, bytes.length - 64)).fields();
  const id = numField(f, 1);
  const iteration = numField(f, 2);
  const ciphertext = bytesField(f, 3);
  if (!ciphertext) throw new Error("skmsg: sem ciphertext");
  return { id, iteration, ciphertext, signed, signature };
}

function buildSenderKeyMessage(
  c: Crypto,
  id: number,
  iteration: number,
  ciphertext: Uint8Array,
  signingPriv: Uint8Array,
): Uint8Array {
  const proto = new Writer().uintF(1, id).uintF(2, iteration).bytes(3, ciphertext).finish();
  const signed = concat(Uint8Array.from([SENDER_KEY_VERSION]), proto);
  const signature = makeCurve(c).calculateSignature(signingPriv, signed);
  return concat(signed, signature);
}

interface SKDMParts {
  id: number;
  iteration: number;
  chainKey: Uint8Array;
  signingKey: Uint8Array; // 33 bytes DJB
}

function parseSKDM(bytes: Uint8Array): SKDMParts {
  const body = bytes[0]! >> 4 >= 3 ? bytes.subarray(1) : bytes;
  const f = new Reader(body).fields();
  const chainKey = bytesField(f, 3);
  const signingKey = bytesField(f, 4);
  if (!chainKey || !signingKey) throw new Error("SKDM: falta chainKey/signingKey");
  return { id: numField(f, 1), iteration: numField(f, 2), chainKey, signingKey: prefixKey(signingKey) };
}

export function buildSKDM(p: SKDMParts): Uint8Array {
  const proto = new Writer()
    .uintF(1, p.id)
    .uintF(2, p.iteration)
    .bytes(3, p.chainKey)
    .bytes(4, prefixKey(p.signingKey))
    .finish();
  return concat(Uint8Array.from([SENDER_KEY_VERSION]), proto);
}

// --- estado ------------------------------------------------------------

interface MessageKey {
  iteration: number;
  seed: Uint8Array;
}

interface SenderKeyState {
  keyId: number;
  chain: { iteration: number; seed: Uint8Array };
  signPub: Uint8Array; // 33
  signPriv?: Uint8Array; // 32 — só no nosso estado
  messageKeys: MessageKey[];
}

/** Um `SenderKeyRecord`: os estados de um (grupo, participante). Mais novo primeiro. */
export class SenderKeyRecord {
  private states: SenderKeyState[] = [];

  static deserialize(raw: unknown): SenderKeyRecord {
    const rec = new SenderKeyRecord();
    const arr = (raw as { states?: unknown[] })?.states ?? [];
    for (const s of arr as any[]) {
      rec.states.push({
        keyId: s.keyId,
        chain: { iteration: s.chain.iteration, seed: b64decode(s.chain.seed) },
        signPub: b64decode(s.signPub),
        signPriv: s.signPriv ? b64decode(s.signPriv) : undefined,
        messageKeys: (s.messageKeys ?? []).map((m: any) => ({
          iteration: m.iteration,
          seed: b64decode(m.seed),
        })),
      });
    }
    return rec;
  }

  serialize(): Record<string, unknown> {
    return {
      states: this.states.map((s) => ({
        keyId: s.keyId,
        chain: { iteration: s.chain.iteration, seed: b64(s.chain.seed) },
        signPub: b64(s.signPub),
        signPriv: s.signPriv ? b64(s.signPriv) : undefined,
        messageKeys: s.messageKeys.map((m) => ({ iteration: m.iteration, seed: b64(m.seed) })),
      })),
    };
  }

  isEmpty(): boolean {
    return this.states.length === 0;
  }

  /** Sem id → o mais recente (nosso, no envio). Com id → o que casa. */
  getState(keyId?: number): SenderKeyState | undefined {
    if (keyId === undefined) return this.states[0];
    return this.states.find((s) => s.keyId === keyId);
  }

  /** Estado recebido de um par (sem chave privada de assinatura). */
  addState(keyId: number, iteration: number, chainSeed: Uint8Array, signPub: Uint8Array): void {
    if (this.states.some((s) => s.keyId === keyId)) {
      this.states = this.states.filter((s) => s.keyId !== keyId);
    }
    this.states.unshift({
      keyId,
      chain: { iteration, seed: chainSeed },
      signPub: prefixKey(signPub),
      messageKeys: [],
    });
    this.states = this.states.slice(0, MAX_STATES);
  }

  /** Nosso estado (com par de chaves de assinatura). */
  setOwnState(keyId: number, iteration: number, chainSeed: Uint8Array, signing: SignalKeyPair): void {
    this.states = [
      {
        keyId,
        chain: { iteration, seed: chainSeed },
        signPub: prefixKey(signing.pubKey),
        signPriv: signing.privKey,
        messageKeys: [],
      },
    ];
  }
}

// --- KDF da cadeia ---------------------------------------------------------

function chainStep(c: Crypto, seed: Uint8Array, salt: Uint8Array): Uint8Array {
  return c.hmacSha256(seed, salt);
}

/** iv (16) + cipherKey (32) a partir do seed da message key. */
function messageKeyMaterial(c: Crypto, seed: Uint8Array): { iv: Uint8Array; cipherKey: Uint8Array } {
  const [a, b] = deriveSecrets(c, seed, new Uint8Array(32), WHISPER_GROUP, 2);
  const bytes = concat(a!, b!); // 64; usamos os primeiros 48
  return { iv: bytes.subarray(0, 16), cipherKey: bytes.subarray(16, 48) };
}

/** Anda a cadeia até `iteration`, guardando as message keys puladas. */
function messageKeyFor(c: Crypto, state: SenderKeyState, iteration: number): Uint8Array {
  const chain = state.chain;
  if (chain.iteration > iteration) {
    const idx = state.messageKeys.findIndex((m) => m.iteration === iteration);
    if (idx >= 0) {
      const [mk] = state.messageKeys.splice(idx, 1);
      return mk!.seed;
    }
    throw new Error(`skmsg: iteração ${iteration} velha demais (cadeia em ${chain.iteration})`);
  }
  if (iteration - chain.iteration > MAX_FORWARD_JUMP) {
    throw new Error(`skmsg: ${iteration - chain.iteration} mensagens no futuro`);
  }
  while (chain.iteration < iteration) {
    state.messageKeys.push({
      iteration: chain.iteration,
      seed: chainStep(c, chain.seed, MESSAGE_KEY_SEED),
    });
    chain.seed = chainStep(c, chain.seed, CHAIN_KEY_SEED);
    chain.iteration += 1;
  }
  if (state.messageKeys.length > MAX_MESSAGE_KEYS) {
    state.messageKeys.splice(0, state.messageKeys.length - MAX_MESSAGE_KEYS);
  }
  const seed = chainStep(c, chain.seed, MESSAGE_KEY_SEED);
  chain.seed = chainStep(c, chain.seed, CHAIN_KEY_SEED);
  chain.iteration += 1;
  return seed;
}

// --- API --------------------------------------------------------------

/** Guarda o estado que um participante distribuiu (SKDM de dentro do <enc> 1:1). */
export function processSenderKeyDistribution(rec: SenderKeyRecord, skdmBytes: Uint8Array): void {
  const p = parseSKDM(skdmBytes);
  rec.addState(p.id, p.iteration, p.chainKey, stripKey(p.signingKey));
}

/** Decifra um `<enc type="skmsg">`. Muta `rec` (avança a cadeia). */
export function groupDecrypt(c: Crypto, rec: SenderKeyRecord, skmsgBytes: Uint8Array): Uint8Array {
  const msg = parseSenderKeyMessage(skmsgBytes);
  const state = rec.getState(msg.id);
  if (!state) {
    throw new Error(`skmsg: sem estado para keyId ${msg.id} (SKDM ainda não chegou?)`);
  }
  if (!makeCurve(c).verifySignature(state.signPub, msg.signed, msg.signature)) {
    throw new Error("skmsg: assinatura inválida");
  }
  const seed = messageKeyFor(c, state, msg.iteration);
  const { iv, cipherKey } = messageKeyMaterial(c, seed);
  return c.aesCbcDecrypt(cipherKey, iv, msg.ciphertext);
}

/** Cria (uma vez) o NOSSO estado para o grupo e devolve o SKDM para distribuir. */
export function createSenderKeyDistribution(c: Crypto, rec: SenderKeyRecord): Uint8Array {
  if (rec.isEmpty() || !rec.getState()?.signPriv) {
    const keyId = bytesToInt(c.randomBytes(4)) % 0x7fffffff;
    const chainSeed = c.randomBytes(32);
    const signing = makeCurve(c).generateKeyPair();
    rec.setOwnState(keyId, 0, chainSeed, signing);
  }
  const s = rec.getState()!;
  return buildSKDM({ id: s.keyId, iteration: s.chain.iteration, chainKey: s.chain.seed, signingKey: s.signPub });
}

/** Cifra para o grupo. Precisa do NOSSO estado (chame `createSenderKeyDistribution` antes). */
export function groupEncrypt(c: Crypto, rec: SenderKeyRecord, plaintext: Uint8Array): Uint8Array {
  const s = rec.getState();
  if (!s || !s.signPriv) throw new Error("skmsg: sem estado próprio — distribua o SKDM primeiro");
  const iteration = s.chain.iteration;
  const seed = chainStep(c, s.chain.seed, MESSAGE_KEY_SEED);
  s.chain.seed = chainStep(c, s.chain.seed, CHAIN_KEY_SEED);
  s.chain.iteration += 1;
  const { iv, cipherKey } = messageKeyMaterial(c, seed);
  const ciphertext = c.aesCbcEncrypt(cipherKey, iv, plaintext);
  return buildSenderKeyMessage(c, s.keyId, iteration, ciphertext, s.signPriv);
}

// --- helpers ---------------------------------------------------------------

type Fields = Map<number, Array<number | Uint8Array>>;
function bytesField(f: Fields, n: number): Uint8Array | undefined {
  const v = f.get(n)?.[0];
  return v instanceof Uint8Array ? v : undefined;
}
function numField(f: Fields, n: number): number {
  const v = f.get(n)?.[0];
  return typeof v === "number" ? v : 0;
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
function bytesToInt(b: Uint8Array): number {
  return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
}
