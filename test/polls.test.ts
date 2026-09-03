// Enquetes (src/polls): criação + ciclo completo de decifrar um voto.
// O voto é montado aqui do jeito que o WhatsApp monta (mesma derivação), e a
// lib tem que decifrar e resolver os nomes.

import { nodeAdapter as c } from "../src/crypto/node-adapter";
import {
  buildPollCreation,
  decryptPollVote,
  resolvePollVote,
  pollOptionHash,
  tallyPoll,
} from "../src/polls";
import { encodeE2EMessage, decodeE2EMessage } from "../src/proto/e2e-message";
import { Writer } from "../src/proto/wire";
import { utf8Encode } from "../src/frame/buffer";

let pass = 0;
let fail = 0;
const fails: string[] = [];
const ok = (n: string, cond: boolean, d = "") => {
  if (cond) pass++;
  else {
    fail++;
    fails.push(n + (d ? ` — ${d}` : ""));
  }
};
const concat = (...ps: Uint8Array[]) => {
  const out = new Uint8Array(ps.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of ps) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const CREATOR = "5511999999999@s.whatsapp.net";
const VOTER = "5511888888888@s.whatsapp.net";
const POLL_ID = "POLLMSG1";
const OPTIONS = ["Pizza", "Sushi", "Churrasco"];

// --- criação ------------------------------------------------------
{
  const { message, pollEncKey } = buildPollCreation(c, "Almoço?", OPTIONS, 1);
  ok("pollEncKey tem 32 bytes", pollEncKey.length === 32);
  ok("messageSecret == pollEncKey", message.messageContextInfo?.messageSecret === pollEncKey);
  ok("pollCreationMessage.name", message.pollCreationMessage?.name === "Almoço?");
  ok("3 opções", message.pollCreationMessage?.options?.length === 3);
  ok("selectableOptionsCount", message.pollCreationMessage?.selectableOptionsCount === 1);

  const back = decodeE2EMessage(encodeE2EMessage(message));
  ok("round-trip: name", back.pollCreationMessage?.name === "Almoço?");
  ok("round-trip: opções", back.pollCreationMessage?.options?.map((o) => o.optionName).join(",") === "Pizza,Sushi,Churrasco");
  ok("round-trip: messageSecret", !!back.messageContextInfo?.messageSecret && back.messageContextInfo.messageSecret.length === 32);
}

// --- monta um voto como o WhatsApp faria, e decifra --------------
function encryptVote(pollEncKey: Uint8Array, picked: string[]): { encPayload: Uint8Array; encIv: Uint8Array } {
  const sign = concat(
    utf8Encode(POLL_ID),
    utf8Encode(CREATOR),
    utf8Encode(VOTER),
    utf8Encode("Poll Vote"),
    Uint8Array.from([1]),
  );
  const key0 = c.hmacSha256(new Uint8Array(32), pollEncKey);
  const decKey = c.hmacSha256(key0, sign);
  const aad = concat(utf8Encode(POLL_ID), Uint8Array.from([0]), utf8Encode(VOTER));

  // PollVoteMessage { repeated bytes selectedOptions = 1 }
  const w = new Writer();
  for (const name of picked) w.bytes(1, pollOptionHash(c, name));
  const plain = w.finish();

  const encIv = c.randomBytes(12);
  const encPayload = c.aesGcmEncrypt(decKey, encIv, plain, aad); // ct ‖ tag(16)
  return { encPayload, encIv };
}

{
  const { pollEncKey } = buildPollCreation(c, "Almoço?", OPTIONS, 2);
  const vote = encryptVote(pollEncKey, ["Sushi", "Churrasco"]);

  const { selectedOptions } = decryptPollVote(c, vote, {
    pollMsgId: POLL_ID,
    pollCreatorJid: CREATOR,
    voterJid: VOTER,
    pollEncKey,
  });
  ok("decifrou 2 opções", selectedOptions.length === 2);

  const names = resolvePollVote(c, OPTIONS, selectedOptions);
  ok("resolveu os nomes certos", names.sort().join(",") === "Churrasco,Sushi");

  // chave errada → GCM falha
  let threw = false;
  try {
    decryptPollVote(c, vote, {
      pollMsgId: POLL_ID,
      pollCreatorJid: CREATOR,
      voterJid: VOTER,
      pollEncKey: c.randomBytes(32),
    });
  } catch {
    threw = true;
  }
  ok("pollEncKey errada → lança (tag GCM)", threw);

  // voterJid errado → aad não bate → lança
  let threw2 = false;
  try {
    decryptPollVote(c, vote, {
      pollMsgId: POLL_ID,
      pollCreatorJid: CREATOR,
      voterJid: "5511777777777@s.whatsapp.net",
      pollEncKey,
    });
  } catch {
    threw2 = true;
  }
  ok("voterJid errado → lança", threw2);
}

// --- pollUpdateMessage round-trip -------------------------------
{
  const enc = encodeE2EMessage({
    pollUpdateMessage: {
      pollCreationMessageKey: { remoteJid: CREATOR, fromMe: true, id: POLL_ID },
      vote: { encPayload: new Uint8Array([1, 2, 3, 4]), encIv: new Uint8Array([9, 8, 7]) },
      senderTimestampMs: 1700000000000,
    },
  });
  const back = decodeE2EMessage(enc);
  ok("pollUpdate: key.id", back.pollUpdateMessage?.pollCreationMessageKey?.id === POLL_ID);
  ok("pollUpdate: encPayload", back.pollUpdateMessage?.vote?.encPayload?.length === 4);
  ok("pollUpdate: encIv", back.pollUpdateMessage?.vote?.encIv?.length === 3);
  ok("pollUpdate: senderTimestampMs", back.pollUpdateMessage?.senderTimestampMs === 1700000000000);
}

// --- tallyPoll -------------------------------------------------
{
  const t = tallyPoll(OPTIONS, [["Pizza"], ["Sushi"], ["Sushi"], ["Churrasco", "Sushi"]]);
  ok("tally Pizza=1", t.Pizza === 1);
  ok("tally Sushi=3", t.Sushi === 3);
  ok("tally Churrasco=1", t.Churrasco === 1);
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/polls [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
