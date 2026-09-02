// Camada de PRIVACIDADE — lê e altera as configurações de privacidade da conta
// logada (confirmações de leitura, visto por último, foto, recado, quem pode
// te adicionar em grupo/chamada). Um par de `<iq xmlns="privacy">` sobre o
// mesmo `query()` request/response do `client.ts`. Espelha `fetchPrivacySettings`
// / `updateReadReceiptsPrivacy` & co. do `@whiskeysockets/baileys`.
//
//   ler:  <iq to="s.whatsapp.net" type="get" xmlns="privacy"><privacy/></iq>
//         → <privacy><category name="readreceipts" value="all"/> … </privacy>
//   set:  <iq to="s.whatsapp.net" type="set" xmlns="privacy">
//           <privacy><category name="readreceipts" value="none"/></privacy>
//         </iq>

import { getBinaryNodeChild, getBinaryNodeChildren, node, type BinaryNode } from "../frame/node";

const S_WHATSAPP_NET = "@s.whatsapp.net";

/** Categorias de privacidade que o WhatsApp expõe. */
export type PrivacyCategory =
  | "readreceipts"
  | "profile"
  | "status"
  | "online"
  | "last"
  | "groupadd"
  | "calladd";

/** Valores possíveis. Nem toda categoria aceita todos — `readreceipts` só
 *  `all`/`none`; `online` só `all`/`match_last_seen`; `calladd` só `all`/`known`;
 *  as demais aceitam `all`/`contacts`/`contact_blacklist`/`none`. O servidor
 *  recusa com `<iq type=error>` o que não fizer sentido. */
export type PrivacyValue =
  | "all"
  | "contacts"
  | "contact_blacklist"
  | "none"
  | "match_last_seen"
  | "known";

export type PrivacySettings = Partial<Record<PrivacyCategory, string>>;

export interface PrivacyLayerOptions {
  /** Faz um `<iq>` e resolve com o `<iq type=result>` correspondente. */
  query: (n: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>;
}

export interface PrivacyLayer {
  /** Lê todas as configurações de privacidade da conta. */
  fetchPrivacySettings(): Promise<PrivacySettings>;
  /** Altera UMA categoria. Devolve o conjunto já com o novo valor. */
  updatePrivacySetting(category: PrivacyCategory, value: PrivacyValue): Promise<PrivacySettings>;
}

function readCategories(iqResult: BinaryNode): PrivacySettings {
  // `<iq><privacy>` — e, em alguns builds, `<privacy><privacy>` aninhado.
  let container = getBinaryNodeChild(iqResult, "privacy");
  const inner = getBinaryNodeChild(container, "privacy");
  if (inner) container = inner;
  const out: PrivacySettings = {};
  for (const cat of getBinaryNodeChildren(container, "category")) {
    const name = cat.attrs.name;
    const value = cat.attrs.value;
    if (name && value) out[name as PrivacyCategory] = value;
  }
  return out;
}

export function createPrivacyLayer(o: PrivacyLayerOptions): PrivacyLayer {
  const { query } = o;

  async function fetchPrivacySettings(): Promise<PrivacySettings> {
    const res = await query(
      node("iq", { to: S_WHATSAPP_NET, type: "get", xmlns: "privacy" }, [node("privacy", {})]),
    );
    return readCategories(res);
  }

  async function updatePrivacySetting(
    category: PrivacyCategory,
    value: PrivacyValue,
  ): Promise<PrivacySettings> {
    const res = await query(
      node("iq", { to: S_WHATSAPP_NET, type: "set", xmlns: "privacy" }, [
        node("privacy", {}, [node("category", { name: category, value })]),
      ]),
    );
    const updated = readCategories(res);
    // o `<iq type=result>` do set às vezes vem vazio — reflete o pedido nesse caso.
    return Object.keys(updated).length > 0 ? updated : { [category]: value };
  }

  return { fetchPrivacySettings, updatePrivacySetting };
}
