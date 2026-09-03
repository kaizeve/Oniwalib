// Enquetes (polls). Porte fiel do `@whiskeysockets/baileys`:
//   - criação: `pollCreationMessage` + `messageContextInfo.messageSecret` (a
//     `encKey` da enquete, 32 bytes aleatórios).
//   - voto: chega um `pollUpdateMessage` com o voto CIFRADO. Decifra com
//     `decryptPollVote` (`Utils/process-message.js`):
//       sign   = utf8(pollMsgId + pollCreatorJid + voterJid + "Poll Vote") + [1]
//       key0   = HMAC-SHA256(key = 32x0x00, msg = pollEncKey)
//       decKey = HMAC-SHA256(key = key0,    msg = sign)
//       aad    = utf8(pollMsgId) + 0x00 + utf8(voterJid)
//       plain  = AES-256-GCM(encPayload, decKey, encIv, aad)  -> PollVoteMessage
//     `PollVoteMessage.selectedOptions` = SHA-256 de cada nome de opção votada.

import type { Crypto } from "../crypto/types";
import { utf8Encode } from "../frame/buffer";
import { Reader } from "../proto/wire";
import type { E2EMessage, E2EMessageKey } from "../proto/e2e-message";

export interface PollCreate {
  message: E2EMessage;
  /** Os 32 bytes que decifram os votos. Guarde junto da mensagem enviada. */
  pollEncKey: Uint8Array;
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
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Monta um `pollCreationMessage`. `selectableCount` 0/1 = escolha única;
 *  >1 = múltipla (até N). */
export function buildPollCreation(
  c: Crypto,
  name: string,
  options: string[],
  selectableCount = 1,
): PollCreate {
  const pollEncKey = c.randomBytes(32);
  return {
    pollEncKey,
    message: {
      pollCreationMessage: {
        name,
        options: options.map((optionName) => ({ optionName })),
        selectableOptionsCount: selectableCount,
      },
      messageContextInfo: { messageSecret: pollEncKey },
    },
  };
}

/** SHA-256 do nome da opção — é assim que o voto identifica a opção. */
export function pollOptionHash(c: Crypto, optionName: string): Uint8Array {
  return c.sha256(utf8Encode(optionName));
}

export interface PollVoteContext {
  /** id da mensagem de criação da enquete. */
  pollMsgId: string;
  /** jid de quem CRIOU a enquete (número; `me` se foi você). */
  pollCreatorJid: string;
  /** jid de quem VOTOU. */
  voterJid: string;
  /** os 32 bytes de `messageContextInfo.messageSecret` da criação. */
  pollEncKey: Uint8Array;
}

/** Decifra um voto. Devolve os hashes SHA-256 das opções escolhidas. */
export function decryptPollVote(
  c: Crypto,
  vote: { encPayload: Uint8Array; encIv: Uint8Array },
  ctx: PollVoteContext,
): { selectedOptions: Uint8Array[] } {
  const sign = concat(
    utf8Encode(ctx.pollMsgId),
    utf8Encode(ctx.pollCreatorJid),
    utf8Encode(ctx.voterJid),
    utf8Encode("Poll Vote"),
    Uint8Array.from([1]),
  );
  const key0 = c.hmacSha256(new Uint8Array(32), ctx.pollEncKey);
  const decKey = c.hmacSha256(key0, sign);
  // aad = utf8(pollMsgId) + 0x00 + utf8(voterJid)
  const aad = concat(
    utf8Encode(ctx.pollMsgId),
    Uint8Array.from([0]),
    utf8Encode(ctx.voterJid),
  );
  const plain = c.aesGcmDecrypt(decKey, vote.encIv, vote.encPayload, aad);

  // PollVoteMessage { repeated bytes selectedOptions = 1 }
  const selectedOptions: Uint8Array[] = [];
  for (const v of new Reader(plain).fields().get(1) ?? []) {
    if (v instanceof Uint8Array) selectedOptions.push(v);
  }
  return { selectedOptions };
}

/** Traduz os hashes de um voto de volta para os nomes de opção da enquete. */
export function resolvePollVote(
  c: Crypto,
  optionNames: string[],
  selectedOptionHashes: Uint8Array[],
): string[] {
  const table = optionNames.map((name) => ({ name, hash: pollOptionHash(c, name) }));
  const out: string[] = [];
  for (const h of selectedOptionHashes) {
    const hit = table.find((t) => bytesEqual(t.hash, h));
    if (hit) out.push(hit.name);
  }
  return out;
}

/** Placar `{ opção: quantidade }` a partir dos nomes escolhidos por eleitor
 *  (resolva "último voto de cada eleitor" antes de passar aqui). */
export function tallyPoll(
  optionNames: string[],
  votes: string[][],
): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const name of optionNames) tally[name] = 0;
  for (const picked of votes) {
    for (const name of picked) {
      if (name in tally) tally[name] += 1;
    }
  }
  return tally;
}

export type { E2EMessageKey };
