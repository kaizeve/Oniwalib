// Camada de mídia (src/media/index.ts): cifra um áudio, faz o <iq> media_conn,
// posta no host e devolve `audioMessage`. Sem socket nem rede de verdade — o
// `query` e o `fetch` são dublês que capturam o que a camada mandaria.

import { crypto } from "../src/crypto";
import { createMediaLayer } from "../src/media";
import { node, getBinaryNodeChild, type BinaryNode } from "../src/frame/node";
import { encodeE2EMessage, decodeE2EMessage } from "../src/proto/e2e-message";
import { utf8Encode } from "../src/frame/buffer";

const C = crypto();
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
const eq = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function b64urlDecode(s: string): Uint8Array {
  const T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of s) {
    const v = T.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

// --- dublês ---------------------------------------------------------------
const AUDIO = C.randomBytes(5000); // "arquivo" de áudio

let iqSent: BinaryNode | undefined;
const query = async (n: BinaryNode): Promise<BinaryNode> => {
  iqSent = n;
  return node("iq", { type: "result", id: n.attrs.id }, [
    node("media_conn", { auth: "AUTH+TOKEN/xyz==", ttl: "3600" }, [
      node("host", { hostname: "mmg.example.net" }),
      node("host", { hostname: "mmg-fallback.example.net" }),
    ]),
  ]);
};

let postUrl = "";
let postBody: Uint8Array | undefined;
let postHeaders: Record<string, string> | undefined;
const fetchOk = async (url: string, init?: { headers?: Record<string, string>; body?: Uint8Array }) => {
  postUrl = url;
  postBody = init?.body;
  postHeaders = init?.headers;
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ url: "https://mmg.example.net/v/file", direct_path: "/v/file" }),
  };
};

// --- happy path ---------------------------------------------------------
{
  const media = createMediaLayer({ crypto: C, query, fetch: fetchOk });
  const msg = await media.buildAudioMessage(AUDIO, { mimetype: "audio/mpeg", seconds: 42, ptt: true });
  const a = msg.audioMessage!;

  ok("iq: xmlns w:m / type set", iqSent?.attrs.xmlns === "w:m" && iqSent?.attrs.type === "set");
  ok("iq: tem <media_conn>", !!getBinaryNodeChild(iqSent, "media_conn"));

  ok("POST no primeiro host", postUrl.startsWith("https://mmg.example.net/mms/audio/"));
  ok("URL tem auth= url-encoded", postUrl.includes("auth=AUTH%2BTOKEN%2Fxyz%3D%3D"));
  ok("URL tem token=", /[?&]token=[A-Za-z0-9_-]{43}(&|$)/.test(postUrl));
  ok("header Content-Type octet-stream", postHeaders?.["Content-Type"] === "application/octet-stream");
  ok("header Origin web.whatsapp.com", postHeaders?.Origin === "https://web.whatsapp.com");

  // corpo = enc ‖ mac(10);  sha256(corpo) = fileEncSha256 = token da URL
  ok("body = enc ‖ mac de 10 bytes", !!postBody && postBody.length === (a.fileLength! + (16 - (a.fileLength! % 16)) + 10));
  ok("fileEncSha256 = sha256(body)", !!postBody && eq(a.fileEncSha256!, C.sha256(postBody)));
  const tokenInUrl = decodeURIComponent(postUrl.split("/mms/audio/")[1]!.split("?")[0]!);
  ok("token da URL = fileEncSha256", eq(b64urlDecode(tokenInUrl), a.fileEncSha256!));

  // decifra o corpo com a mediaKey → volta o áudio original (valida HKDF/CBC/MAC)
  const exp = C.hkdf(a.mediaKey!, 112, { info: utf8Encode("WhatsApp Audio Keys") });
  const iv = exp.subarray(0, 16);
  const cipherKey = exp.subarray(16, 48);
  const macKey = exp.subarray(48, 80);
  const enc = postBody!.subarray(0, postBody!.length - 10);
  const mac = postBody!.subarray(postBody!.length - 10);
  const macCalc = C.hmacSha256(macKey, concat(iv, enc)).subarray(0, 10);
  ok("mac de 10 bytes confere", eq(mac, macCalc));
  ok("AES-CBC decifra de volta o áudio", eq(C.aesCbcDecrypt(cipherKey, iv, enc), AUDIO));

  ok("fileSha256 = sha256(plaintext)", eq(a.fileSha256!, C.sha256(AUDIO)));
  ok("fileLength = tamanho do áudio", a.fileLength === AUDIO.length);
  ok("url / directPath do JSON", a.url === "https://mmg.example.net/v/file" && a.directPath === "/v/file");
  ok("mimetype preservado", a.mimetype === "audio/mpeg");
  ok("seconds / ptt preservados", a.seconds === 42 && a.ptt === true);
  ok("mediaKeyTimestamp ~ agora", Math.abs(a.mediaKeyTimestamp! - Math.floor(Date.now() / 1000)) <= 5);

  // roundtrip no codec E2E
  const rt = decodeE2EMessage(encodeE2EMessage(msg)).audioMessage!;
  ok("codec: url", rt.url === a.url);
  ok("codec: directPath", rt.directPath === a.directPath);
  ok("codec: mediaKey", eq(rt.mediaKey!, a.mediaKey!));
  ok("codec: fileEncSha256", eq(rt.fileEncSha256!, a.fileEncSha256!));
  ok("codec: fileSha256", eq(rt.fileSha256!, a.fileSha256!));
  ok("codec: fileLength", rt.fileLength === a.fileLength);
  ok("codec: seconds / ptt", rt.seconds === 42 && rt.ptt === true);
  ok("codec: mediaKeyTimestamp", rt.mediaKeyTimestamp === a.mediaKeyTimestamp);
}

// --- default mimetype + música (sem ptt) ------------------------------
{
  const media = createMediaLayer({ crypto: C, query, fetch: fetchOk });
  const msg = await media.buildAudioMessage(AUDIO);
  ok("mimetype default audio/mp4", msg.audioMessage!.mimetype === "audio/mp4");
  ok("ptt ausente vira undefined", msg.audioMessage!.ptt === undefined);
  const rt = decodeE2EMessage(encodeE2EMessage(msg)).audioMessage!;
  ok("codec: ptt false não vaza como true", rt.ptt === false);
}

// --- fallback de host quando o primeiro falha ------------------------
{
  let n = 0;
  const flaky = async (url: string, init?: { headers?: Record<string, string>; body?: Uint8Array }) => {
    n++;
    if (url.includes("//mmg.example.net/")) return { ok: false, status: 500, text: async () => "boom" };
    return fetchOk(url, init);
  };
  const media = createMediaLayer({ crypto: C, query, fetch: flaky });
  const msg = await media.buildAudioMessage(AUDIO);
  ok("tentou 2 hosts", n === 2);
  ok("subiu pelo host de fallback", postUrl.includes("mmg-fallback.example.net"));
  ok("audioMessage mesmo assim", !!msg.audioMessage?.url);
}

// --- erros -----------------------------------------------------------
{
  const noFetch = createMediaLayer({ crypto: C, query });
  let threw = "";
  try {
    await noFetch.buildAudioMessage(AUDIO);
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("sem fetch → erro claro", threw.includes("fetch"), threw);
}
{
  const media = createMediaLayer({ crypto: C, query, fetch: fetchOk });
  let threw = "";
  try {
    await media.buildAudioMessage(new Uint8Array(0));
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("áudio vazio → erro", threw.length > 0, threw);
}
{
  const badConn = async (nq: BinaryNode) =>
    node("iq", { type: "result", id: nq.attrs.id }, [node("media_conn", { ttl: "1" })]);
  const media = createMediaLayer({ crypto: C, query: badConn, fetch: fetchOk });
  let threw = "";
  try {
    await media.buildAudioMessage(AUDIO);
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("media_conn sem auth/hosts → erro", threw.includes("auth") || threw.includes("host"), threw);
}
{
  const allFail = async (url: string, init?: { headers?: Record<string, string>; body?: Uint8Array }) => ({
    ok: false,
    status: 503,
    text: async () => "nope",
  });
  const media = createMediaLayer({ crypto: C, query, fetch: allFail });
  let threw = "";
  try {
    await media.buildAudioMessage(AUDIO);
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("todos os hosts com erro → propaga HTTP 503", threw.includes("503"), threw);
}

// --- outros tipos de mídia -------------------------------------------
// decifra o último `postBody` com a mediaKey dada + info do tipo.
function decryptBody(mediaKey: Uint8Array, info: string): Uint8Array {
  const exp = C.hkdf(mediaKey, 112, { info: utf8Encode(info) });
  const iv = exp.subarray(0, 16);
  const cipherKey = exp.subarray(16, 48);
  const enc = postBody!.subarray(0, postBody!.length - 10);
  return C.aesCbcDecrypt(cipherKey, iv, enc);
}

{
  const media = createMediaLayer({ crypto: C, query, fetch: fetchOk });

  const IMG = C.randomBytes(3333);
  const im = (await media.buildImageMessage(IMG, { caption: "oi", width: 800, height: 600 }))
    .imageMessage!;
  ok("image: POST em /mms/image/", postUrl.includes("/mms/image/"));
  ok("image: decifra de volta", eq(decryptBody(im.mediaKey!, "WhatsApp Image Keys"), IMG));
  ok("image: caption / dimensões / mimetype", im.caption === "oi" && im.width === 800 && im.height === 600 && im.mimetype === "image/jpeg");
  const imr = decodeE2EMessage(encodeE2EMessage({ imageMessage: im })).imageMessage!;
  ok("image: codec roundtrip", imr.caption === "oi" && imr.width === 800 && eq(imr.fileEncSha256!, im.fileEncSha256!) && eq(imr.mediaKey!, im.mediaKey!));

  const DOC = C.randomBytes(9000);
  const dm = (await media.buildDocumentMessage(DOC, { fileName: "nota.pdf", mimetype: "application/pdf", pageCount: 3 }))
    .documentMessage!;
  ok("document: POST em /mms/document/", postUrl.includes("/mms/document/"));
  ok("document: decifra de volta", eq(decryptBody(dm.mediaKey!, "WhatsApp Document Keys"), DOC));
  ok("document: fileName vira title tbm", dm.fileName === "nota.pdf" && dm.title === "nota.pdf" && dm.pageCount === 3);
  const dmr = decodeE2EMessage(encodeE2EMessage({ documentMessage: dm })).documentMessage!;
  ok("document: codec roundtrip", dmr.fileName === "nota.pdf" && dmr.pageCount === 3 && dmr.mimetype === "application/pdf");

  const VID = C.randomBytes(12000);
  const vm = (await media.buildVideoMessage(VID, { caption: "clip", seconds: 8, gifPlayback: true }))
    .videoMessage!;
  ok("video: POST em /mms/video/", postUrl.includes("/mms/video/"));
  ok("video: decifra de volta", eq(decryptBody(vm.mediaKey!, "WhatsApp Video Keys"), VID));
  ok("video: caption / seconds / gifPlayback", vm.caption === "clip" && vm.seconds === 8 && vm.gifPlayback === true);
  const vmr = decodeE2EMessage(encodeE2EMessage({ videoMessage: vm })).videoMessage!;
  ok("video: codec roundtrip", vmr.caption === "clip" && vmr.seconds === 8 && vmr.gifPlayback === true);

  const STK = C.randomBytes(2048);
  const sm = (await media.buildStickerMessage(STK, { isAnimated: true, width: 512, height: 512 }))
    .stickerMessage!;
  ok("sticker: POST em /mms/image/ (tipo image)", postUrl.includes("/mms/image/"));
  ok("sticker: decifra de volta", eq(decryptBody(sm.mediaKey!, "WhatsApp Image Keys"), STK));
  ok("sticker: mimetype webp / isAnimated", sm.mimetype === "image/webp" && sm.isAnimated === true);
  const smr = decodeE2EMessage(encodeE2EMessage({ stickerMessage: sm })).stickerMessage!;
  ok("sticker: codec roundtrip", smr.isAnimated === true && smr.width === 512 && eq(smr.mediaKey!, sm.mediaKey!));
}

// --- downloadMedia: baixa + decifra + verifica -----------------------
// Sobe uma imagem de verdade pela própria camada (o `fetchOk` captura o corpo
// cifrado em `postBody`), depois alimenta esse corpo de volta no `downloadMedia`
// via um `fetch` de download que expõe `arrayBuffer()`.
const ab = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

{
  const media = createMediaLayer({ crypto: C, query, fetch: fetchOk });
  const IMG = C.randomBytes(4096);
  const built = (await media.buildImageMessage(IMG, { mimetype: "image/png", caption: "x" }))
    .imageMessage!;
  const cipherBody = postBody!.slice(); // enc ‖ mac(10) que subiu

  const dlFetch = async (_url: string) => ({
    ok: true,
    status: 200,
    text: async () => "",
    arrayBuffer: async () => ab(cipherBody),
  });
  const dl = createMediaLayer({ crypto: C, query, fetch: dlFetch });

  const got = await dl.downloadMedia({ imageMessage: built });
  ok("download: bytes decifrados == original", eq(got.data, IMG));
  ok("download: type = image", got.type === "image");
  ok("download: mimetype preservado", got.mimetype === "image/png");

  // desembrulha os wrappers
  const v = await dl.downloadMedia({ viewOnceMessage: { message: { imageMessage: built } } });
  ok("download: desembrulha viewOnceMessage", eq(v.data, IMG));
  const d = await dl.downloadMedia({
    deviceSentMessage: { destinationJid: "x@s.whatsapp.net", message: { imageMessage: built } },
  });
  ok("download: desembrulha deviceSentMessage", eq(d.data, IMG));

  // directPath → monta a URL do host de mídia
  let seenUrl = "";
  const recFetch = async (url: string) => {
    seenUrl = url;
    return { ok: true, status: 200, text: async () => "", arrayBuffer: async () => ab(cipherBody) };
  };
  await createMediaLayer({ crypto: C, query, fetch: recFetch }).downloadMedia({
    imageMessage: { ...built, url: undefined, directPath: "/o1/v/t62/f2/xyz.enc" },
  });
  ok(
    "download: directPath vira https://mmg.whatsapp.net<path>",
    seenUrl === "https://mmg.whatsapp.net/o1/v/t62/f2/xyz.enc",
    seenUrl,
  );

  // MAC errado (corpo corrompido)
  const bad = cipherBody.slice();
  bad[0] = bad[0]! ^ 0xff;
  let threw = "";
  try {
    await createMediaLayer({
      crypto: C,
      query,
      fetch: async () => ({ ok: true, status: 200, text: async () => "", arrayBuffer: async () => ab(bad) }),
    }).downloadMedia({ imageMessage: built });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("download: MAC errado → erro", threw.includes("MAC"), threw);

  // MAC ok mas fileSha256 não confere
  threw = "";
  try {
    await dl.downloadMedia({ imageMessage: { ...built, fileSha256: new Uint8Array(32) } });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("download: fileSha256 errado → erro", threw.includes("sha256"), threw);

  // sem mediaKey
  threw = "";
  try {
    await dl.downloadMedia({ imageMessage: { ...built, mediaKey: undefined } });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("download: sem mediaKey → erro", threw.includes("mediaKey"), threw);

  // sem url nem directPath
  threw = "";
  try {
    await dl.downloadMedia({ imageMessage: { ...built, url: undefined, directPath: undefined } });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("download: sem url nem directPath → erro", threw.includes("url"), threw);

  // sem fetch
  threw = "";
  try {
    await createMediaLayer({ crypto: C, query }).downloadMedia({ imageMessage: built });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("download: sem fetch → erro claro", threw.includes("fetch"), threw);

  // fetch sem arrayBuffer()
  threw = "";
  try {
    await createMediaLayer({ crypto: C, query, fetch: fetchOk }).downloadMedia({ imageMessage: built });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("download: fetch sem arrayBuffer → erro", threw.includes("arrayBuffer"), threw);

  // HTTP != 2xx
  threw = "";
  try {
    await createMediaLayer({
      crypto: C,
      query,
      fetch: async () => ({ ok: false, status: 404, text: async () => "nope" }),
    }).downloadMedia({ imageMessage: built });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("download: HTTP 404 → erro", threw.includes("404"), threw);

  // mensagem sem anexo
  threw = "";
  try {
    await dl.downloadMedia({ conversation: "só texto" });
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("download: mensagem sem anexo → erro", threw.length > 0, threw);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/media [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
