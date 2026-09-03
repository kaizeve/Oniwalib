// Contas comerciais (Business) — LEITURA. Porte fiel do
// `@whiskeysockets/baileys` (`Socket/business.ts` + `Utils/business.ts`):
//
//   getBusinessProfile(jid)          <iq get xmlns="w:biz"><business_profile v><profile jid>
//   getCatalog({ jid, limit, cursor}) <iq get xmlns="w:biz:catalog"><product_catalog jid>
//   getCollections(jid, limit)        <iq get xmlns="w:biz:catalog"><collections biz_jid>
//   getOrderDetails(orderId, token)   <iq get xmlns="fb:thrift_iq"><order id token op="get">
//
// O lado de ESCRITA (criar/editar/apagar produto) precisa do upload de mídia
// direto (`biz-cover-photo` / catálogo) e fica de fora por ora.

import {
  getBinaryNodeChild,
  getBinaryNodeChildren,
  node,
  type BinaryNode,
} from "../frame/node";
import { utf8Decode, utf8Encode } from "../frame/buffer";

const S_WHATSAPP_NET = "@s.whatsapp.net";

function childStr(parent: BinaryNode | undefined, tag: string): string | undefined {
  const c = getBinaryNodeChild(parent, tag);
  if (!c) return undefined;
  if (typeof c.content === "string") return c.content;
  if (c.content instanceof Uint8Array) return utf8Decode(c.content);
  return undefined;
}
function numChild(parent: BinaryNode | undefined, tag: string): number | undefined {
  const s = childStr(parent, tag);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export interface BusinessProfile {
  wid?: string;
  address?: string;
  description?: string;
  website?: string[];
  email?: string;
  category?: string;
  businessHours?: {
    timezone?: string;
    config?: Array<Record<string, string>>;
  };
}

export interface CatalogProduct {
  id?: string;
  name?: string;
  description?: string;
  price?: number;
  currency?: string;
  retailerId?: string;
  url?: string;
  isHidden: boolean;
  imageUrls: string[];
  reviewStatus?: string;
}

export interface Catalog {
  products: CatalogProduct[];
  nextPageCursor?: string;
}

export interface Collection {
  id?: string;
  name?: string;
  products: CatalogProduct[];
}

export interface OrderDetails {
  price: { total?: number; currency?: string };
  products: Array<{
    id?: string;
    name?: string;
    imageUrl?: string;
    price?: number;
    currency?: string;
    quantity?: number;
  }>;
}

export interface BusinessLayerOptions {
  query: (n: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>;
  /** jid da conta logada (fallback quando `jid` não é passado). */
  meId: () => string | undefined;
}

export interface BusinessLayer {
  getBusinessProfile(jid: string): Promise<BusinessProfile | undefined>;
  getCatalog(opts?: { jid?: string; limit?: number; cursor?: string }): Promise<Catalog>;
  getCollections(jid?: string, limit?: number): Promise<Collection[]>;
  getOrderDetails(orderId: string, tokenBase64: string): Promise<OrderDetails>;
}

function parseProduct(p: BinaryNode): CatalogProduct {
  const media = getBinaryNodeChild(p, "media");
  const statusInfo = getBinaryNodeChild(p, "status_info");
  const imageUrls = getBinaryNodeChildren(media, "image")
    .map((im) => childStr(im, "original_image_url") ?? childStr(im, "url"))
    .filter((u): u is string => !!u);
  return {
    id: childStr(p, "id"),
    name: childStr(p, "name"),
    description: childStr(p, "description"),
    price: numChild(p, "price"),
    currency: childStr(p, "currency"),
    retailerId: childStr(p, "retailer_id"),
    url: childStr(p, "url"),
    isHidden: p.attrs.is_hidden === "true",
    imageUrls,
    reviewStatus: childStr(statusInfo, "status"),
  };
}

export function parseCatalogNode(res: BinaryNode): Catalog {
  const cat = getBinaryNodeChild(res, "product_catalog");
  const paging = getBinaryNodeChild(cat, "paging");
  return {
    products: getBinaryNodeChildren(cat, "product").map(parseProduct),
    nextPageCursor: childStr(paging, "after"),
  };
}

export function createBusinessLayer(o: BusinessLayerOptions): BusinessLayer {
  const { query } = o;
  const norm = (jid?: string): string => {
    const j = jid || o.meId() || "";
    const at = j.indexOf("@");
    if (at < 0) return j;
    const user = j.slice(0, at).split(":")[0]!.split("_")[0]!;
    return `${user}@s.whatsapp.net`;
  };

  async function getBusinessProfile(jid: string): Promise<BusinessProfile | undefined> {
    const res = await query(
      node("iq", { to: S_WHATSAPP_NET, xmlns: "w:biz", type: "get" }, [
        node("business_profile", { v: "244" }, [node("profile", { jid: norm(jid) })]),
      ]),
    );
    const profileNode = getBinaryNodeChild(res, "business_profile");
    const p = getBinaryNodeChild(profileNode, "profile");
    if (!p) return undefined;
    const bh = getBinaryNodeChild(p, "business_hours");
    const website = childStr(p, "website");
    return {
      wid: p.attrs.jid,
      address: childStr(p, "address"),
      description: childStr(p, "description") ?? "",
      website: website ? [website] : [],
      email: childStr(p, "email"),
      category: childStr(getBinaryNodeChild(p, "categories"), "category"),
      businessHours: bh
        ? {
            timezone: bh.attrs.timezone,
            config: getBinaryNodeChildren(bh, "business_hours_config").map((c) => ({ ...c.attrs })),
          }
        : undefined,
    };
  }

  async function getCatalog(opts?: {
    jid?: string;
    limit?: number;
    cursor?: string;
  }): Promise<Catalog> {
    const params: BinaryNode[] = [
      node("limit", {}, utf8Encode(String(opts?.limit ?? 10))),
      node("width", {}, utf8Encode("100")),
      node("height", {}, utf8Encode("100")),
    ];
    if (opts?.cursor) params.push(node("after", {}, utf8Encode(opts.cursor)));
    const res = await query(
      node("iq", { to: S_WHATSAPP_NET, type: "get", xmlns: "w:biz:catalog" }, [
        node("product_catalog", { jid: norm(opts?.jid), allow_shop_source: "true" }, params),
      ]),
    );
    return parseCatalogNode(res);
  }

  async function getCollections(jid?: string, limit = 51): Promise<Collection[]> {
    const res = await query(
      node("iq", { to: S_WHATSAPP_NET, type: "get", xmlns: "w:biz:catalog", smax_id: "35" }, [
        node("collections", { biz_jid: norm(jid) }, [
          node("collection_limit", {}, utf8Encode(String(limit))),
          node("item_limit", {}, utf8Encode(String(limit))),
          node("width", {}, utf8Encode("100")),
          node("height", {}, utf8Encode("100")),
        ]),
      ]),
    );
    const wrap = getBinaryNodeChild(res, "collections");
    return getBinaryNodeChildren(wrap, "collection").map((c) => ({
      id: childStr(c, "id"),
      name: childStr(c, "name"),
      products: getBinaryNodeChildren(c, "product").map(parseProduct),
    }));
  }

  async function getOrderDetails(
    orderId: string,
    tokenBase64: string,
  ): Promise<OrderDetails> {
    const res = await query(
      node("iq", { to: S_WHATSAPP_NET, type: "get", xmlns: "fb:thrift_iq", smax_id: "5" }, [
        node("order", { op: "get", id: orderId }, [
          node("image_dimensions", {}, [
            node("width", {}, utf8Encode("100")),
            node("height", {}, utf8Encode("100")),
          ]),
          node("token", {}, utf8Encode(tokenBase64)),
        ]),
      ]),
    );
    const orderNode = getBinaryNodeChild(res, "order");
    const priceNode = getBinaryNodeChild(orderNode, "price");
    return {
      price: { total: numChild(priceNode, "total"), currency: childStr(priceNode, "currency") },
      products: getBinaryNodeChildren(orderNode, "product").map((p) => ({
        id: childStr(p, "id"),
        name: childStr(p, "name"),
        imageUrl: childStr(getBinaryNodeChild(p, "image"), "url"),
        price: numChild(p, "price"),
        currency: childStr(p, "currency"),
        quantity: numChild(p, "quantity"),
      })),
    };
  }

  return { getBusinessProfile, getCatalog, getCollections, getOrderDetails };
}
