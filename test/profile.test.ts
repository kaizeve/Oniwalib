// Camada de perfil (src/profile/index.ts): monta os <iq> de foto e bio. O
// `query` é um dublê que captura o node que iria pro socket.

import { createProfileLayer } from "../src/profile";
import { getBinaryNodeChild, node, type BinaryNode } from "../src/frame/node";
import { utf8Decode } from "../src/frame/buffer";

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

let sent: BinaryNode | undefined;
const query = async (n: BinaryNode): Promise<BinaryNode> => {
  sent = n;
  return node("iq", { type: "result", id: n.attrs.id ?? "1" });
};
const profile = createProfileLayer({ query });

// --- foto ------------------------------------------------------------
{
  const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  await profile.setProfilePicture(JPEG);
  ok("foto: iq set / xmlns w:profile:picture", sent?.attrs.type === "set" && sent?.attrs.xmlns === "w:profile:picture");
  ok("foto: to s.whatsapp.net", sent?.attrs.to === "@s.whatsapp.net");
  ok("foto: sem target (é a própria conta)", sent?.attrs.target === undefined);
  const pic = getBinaryNodeChild(sent, "picture");
  ok("foto: <picture type=image>", pic?.attrs.type === "image");
  ok("foto: conteúdo = os bytes do JPEG", pic?.content instanceof Uint8Array && (pic!.content as Uint8Array).length === JPEG.length && (pic!.content as Uint8Array)[0] === 0xff);
}

// --- remover foto --------------------------------------------------
{
  sent = undefined;
  await profile.removeProfilePicture();
  ok("remover: iq set / xmlns w:profile:picture", sent?.attrs.type === "set" && sent?.attrs.xmlns === "w:profile:picture");
  ok("remover: sem <picture>", getBinaryNodeChild(sent, "picture") === undefined);
  ok("remover: sem conteúdo", sent?.content === undefined);
}

// --- bio ----------------------------------------------------------
{
  sent = undefined;
  await profile.setBio("no ar 24/7 ✨");
  ok("bio: iq set / xmlns status", sent?.attrs.type === "set" && sent?.attrs.xmlns === "status");
  const st = getBinaryNodeChild(sent, "status");
  ok("bio: <status> com o texto utf-8", st?.content instanceof Uint8Array && utf8Decode(st!.content as Uint8Array) === "no ar 24/7 ✨");
}

// --- erro -------------------------------------------------------
{
  let threw = "";
  try {
    await profile.setProfilePicture(new Uint8Array(0));
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("foto vazia → erro", threw.length > 0, threw);
}

// --- getProfilePictureUrl -------------------------------------------
{
  let seen: BinaryNode | undefined;
  const p = createProfileLayer({
    query: async (n) => {
      seen = n;
      return node("iq", { type: "result", id: "1" }, [
        node("picture", { type: "preview", url: "https://pps.whatsapp.net/x.jpg" }),
      ]);
    },
  });
  const url = await p.getProfilePictureUrl("5511999@s.whatsapp.net");
  ok("pfp: iq get / to = jid alvo", seen?.attrs.type === "get" && seen?.attrs.to === "5511999@s.whatsapp.net");
  ok("pfp: <picture query=url type=preview>", getBinaryNodeChild(seen, "picture")?.attrs.query === "url" && getBinaryNodeChild(seen, "picture")?.attrs.type === "preview");
  ok("pfp: devolve a url", url === "https://pps.whatsapp.net/x.jpg");
  ok("pfp: hd → type=image", (await createProfileLayer({
    query: async (n) => { seen = n; return node("iq", { type: "result" }, [node("picture", { url: "u" })]); },
  }).getProfilePictureUrl("j", true), getBinaryNodeChild(seen, "picture")?.attrs.type === "image"));
}
{
  // <iq type=error> → undefined (sem foto / privado)
  const p = createProfileLayer({ query: async () => { throw new Error("item-not-found"); } });
  ok("pfp: erro do servidor → undefined", (await p.getProfilePictureUrl("j")) === undefined);
}

// --- fetchStatus --------------------------------------------------
{
  let seen: BinaryNode | undefined;
  const p = createProfileLayer({
    query: async (n) => {
      seen = n;
      return node("iq", { type: "result", id: "1" }, [
        node("status", {}, [node("user", { jid: "5511999@s.whatsapp.net", t: "1700000000" }, "vivendo a vida")]),
      ]);
    },
  });
  const s = await p.fetchStatus("5511999@s.whatsapp.net");
  ok("status: iq get / xmlns status", seen?.attrs.type === "get" && seen?.attrs.xmlns === "status");
  ok("status: <status><user jid>", getBinaryNodeChild(getBinaryNodeChild(seen, "status"), "user")?.attrs.jid === "5511999@s.whatsapp.net");
  ok("status: texto + data", s?.status === "vivendo a vida" && s?.setAt?.getTime() === 1700000000000);
}
{
  const p = createProfileLayer({ query: async () => node("iq", { type: "result" }, [node("status", {})]) });
  ok("status: sem <user> → undefined", (await p.fetchStatus("j")) === undefined);
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/profile [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
