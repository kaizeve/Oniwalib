// Camada USYNC — o `<iq xmlns="usync">` que o WhatsApp Web usa para descobrir
// coisas sobre uma lista de JIDs. Aqui só a consulta de **device list**: quais
// aparelhos (device ids) cada número tem logados. É o que falta para mandar a um
// número novo (cold-send) e para fanar o SKDM a TODOS os devices de um grupo, e
// não só aos que já têm sessão. Espelha `USyncQuery` + `USyncDeviceProtocol` do
// `@whiskeysockets/baileys`.
//
//   <iq to="s.whatsapp.net" type="get" xmlns="usync">
//     <usync sid=<rand> mode="query" last="true" index="0" context="message">
//       <query><devices version="2"/></query>
//       <list><user jid="55...@s.whatsapp.net"/> … </list>
//     </usync>
//   </iq>
//   → <usync><list><user jid=…><devices><device-list>
//                                 <device id="0"/><device id="23"/> …

import type { Crypto } from "../crypto/types";
import { getBinaryNodeChild, getBinaryNodeChildren, node, type BinaryNode } from "../frame/node";
import { jidDecode } from "../frame/jid";

const S_WHATSAPP_NET = "@s.whatsapp.net";

/** `jid` sem device nem agent — `55...@s.whatsapp.net` / `...@lid`. */
export function jidNormalizedUser(jid: string | undefined): string {
  const d = jidDecode(jid);
  if (!d || !d.user) return jid ?? "";
  const server = d.server === "c.us" ? "s.whatsapp.net" : d.server;
  return `${d.user}@${server}`;
}

export interface USyncLayerOptions {
  /** Faz um `<iq>` e resolve com o `<iq type=result>` correspondente. */
  query: (n: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>;
  crypto: Crypto;
}

export interface OnWhatsAppResult {
  /** O que você passou (número em qualquer formato). */
  input: string;
  /** `true` = está no WhatsApp. */
  exists: boolean;
  /** JID canônico quando `exists` (`55...@s.whatsapp.net`). */
  jid?: string;
}

export interface USyncLayer {
  /** Device ids de cada JID de usuário: `{ "55...@s.whatsapp.net": [0, 23] }`.
   *  Um JID que não está no WhatsApp (ou sem `<devices>` na resposta) sai com
   *  `[]`. As chaves são sempre a forma normalizada (sem device/agent). */
  getDeviceList(jids: string[]): Promise<Record<string, number[]>>;
  /** Diz quais dos `numbers` têm conta no WhatsApp (USYNC `contact`). Aceita
   *  número com ou sem `+`/`@s.whatsapp.net`. Um por entrada, na mesma ordem. */
  onWhatsApp(numbers: string[]): Promise<OnWhatsAppResult[]>;
}

function parseDeviceList(userNode: BinaryNode): number[] {
  const devices = getBinaryNodeChild(userNode, "devices");
  const list = getBinaryNodeChild(devices, "device-list");
  if (!list) return [];
  const out: number[] = [];
  for (const dev of getBinaryNodeChildren(list, "device")) {
    const raw = dev.attrs.id;
    if (raw === undefined) continue;
    const id = Number(raw);
    if (Number.isInteger(id) && id >= 0) out.push(id);
  }
  return out.sort((a, b) => a - b);
}

export function createUSyncLayer(o: USyncLayerOptions): USyncLayer {
  const { query, crypto: c } = o;

  const sid = () =>
    Array.from(c.randomBytes(8), (b) => b.toString(16).padStart(2, "0")).join("");

  async function getDeviceList(jids: string[]): Promise<Record<string, number[]>> {
    const users = Array.from(new Set(jids.map(jidNormalizedUser).filter(Boolean)));
    const result: Record<string, number[]> = {};
    for (const u of users) result[u] = [];
    if (users.length === 0) return result;

    const res = await query(
      node("iq", { to: S_WHATSAPP_NET, type: "get", xmlns: "usync" }, [
        node(
          "usync",
          { sid: sid(), mode: "query", last: "true", index: "0", context: "message" },
          [
            node("query", {}, [node("devices", { version: "2" })]),
            node("list", {}, users.map((jid) => node("user", { jid }))),
          ],
        ),
      ]),
    );

    const list = getBinaryNodeChild(getBinaryNodeChild(res, "usync"), "list");
    for (const userNode of getBinaryNodeChildren(list, "user")) {
      const jid = jidNormalizedUser(userNode.attrs.jid);
      if (!jid || !(jid in result)) continue;
      result[jid] = parseDeviceList(userNode);
    }
    return result;
  }

  async function onWhatsApp(numbers: string[]): Promise<OnWhatsAppResult[]> {
    const inputs = Array.from(new Set(numbers.map((n) => n.trim()).filter(Boolean)));
    if (inputs.length === 0) return [];
    // o `<contact>` quer o número com `+` na frente e sem sufixo de servidor
    const asContact = (n: string) => {
      const digits = n.replace(/@.*/, "").replace(/[^\d]/g, "");
      return digits ? `+${digits}` : n;
    };

    const res = await query(
      node("iq", { to: S_WHATSAPP_NET, type: "get", xmlns: "usync" }, [
        node(
          "usync",
          { sid: sid(), mode: "query", last: "true", index: "0", context: "interactive" },
          [
            node("query", {}, [node("contact", {})]),
            node("list", {}, inputs.map((n) => node("user", {}, [node("contact", {}, asContact(n))]))),
          ],
        ),
      ]),
    );

    const list = getBinaryNodeChild(getBinaryNodeChild(res, "usync"), "list");
    const byDigits = new Map<string, OnWhatsAppResult>();
    for (const userNode of getBinaryNodeChildren(list, "user")) {
      const contact = getBinaryNodeChild(userNode, "contact");
      const type = contact?.attrs.type; // "in" = tem conta, "out" = não
      const jid = userNode.attrs.jid ? jidNormalizedUser(userNode.attrs.jid) : undefined;
      const exists = type === "in" || (!!jid && type !== "out");
      const key = (jid ?? "").replace(/[^\d]/g, "");
      if (key) byDigits.set(key, { input: "", exists, jid: exists ? jid : undefined });
    }
    return inputs.map((input) => {
      const digits = input.replace(/@.*/, "").replace(/[^\d]/g, "");
      const hit = byDigits.get(digits);
      return hit ? { ...hit, input } : { input, exists: false };
    });
  }

  return { getDeviceList, onWhatsApp };
}
