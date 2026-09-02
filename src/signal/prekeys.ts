// Pré-chaves — geração + o `<iq xmlns="encrypt">` de upload que o servidor
// espera logo após o `<success>` (e sempre que avisa que o estoque baixou).
//
// Espelha `generateOrGetPreKeys` / `getNextPreKeysNode` da Baileys
// (`Utils/signal.js`). O nó de pré-chave leva a pública de 32 bytes crus
// (sem o `0x05`); `<registration>` são 4 bytes BE, `<id>` 3 bytes BE.

import type { AuthCreds, AuthenticationState } from "../auth/state";
import type { Crypto } from "../crypto/types";
import { node, type BinaryNode } from "../frame/node";

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
