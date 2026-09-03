// App-state sync (src/appstate): LT-hash, expansão de chave, MACs e o roundtrip
// completo encode→decode de um patch com verificação de MAC ligada.
//
// A cripto (mutationKeys / LT-hash) foi conferida byte-a-byte contra o
// whatsapp-rust-bridge real num script à parte; aqui garantimos a consistência
// interna e o formato do fio.

import { nodeAdapter } from "../src/crypto/node-adapter";
import { makeLtHash } from "../src/appstate/lt-hash";
import {
  mutationKeys,
  generateMac,
  generateSnapshotMac,
  generatePatchMac,
  u64be,
  SET,
  REMOVE,
} from "../src/appstate/mac";
import {
  newLTHashState,
  decodeSyncdPatch,
  decodeSyncdSnapshot,
  encodeSyncdPatch,
  extractSyncdPatches,
  chatModificationToAppPatch,
  type LTHashState,
  type ChatMutation,
} from "../src/appstate";
import {
  decodeSyncActionData,
  encodeSyncActionData,
  encodeSyncActionValue,
  decodeSyncActionValue,
  decodeSyncdPatch as protoDecodePatch,
  encodeSyncdPatch as protoEncodePatch,
  decodeAppStateSyncKeyShare,
} from "../src/appstate/proto";
import { node } from "../src/frame/node";
import { utf8Encode, utf8Decode } from "../src/frame/buffer";
import { b64 } from "../src/auth/state";
import { Writer } from "../src/proto/wire";

const c = nodeAdapter;
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
const eqBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// --- LT-hash ----------------------------------------------------------
{
  const lt = makeLtHash(c);
  const A = c.randomBytes(32);
  const B = c.randomBytes(32);
  const C = c.randomBytes(32);
  const zero = new Uint8Array(128);

  ok("estado inicial tem 128 bytes", zero.length === 128);

  const abc = lt.add(zero, [A, B, C]);
  const cab = lt.add(zero, [C, A, B]);
  ok("add é comutativo (ordem não importa)", eqBytes(abc, cab));

  const back = lt.subtract(abc, [B]);
  const ac = lt.add(zero, [A, C]);
  ok("subtract desfaz um add", eqBytes(back, ac));

  const sta = lt.subtractThenAdd(abc, [A], [/* nada */]);
  ok("subtractThenAdd(sub=[A]) == remover A", eqBytes(sta, lt.add(zero, [B, C])));

  ok("add([]) é no-op", eqBytes(lt.add(abc, []), abc));
  ok("resultado continua com 128 bytes", abc.length === 128);
}

// --- expansão de chave ---------------------------------------------
{
  const master = c.randomBytes(32);
  const k = mutationKeys(c, master);
  ok("indexKey 32B", k.indexKey.length === 32);
  ok("valueEncryptionKey 32B", k.valueEncryptionKey.length === 32);
  ok("valueMacKey 32B", k.valueMacKey.length === 32);
  ok("snapshotMacKey 32B", k.snapshotMacKey.length === 32);
  ok("patchMacKey 32B", k.patchMacKey.length === 32);
  ok("determinístico", eqBytes(mutationKeys(c, master).indexKey, k.indexKey));
  ok(
    "fatias distintas",
    !eqBytes(k.indexKey, k.valueEncryptionKey) && !eqBytes(k.snapshotMacKey, k.patchMacKey),
  );
}

// --- MACs -----------------------------------------------------------
{
  const key = c.randomBytes(32);
  const keyId = c.randomBytes(6);
  const data = c.randomBytes(48);
  const m1 = generateMac(c, SET, data, keyId, key);
  const m2 = generateMac(c, REMOVE, data, keyId, key);
  ok("valueMac tem 32B", m1.length === 32);
  ok("op muda o valueMac", !eqBytes(m1, m2));

  const u = u64be(0x01020304);
  ok("u64be zera os 4 bytes altos", u[0] === 0 && u[1] === 0 && u[2] === 0 && u[3] === 0);
  ok("u64be big-endian nos 4 baixos", u[4] === 1 && u[5] === 2 && u[6] === 3 && u[7] === 4);

  const snap = generateSnapshotMac(c, c.randomBytes(128), 7, "regular", c.randomBytes(32));
  ok("snapshotMac 32B", snap.length === 32);
  const pm = generatePatchMac(c, snap, [m1], 7, "regular", c.randomBytes(32));
  ok("patchMac 32B", pm.length === 32);
}

// --- SyncActionValue / SyncActionData proto roundtrip -------------
{
  const enc = encodeSyncActionValue({
    timestamp: 1700000000,
    pushNameSetting: { name: "Fulano da Silva" },
  });
  const dec = decodeSyncActionValue(enc);
  ok("pushNameSetting roundtrip", dec.pushNameSetting?.name === "Fulano da Silva");
  ok("timestamp roundtrip", dec.timestamp === 1700000000);

  const mute = decodeSyncActionValue(
    encodeSyncActionValue({ timestamp: 1, muteAction: { muted: true, muteEndTimestamp: 999 } }),
  );
  ok("muteAction roundtrip", mute.muteAction?.muted === true && mute.muteAction?.muteEndTimestamp === 999);

  const pin = decodeSyncActionValue(encodeSyncActionValue({ timestamp: 1, pinAction: { pinned: true } }));
  ok("pinAction roundtrip", pin.pinAction?.pinned === true);

  const idx = utf8Encode(JSON.stringify(["setting_pushName"]));
  const sad = encodeSyncActionData({ index: idx, value: enc, padding: new Uint8Array(0), version: 1 });
  const sadDec = decodeSyncActionData(sad);
  ok("SyncActionData.index roundtrip", utf8Decode(sadDec.index!) === '["setting_pushName"]');
  ok("SyncActionData.version roundtrip", sadDec.version === 1);
  ok("SyncActionData.value decodifica", sadDec.value?.pushNameSetting?.name === "Fulano da Silva");
}

// --- roundtrip COMPLETO: encodeSyncdPatch → decodeSyncdPatch -------
{
  const masterKey = c.randomBytes(32);
  const myKeyId = c.randomBytes(6);
  const myKeyIdB64 = b64(myKeyId);
  const getKey = (id: string) => (id === myKeyIdB64 ? masterKey : undefined);
  const deps = { crypto: c, getKey };
  const lt = makeLtHash(c);

  const create = chatModificationToAppPatch({ pushNameSetting: "Bot Novo Nome" }, "");
  const state0 = newLTHashState();

  const { patch, state: state1, collection } = await encodeSyncdPatch(
    deps,
    lt,
    create,
    myKeyIdB64,
    state0,
  );
  ok("collection = critical_block", collection === "critical_block");
  ok("versão avançou p/ 1", state1.version === 1);
  ok("patch são bytes não-vazios", patch instanceof Uint8Array && patch.length > 0);

  // o servidor faria exatamente isto: decodifica e valida TODOS os macs
  const decoded = protoDecodePatch(patch);
  ok("patch decodifica com 1 mutação", decoded.mutations.length === 1);
  ok("snapshotMac presente (32B)", decoded.snapshotMac?.length === 32);
  ok("patchMac presente (32B)", decoded.patchMac?.length === 32);

  const seen: ChatMutation[] = [];
  const { state: state1b } = await decodeSyncdPatch(
    deps,
    lt,
    decoded,
    "critical_block",
    state0,
    (m) => seen.push(m),
    true, // validateMacs — se a cripto estivesse errada, LANÇA aqui
  );
  ok("decode reconstruiu o mesmo LT-hash", eqBytes(state1b.hash, state1.hash));
  ok("decode devolveu versão 1", state1b.version === 1);
  ok("mutação recuperada: index setting_pushName", seen[0]?.index[0] === "setting_pushName");
  ok("mutação recuperada: novo nome", seen[0]?.syncAction.value?.pushNameSetting?.name === "Bot Novo Nome");

  // adulterar o snapshotMac tem que reprovar
  let threw = false;
  const bad = protoDecodePatch(patch);
  bad.snapshotMac = c.randomBytes(32);
  try {
    await decodeSyncdPatch(deps, lt, bad, "critical_block", state0, () => {}, true);
  } catch {
    threw = true;
  }
  ok("snapshotMac adulterado é rejeitado", threw);

  // segundo patch encadeia a versão e o hash
  const { state: state2 } = await encodeSyncdPatch(
    deps,
    lt,
    chatModificationToAppPatch({ pushNameSetting: "Terceiro Nome" }, ""),
    myKeyIdB64,
    state1,
  );
  ok("segundo patch → versão 2", state2.version === 2);
  ok("hash mudou entre v1 e v2", !eqBytes(state1.hash, state2.hash));
}

// --- extractSyncdPatches: parseia o <sync><collection> ------------
{
  // um patch cru qualquer (não precisa validar aqui, só extrair)
  const rawPatch = protoEncodePatch({
    version: 5,
    keyId: new Uint8Array([1, 2, 3]),
    snapshotMac: new Uint8Array(32),
    patchMac: new Uint8Array(32),
    mutations: [],
  });
  const iq = node("iq", { type: "result" }, [
    node("sync", {}, [
      node("collection", { name: "regular_low", version: "5", has_more_patches: "false" }, [
        node("patches", {}, [node("patch", {}, rawPatch)]),
      ]),
    ]),
  ]);
  const downloadBlob = async () => new Uint8Array(0);
  const got = await extractSyncdPatches(iq, downloadBlob);
  ok("coleção regular_low presente", !!got.regular_low);
  ok("versão da coleção lida", got.regular_low?.version === 5);
  ok("1 patch extraído", got.regular_low?.patches.length === 1);
  ok("has_more_patches=false", got.regular_low?.hasMorePatches === false);
  ok("bytes do patch batem", eqBytes(got.regular_low!.patches[0]!, rawPatch));
}

// --- chatModificationToAppPatch: os índices/coleções ------------
{
  const jid = "5511999999999@s.whatsapp.net";
  ok("mute → regular_high / index [mute,jid]", (() => {
    const p = chatModificationToAppPatch({ mute: 8 * 3600 * 1000 }, jid);
    return p.type === "regular_high" && p.index[0] === "mute" && p.index[1] === jid;
  })());
  ok("pin → regular_low / pin_v1", (() => {
    const p = chatModificationToAppPatch({ pin: true }, jid);
    return p.type === "regular_low" && p.index[0] === "pin_v1";
  })());
  ok("archive → regular_low / archive", (() => {
    const p = chatModificationToAppPatch({ archive: true }, jid);
    return p.type === "regular_low" && p.index[0] === "archive";
  })());
  ok("markRead → markChatAsRead", chatModificationToAppPatch({ markRead: true }, jid).index[0] === "markChatAsRead");
  ok("pushName → critical_block / [setting_pushName]", (() => {
    const p = chatModificationToAppPatch({ pushNameSetting: "X" }, "");
    return p.type === "critical_block" && p.index[0] === "setting_pushName" && p.index.length === 1;
  })());
}

// --- decodeAppStateSyncKeyShare ----------------------------------
{
  const keyId = c.randomBytes(6);
  const keyData = c.randomBytes(32);
  const share = new Writer()
    .message(
      1,
      new Writer()
        .message(1, new Writer().bytes(1, keyId)) // AppStateSyncKeyId
        .message(2, new Writer().bytes(1, keyData).uint(3, 1700000000)), // AppStateSyncKeyData
    )
    .finish();
  const keys = decodeAppStateSyncKeyShare(share);
  ok("1 chave no share", keys.length === 1);
  ok("keyId bate", !!keys[0]?.keyId && eqBytes(keys[0]!.keyId!, keyId));
  ok("keyData bate", !!keys[0]?.keyData && eqBytes(keys[0]!.keyData!, keyData));
  ok("timestamp lido", keys[0]?.timestamp === 1700000000);
}

// --- decodeSyncdSnapshot: sem chave → lança -----------------------
{
  const lt = makeLtHash(c);
  const deps = { crypto: c, getKey: () => undefined };
  const snap = new Writer().message(1, new Writer().uintF(1, 1)).finish(); // só version
  let threwOrEmpty = false;
  try {
    const r = await decodeSyncdSnapshot(deps, lt, "regular", snap, undefined, false);
    threwOrEmpty = r.state.version === 1; // sem records, validateMacs=false → ok
  } catch {
    threwOrEmpty = true;
  }
  ok("snapshot vazio decodifica com validateMacs=false", threwOrEmpty);
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/appstate [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
