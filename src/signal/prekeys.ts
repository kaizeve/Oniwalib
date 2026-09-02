// Pré-chaves — geração + o `<iq xmlns="encrypt">` de upload que o servidor
// espera logo após o `<success>` (e sempre que avisa que o estoque baixou).
//
// Espelha `generateOrGetPreKeys` / `getNextPreKeysNode` da Baileys
// (`Utils/signal.js`). O nó de pré-chave leva a pública de 32 bytes crus
// (sem o `0x05`); `<registration>` são 4 bytes BE, `<id>` 3 bytes BE.

import type { AuthCreds, AuthenticationState } from "../auth/state";
import type { Crypto } from "../crypto/types";
import { getBinaryNodeChild, getBinaryNodeChildren, node, type BinaryNode } from "../frame/node";
import type { PreKeyBundle } from "./session-builder";

const KEY_BUNDLE_TYPE = Uint8Array.from([5]);
const S_WHATSAPP_NET = "@s.whatsapp.net";

export interface PreKeyPair {
  public: Uint8Array;
  private: Uint8Array;
}

function beBytes(n: number, len: number): Uint8Array {
  const a = new Uint8Array(len);
  let r = n;
  for (let i = len - 1; i >= 0; i--) {
    a[i] = r & 0xff;
    r = Math.floor(r / 256);
  }
  return a;
}

function asBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v && typeof v === "object" && Array.isArray((v as any).data)) {
    return Uint8Array.from((v as any).data);
  }
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error("prekeys: valor não é bytes");
}

export function generateOrGetPreKeys(creds: AuthCreds, range: number, c: Crypto) {
  const available = creds.nextPreKeyId - creds.firstUnuploadedPreKeyId;
  const remaining = range - available;
  const lastPreKeyId = creds.nextPreKeyId + Math.max(remaining, 0) - 1;
  const newPreKeys: Record<number, PreKeyPair> = {};
  if (remaining > 0) {
    for (let i = creds.nextPreKeyId; i <= lastPreKeyId; i++) {
      const kp = c.generateX25519();
      newPreKeys[i] = { public: kp.publicKey, private: kp.privateKey };
    }
  }
  return {
    newPreKeys,
    lastPreKeyId,
    preKeysRange: [creds.firstUnuploadedPreKeyId, range] as [number, number],
  };
}

export interface PreKeyUpload {
  /** `<iq>` de upload (ainda SEM o atributo `id` — quem envia coloca). */
  node: BinaryNode;
  /** Patch a mesclar em `creds` e persistir. */
  update: Partial<AuthCreds>;
  /** Quantas pré-chaves foram para o `<list>`. */
  count: number;
}

export async function buildPreKeyUploadNode(
  auth: AuthenticationState,
  range: number,
  c: Crypto,
): Promise<PreKeyUpload> {
  const { creds, keys } = auth;
  const { newPreKeys, lastPreKeyId, preKeysRange } = generateOrGetPreKeys(creds, range, c);

  const update: Partial<AuthCreds> = {
    nextPreKeyId: Math.max(lastPreKeyId + 1, creds.nextPreKeyId),
    firstUnuploadedPreKeyId: Math.max(creds.firstUnuploadedPreKeyId, lastPreKeyId + 1),
  };

  if (Object.keys(newPreKeys).length) {
    await keys.set({ "pre-key": newPreKeys as Record<string, unknown> });
  }

  const ids: string[] = [];
  for (let id = preKeysRange[0]; id < preKeysRange[0] + preKeysRange[1]; id++) ids.push(String(id));
  const stored = await keys.get("pre-key", ids);

  const keyNodes: BinaryNode[] = [];
  for (const id of ids) {
    const kp = stored[id] as { public?: unknown; publicKey?: unknown } | undefined;
    if (!kp) continue;
    keyNodes.push(
      node("key", {}, [
        node("id", {}, beBytes(Number(id), 3)),
        node("value", {}, asBytes(kp.public ?? kp.publicKey)),
      ]),
    );
  }

  const sp = creds.signedPreKey;
  const iq = node("iq", { xmlns: "encrypt", type: "set", to: S_WHATSAPP_NET }, [
    node("registration", {}, beBytes(creds.registrationId, 4)),
    node("type", {}, KEY_BUNDLE_TYPE),
    node("identity", {}, creds.signedIdentityKey.publicKey),
    node("list", {}, keyNodes),
    node("skey", {}, [
      node("id", {}, beBytes(sp.keyId, 3)),
      node("value", {}, sp.keyPair.publicKey),
      node("signature", {}, sp.signature),
    ]),
  ]);

  return { node: iq, update, count: keyNodes.length };
}

// --- fetch (cold-send) -------------------------------------------------
// Buscar o bundle de pré-chaves de devices com quem nunca conversamos, para
// abrir a sessão pairwise sem esperar eles mandarem primeiro. Espelha o
// `<iq xmlns="encrypt">` de get + `parseAndInjectE2ESessions` da Baileys.
//
//   <iq to="s.whatsapp.net" type="get" xmlns="encrypt">
//     <key><user jid="55...:23@s.whatsapp.net"/> … </key>
//   </iq>
//   → <list><user jid=…>
//        <registration/> (4B BE)  <type/> (1B)  <identity/> (32B)
//        <skey><id/> (3B BE) <value/> (32B) <signature/> (64B)</skey>
//        <key><id/> (3B BE) <value/> (32B)</key>   (one-time, opcional)
//     </user></list>

const DJB = 5;

function beNum(v: Uint8Array): number {
  let n = 0;
  for (const b of v) n = n * 256 + b;
  return n;
}
function prefix(pub: Uint8Array): Uint8Array {
  if (pub.length === 33) return pub;
  const out = new Uint8Array(33);
  out[0] = DJB;
  out.set(pub, 1);
  return out;
}

/** `<iq xmlns="encrypt">` de get para os `jids` (já com device, ex. `55..:23@..`). */
export function buildPreKeyFetchNode(jids: string[]): BinaryNode {
  return node("iq", { xmlns: "encrypt", type: "get", to: S_WHATSAPP_NET }, [
    node(
      "key",
      {},
      jids.map((jid) => node("user", { jid })),
    ),
  ]);
}

/** Parseia o `<iq type=result>` de `buildPreKeyFetchNode` em bundles por jid.
 *  Um `<user>` com `<error>` (device fora do ar) sai de fora. */
export function parsePreKeyBundles(iqResult: BinaryNode): Record<string, PreKeyBundle> {
  const list = getBinaryNodeChild(iqResult, "list") ?? iqResult;
  const out: Record<string, PreKeyBundle> = {};
  for (const user of getBinaryNodeChildren(list, "user")) {
    const jid = user.attrs.jid;
    if (!jid || getBinaryNodeChild(user, "error")) continue;

    const reg = getBinaryNodeChild(user, "registration");
    const ident = getBinaryNodeChild(user, "identity");
    const skey = getBinaryNodeChild(user, "skey");
    if (!ident?.content || !skey) continue;

    const skId = getBinaryNodeChild(skey, "id");
    const skVal = getBinaryNodeChild(skey, "value");
    const skSig = getBinaryNodeChild(skey, "signature");
    if (!skId?.content || !skVal?.content || !skSig?.content) continue;

    const bundle: PreKeyBundle = {
      registrationId: reg?.content instanceof Uint8Array ? beNum(reg.content) : 0,
      identityKey: prefix(asBytes(ident.content)),
      signedPreKey: {
        keyId: beNum(asBytes(skId.content)),
        publicKey: prefix(asBytes(skVal.content)),
        signature: asBytes(skSig.content),
      },
    };

    const otk = getBinaryNodeChild(user, "key");
    const otkId = getBinaryNodeChild(otk, "id");
    const otkVal = getBinaryNodeChild(otk, "value");
    if (otkId?.content && otkVal?.content) {
      bundle.preKey = { keyId: beNum(asBytes(otkId.content)), publicKey: prefix(asBytes(otkVal.content)) };
    }

    out[jid] = bundle;
  }
  return out;
}
