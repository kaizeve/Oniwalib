// Business (src/business): <iq w:biz> / <iq w:biz:catalog> — leitura.

import { createBusinessLayer, parseCatalogNode } from "../src/business";
import { getBinaryNodeChild, node, type BinaryNode } from "../src/frame/node";
import { utf8Encode } from "../src/frame/buffer";

let pass = 0;
let fail = 0;
const fails: string[] = [];
const ok = (n: string, c: boolean, d = "") => {
  if (c) pass++;
  else {
    fail++;
    fails.push(n + (d ? ` — ${d}` : ""));
  }
};

const BIZ = "5511999999999@s.whatsapp.net";
let sent: BinaryNode | undefined;
let reply: BinaryNode;
const query = async (n: BinaryNode): Promise<BinaryNode> => {
  sent = n;
  return reply;
};
const biz = createBusinessLayer({ query, meId: () => "5511000000000:3@s.whatsapp.net" });

// --- getBusinessProfile ------------------------------------------
{
  reply = node("iq", { type: "result" }, [
    node("business_profile", {}, [
      node("profile", { jid: BIZ }, [
        node("address", {}, utf8Encode("Rua X, 123")),
        node("description", {}, utf8Encode("Loja de teste")),
        node("website", {}, utf8Encode("https://loja.example")),
        node("email", {}, utf8Encode("loja@example.com")),
        node("categories", {}, [node("category", {}, utf8Encode("Varejo"))]),
        node("business_hours", { timezone: "America/Sao_Paulo" }, [
          node("business_hours_config", { day_of_week: "mon", mode: "open", open_time: "540", close_time: "1080" }),
        ]),
      ]),
    ]),
  ]);
  const p = await biz.getBusinessProfile(BIZ);
  ok("profile: iq get xmlns w:biz", sent?.attrs.type === "get" && sent?.attrs.xmlns === "w:biz");
  ok("profile: <business_profile v><profile jid>", getBinaryNodeChild(getBinaryNodeChild(sent, "business_profile"), "profile")?.attrs.jid === BIZ);
  ok("profile: address", p?.address === "Rua X, 123");
  ok("profile: description", p?.description === "Loja de teste");
  ok("profile: website array", p?.website?.[0] === "https://loja.example");
  ok("profile: email", p?.email === "loja@example.com");
  ok("profile: category", p?.category === "Varejo");
  ok("profile: businessHours tz + config", p?.businessHours?.timezone === "America/Sao_Paulo" && p?.businessHours?.config?.[0]?.open_time === "540");

  reply = node("iq", { type: "result" }, []);
  ok("profile: sem <profile> → undefined", (await biz.getBusinessProfile(BIZ)) === undefined);
}

// --- getCatalog -------------------------------------------------
{
  reply = node("iq", { type: "result" }, [
    node("product_catalog", {}, [
      node("product", { is_hidden: "false" }, [
        node("id", {}, utf8Encode("PROD1")),
        node("name", {}, utf8Encode("Camiseta")),
        node("description", {}, utf8Encode("100% algodão")),
        node("price", {}, utf8Encode("4990")),
        node("currency", {}, utf8Encode("BRL")),
        node("retailer_id", {}, utf8Encode("SKU-1")),
        node("media", {}, [node("image", {}, [node("original_image_url", {}, utf8Encode("https://img/1.jpg"))])]),
        node("status_info", {}, [node("status", {}, utf8Encode("APPROVED"))]),
      ]),
      node("product", { is_hidden: "true" }, [node("id", {}, utf8Encode("PROD2")), node("name", {}, utf8Encode("Oculto"))]),
      node("paging", {}, [node("after", {}, utf8Encode("CURSOR123"))]),
    ]),
  ]);
  const cat = await biz.getCatalog({ jid: BIZ, limit: 20, cursor: "PREV" });
  ok("catalog: iq get xmlns w:biz:catalog", sent?.attrs.xmlns === "w:biz:catalog" && sent?.attrs.type === "get");
  const pc = getBinaryNodeChild(sent, "product_catalog");
  ok("catalog: <product_catalog jid allow_shop_source>", pc?.attrs.jid === BIZ && pc?.attrs.allow_shop_source === "true");
  ok("catalog: limit + after nos params", getBinaryNodeChild(pc, "limit") !== undefined && getBinaryNodeChild(pc, "after") !== undefined);
  ok("catalog: 2 produtos", cat.products.length === 2);
  ok("catalog: produto 1 parseado", cat.products[0]?.id === "PROD1" && cat.products[0]?.name === "Camiseta" && cat.products[0]?.price === 4990 && cat.products[0]?.currency === "BRL");
  ok("catalog: imageUrls", cat.products[0]?.imageUrls[0] === "https://img/1.jpg");
  ok("catalog: reviewStatus", cat.products[0]?.reviewStatus === "APPROVED");
  ok("catalog: produto 2 isHidden", cat.products[1]?.isHidden === true);
  ok("catalog: nextPageCursor", cat.nextPageCursor === "CURSOR123");

  // fallback pro meId (normalizado) quando jid não vem
  await biz.getCatalog();
  ok("catalog: sem jid usa meId normalizado", getBinaryNodeChild(sent, "product_catalog")?.attrs.jid === "5511000000000@s.whatsapp.net");
}

// --- getCollections ------------------------------------------
{
  reply = node("iq", { type: "result" }, [
    node("collections", {}, [
      node("collection", {}, [
        node("id", {}, utf8Encode("COL1")),
        node("name", {}, utf8Encode("Novidades")),
        node("product", {}, [node("id", {}, utf8Encode("P9")), node("name", {}, utf8Encode("Item"))]),
      ]),
    ]),
  ]);
  const cols = await biz.getCollections(BIZ, 10);
  ok("collections: iq get w:biz:catalog + smax_id", sent?.attrs.xmlns === "w:biz:catalog" && sent?.attrs.smax_id === "35");
  ok("collections: <collections biz_jid>", getBinaryNodeChild(sent, "collections")?.attrs.biz_jid === BIZ);
  ok("collections: 1 coleção com 1 produto", cols.length === 1 && cols[0]?.name === "Novidades" && cols[0]?.products[0]?.id === "P9");
}

// --- getOrderDetails ---------------------------------------
{
  reply = node("iq", { type: "result" }, [
    node("order", {}, [
      node("price", {}, [node("total", {}, utf8Encode("9980")), node("currency", {}, utf8Encode("BRL"))]),
      node("product", {}, [
        node("id", {}, utf8Encode("P1")),
        node("name", {}, utf8Encode("Camiseta")),
        node("price", {}, utf8Encode("4990")),
        node("currency", {}, utf8Encode("BRL")),
        node("quantity", {}, utf8Encode("2")),
        node("image", {}, [node("url", {}, utf8Encode("https://img/p1.jpg"))]),
      ]),
    ]),
  ]);
  const od = await biz.getOrderDetails("ORDER1", "tok==");
  ok("order: iq get fb:thrift_iq", sent?.attrs.xmlns === "fb:thrift_iq");
  ok("order: <order op=get id>", getBinaryNodeChild(sent, "order")?.attrs.op === "get" && getBinaryNodeChild(sent, "order")?.attrs.id === "ORDER1");
  ok("order: price total + currency", od.price.total === 9980 && od.price.currency === "BRL");
  ok("order: produto com qtd e imagem", od.products[0]?.quantity === 2 && od.products[0]?.imageUrl === "https://img/p1.jpg" && od.products[0]?.price === 4990);
}

// --- parseCatalogNode isolado --------------------------------
{
  const parsed = parseCatalogNode(node("iq", {}, [node("product_catalog", {}, [node("product", {}, [node("id", {}, utf8Encode("X"))])])]));
  ok("parseCatalogNode: exportado e funciona", parsed.products.length === 1 && parsed.products[0]?.id === "X");
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/business [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
