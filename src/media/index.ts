// Camada de MÍDIA — cifra um anexo, sobe ao servidor de mídia do WhatsApp e
// devolve o `Message` pronto para `messages.sendMessage`. Áudio, imagem, vídeo,
// documento e figurinha.
//
// Fluxo (espelha o `@whiskeysockets/baileys`, sem importar nada dele):
//   1. cifra os bytes: `mediaKey` aleatória → HKDF-SHA256(112 bytes, info por
//      tipo, ex. "WhatsApp Audio Keys") → iv(16) ‖ cipherKey(32) ‖ macKey(32) ‖
//      ref(32). `enc = AES-256-CBC(cipherKey, iv, plaintext)` (PKCS#7);
//      `mac = HMAC-SHA256(macKey, iv ‖ enc)[:10]`; `body = enc ‖ mac`.
//   2. `<iq type=set xmlns=w:m><media_conn/></iq>` → `auth` + lista de `host`.
//   3. `POST https://{host}/mms/{tipo}/{b64url(sha256(body))}?auth=…&token=…`
//      com `body` cru → JSON `{ url, direct_path }`.
//   4. monta o `*Message` com url/directPath/mediaKey/hashes.
//
// Portável exceto pelo `fetch`, que é INJETADO (o núcleo não assume um global de
// rede) — `client.ts` passa `globalThis.fetch` por padrão.

import type { Crypto } from "../crypto/types";
import {
  node,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  type BinaryNode,
} from "../frame/node";
import { utf8Encode } from "../frame/buffer";
import { imageDimensions, mp4Dimensions } from "./image-meta";

export { imageDimensions, mp4Dimensions, type ImageSize } from "./image-meta";
import type { E2EMessage } from "../proto/e2e-message";

/** Subconjunto do `fetch` que a camada usa. `globalThis.fetch` satisfaz.
 *  `arrayBuffer` só é exercido no download de mídia recebida. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: Uint8Array;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}>;

export type MediaType = "image" | "video" | "audio" | "document" | "sticker";

const HKDF_INFO: Record<MediaType, string> = {
  image: "WhatsApp Image Keys",
  video: "WhatsApp Video Keys",
  audio: "WhatsApp Audio Keys",
  document: "WhatsApp Document Keys",
  sticker: "WhatsApp Image Keys",
};

const MMS_PATH: Record<MediaType, string> = {
  image: "image",
  video: "video",
  audio: "audio",
  document: "document",
  sticker: "image",
};

export interface MediaLayerOptions {
  crypto: Crypto;
  /** Faz um `<iq>` e resolve com o `<iq type=result>` correspondente. */
  query: (n: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>;
  /** `undefined` = ambiente sem rede HTTP; os `build*` então lançam. */
  fetch?: FetchLike;
}

export interface AudioOptions {
  /** Default `audio/mp4`. Use `audio/mpeg` (mp3), `audio/ogg; codecs=opus`, … */
  mimetype?: string;
  /** Duração em segundos (o WhatsApp mostra no player). */
  seconds?: number;
  /** `true` = nota de voz. Default `false` (player de música). */
  ptt?: boolean;
}

export interface ImageOptions {
  /** Default `image/jpeg`. */
  mimetype?: string;
  caption?: string;
  width?: number;
  height?: number;
  /** JPEG pequeno de preview (aparece antes do download). */
  jpegThumbnail?: Uint8Array;
  /** Ver uma vez: some depois de aberta. */
  viewOnce?: boolean;
}

export interface VideoOptions {
  /** Default `video/mp4`. */
  mimetype?: string;
  caption?: string;
  seconds?: number;
  /** `true` = trata um mp4 curto como GIF. */
  gifPlayback?: boolean;
  width?: number;
  height?: number;
  jpegThumbnail?: Uint8Array;
  /** Ver uma vez. */
  viewOnce?: boolean;
}

export interface DocumentOptions {
  /** Default `application/octet-stream`. */
  mimetype?: string;
  /** Nome que aparece no chat. */
  fileName?: string;
  title?: string;
  pageCount?: number;
  caption?: string;
  jpegThumbnail?: Uint8Array;
}

export interface StickerOptions {
  /** Default `image/webp`. */
  mimetype?: string;
  width?: number;
  height?: number;
  isAnimated?: boolean;
}

/** Anexo recebido, já decifrado e verificado. */
export interface DownloadedMedia {
  data: Uint8Array;
  type: MediaType;
  mimetype?: string;
}

export interface MediaLayer {
  buildAudioMessage(data: Uint8Array, opts?: AudioOptions): Promise<E2EMessage>;
  buildImageMessage(data: Uint8Array, opts?: ImageOptions): Promise<E2EMessage>;
  buildVideoMessage(data: Uint8Array, opts?: VideoOptions): Promise<E2EMessage>;
  buildDocumentMessage(data: Uint8Array, opts?: DocumentOptions): Promise<E2EMessage>;
  buildStickerMessage(data: Uint8Array, opts?: StickerOptions): Promise<E2EMessage>;
  /** Baixa + decifra + verifica (MAC de 10 bytes, e `fileSha256` se veio) o
   *  anexo de uma mensagem recebida (`imageMessage` / `videoMessage` /
   *  `audioMessage` / `documentMessage` / `stickerMessage`). */
  downloadMedia(msg: E2EMessage): Promise<DownloadedMedia>;
  /** Baixa + decifra + verifica um blob externo cifrado (mesmo esquema
   *  `enc‖mac(10)` + HKDF-112 + AES-CBC da mídia, mas com `info` próprio).
   *  Usado pelo app-state sync (`info = "WhatsApp App State Keys"`). */
  downloadEncryptedBlob(
    ref: { directPath?: string; url?: string; mediaKey: Uint8Array; fileEncSha256?: Uint8Array },
    hkdfInfo: string,
  ): Promise<Uint8Array>;
}

const S_WHATSAPP_NET = "@s.whatsapp.net";
const ORIGIN = "https://web.whatsapp.com";

interface Uploaded {
  url?: string;
  directPath?: string;
  mediaKey: Uint8Array;
  fileSha256: Uint8Array;
  fileEncSha256: Uint8Array;
  fileLength: number;
  mediaKeyTimestamp: number;
}

export function createMediaLayer(o: MediaLayerOptions): MediaLayer {
  const { crypto: c, query } = o;

  async function mediaConn(): Promise<{ auth: string; hosts: string[] }> {
    const res = await query(
      node("iq", { to: S_WHATSAPP_NET, type: "set", xmlns: "w:m" }, [node("media_conn", {})]),
    );
    const mc = getBinaryNodeChild(res, "media_conn");
    if (!mc) throw new Error("media_conn: resposta sem <media_conn>");
    const hosts = getBinaryNodeChildren(mc, "host")
      .map((h) => h.attrs.hostname)
      .filter((h): h is string => !!h);
    if (!mc.attrs.auth || hosts.length === 0) {
      throw new Error("media_conn: sem auth ou sem hosts");
    }
    return { auth: mc.attrs.auth, hosts };
  }

  async function encryptAndUpload(type: MediaType, data: Uint8Array): Promise<Uploaded> {
    const fetchImpl = o.fetch;
    if (!fetchImpl) {
      throw new Error("media: sem `fetch` — passe `fetch` em openWhatsApp para enviar mídia");
    }
    if (data.length === 0) throw new Error("media: anexo vazio");

    const mediaKey = c.randomBytes(32);
    const expanded = c.hkdf(mediaKey, 112, { info: utf8Encode(HKDF_INFO[type]) });
    const iv = expanded.subarray(0, 16);
    const cipherKey = expanded.subarray(16, 48);
    const macKey = expanded.subarray(48, 80);

    const enc = c.aesCbcEncrypt(cipherKey, iv, data);
    const mac = c.hmacSha256(macKey, concat(iv, enc)).subarray(0, 10);
    const body = concat(enc, mac);
    const fileEncSha256 = c.sha256(body);
    const fileSha256 = c.sha256(data);
    const token = b64url(fileEncSha256);

    const { auth, hosts } = await mediaConn();
    let out: { url: string; directPath: string } | undefined;
    let lastErr: Error | undefined;
    for (const host of hosts) {
      const url =
        `https://${host}/mms/${MMS_PATH[type]}/${token}` +
        `?auth=${encodeURIComponent(auth)}&token=${token}`;
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", Origin: ORIGIN },
          body,
        });
        // eslint-disable-next-line no-await-in-loop
        const txt = await r.text();
        if (!r.ok) {
          lastErr = new Error(`upload ${host}: HTTP ${r.status} ${txt.slice(0, 200)}`);
          continue;
        }
        const j = JSON.parse(txt) as { url?: string; direct_path?: string };
        if (!j.url && !j.direct_path) {
          lastErr = new Error(`upload ${host}: resposta sem url (${txt.slice(0, 200)})`);
          continue;
        }
        out = { url: j.url ?? "", directPath: j.direct_path ?? "" };
        break;
      } catch (e) {
        lastErr = e as Error;
      }
    }
    if (!out) throw lastErr ?? new Error("upload de mídia falhou em todos os hosts");

    return {
      url: out.url || undefined,
      directPath: out.directPath || undefined,
      mediaKey,
      fileSha256,
      fileEncSha256,
      fileLength: data.length,
      mediaKeyTimestamp: Math.floor(Date.now() / 1000),
    };
  }

  async function buildAudioMessage(data: Uint8Array, opts: AudioOptions = {}): Promise<E2EMessage> {
    const u = await encryptAndUpload("audio", data);
    return {
      audioMessage: {
        ...u,
        mimetype: opts.mimetype ?? "audio/mp4",
        seconds: opts.seconds,
        ptt: opts.ptt,
      },
    };
  }

  async function buildImageMessage(data: Uint8Array, opts: ImageOptions = {}): Promise<E2EMessage> {
    const u = await encryptAndUpload("image", data);
    // dimensões: usa as do chamador, senão lê do cabeçalho do arquivo.
    const dim =
      opts.width && opts.height ? { width: opts.width, height: opts.height } : imageDimensions(data);
    // thumbnail: se não veio e a imagem É um JPEG pequeno, embute ela mesma —
    // dá preview instantâneo sem decodificar/redimensionar (a oni não tem lib
    // nativa de imagem). JPEG grande / outro formato → sem thumb (chamador põe).
    const thumb =
      opts.jpegThumbnail ??
      (data.length <= 24576 && data[0] === 0xff && data[1] === 0xd8 ? data : undefined);
    return {
      imageMessage: {
        ...u,
        mimetype: opts.mimetype ?? "image/jpeg",
        caption: opts.caption,
        width: dim?.width,
        height: dim?.height,
        jpegThumbnail: thumb,
      },
    };
  }

  async function buildVideoMessage(data: Uint8Array, opts: VideoOptions = {}): Promise<E2EMessage> {
    const u = await encryptAndUpload("video", data);
    const dim =
      opts.width && opts.height ? { width: opts.width, height: opts.height } : mp4Dimensions(data);
    return {
      videoMessage: {
        ...u,
        mimetype: opts.mimetype ?? "video/mp4",
        caption: opts.caption,
        seconds: opts.seconds,
        gifPlayback: opts.gifPlayback,
        width: dim?.width,
        height: dim?.height,
        jpegThumbnail: opts.jpegThumbnail,
      },
    };
  }

  async function buildDocumentMessage(
    data: Uint8Array,
    opts: DocumentOptions = {},
  ): Promise<E2EMessage> {
    const u = await encryptAndUpload("document", data);
    return {
      documentMessage: {
        ...u,
        mimetype: opts.mimetype ?? "application/octet-stream",
        fileName: opts.fileName,
        title: opts.title ?? opts.fileName,
        pageCount: opts.pageCount,
        caption: opts.caption,
        jpegThumbnail: opts.jpegThumbnail,
      },
    };
  }

  async function buildStickerMessage(
    data: Uint8Array,
    opts: StickerOptions = {},
  ): Promise<E2EMessage> {
    const u = await encryptAndUpload("sticker", data);
    return {
      stickerMessage: {
        ...u,
        mimetype: opts.mimetype ?? "image/webp",
        width: opts.width,
        height: opts.height,
        isAnimated: opts.isAnimated,
      },
    };
  }

  async function downloadMedia(msg: E2EMessage): Promise<DownloadedMedia> {
    const picked = pickMedia(msg);
    if (!picked) throw new Error("media: a mensagem não tem anexo baixável");
    const { type, m } = picked;

    if (!m.mediaKey || m.mediaKey.length !== 32) {
      throw new Error(`media: ${type} sem mediaKey de 32 bytes`);
    }
    const url =
      m.url && /^https?:\/\//i.test(m.url)
        ? m.url
        : m.directPath
          ? `https://mmg.whatsapp.net${m.directPath}`
          : undefined;
    if (!url) throw new Error(`media: ${type} sem url nem directPath`);

    const fetchImpl = o.fetch;
    if (!fetchImpl) {
      throw new Error("media: sem `fetch` — passe `fetch` em openWhatsApp para baixar mídia");
    }
    const res = await fetchImpl(url, { headers: { Origin: ORIGIN, Referer: `${ORIGIN}/` } });
    if (!res.ok) throw new Error(`media: GET ${url} → HTTP ${res.status}`);
    if (typeof res.arrayBuffer !== "function") {
      throw new Error("media: a implementação de `fetch` não expõe arrayBuffer()");
    }
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.length <= 10) throw new Error("media: corpo cifrado curto demais");

    const enc = body.subarray(0, body.length - 10);
    const mac = body.subarray(body.length - 10);

    const expanded = c.hkdf(m.mediaKey, 112, { info: utf8Encode(HKDF_INFO[type]) });
    const iv = expanded.subarray(0, 16);
    const cipherKey = expanded.subarray(16, 48);
    const macKey = expanded.subarray(48, 80);

    if (!bytesEqual(c.hmacSha256(macKey, concat(iv, enc)).subarray(0, 10), mac)) {
      throw new Error("media: MAC não confere (mediaKey errada ou download corrompido)");
    }

    const data = c.aesCbcDecrypt(cipherKey, iv, enc);
    if (m.fileSha256 && m.fileSha256.length === 32 && !bytesEqual(c.sha256(data), m.fileSha256)) {
      throw new Error("media: sha256 do arquivo decifrado não confere");
    }
    return { data, type, mimetype: m.mimetype };
  }

  async function downloadEncryptedBlob(
    ref: { directPath?: string; url?: string; mediaKey: Uint8Array; fileEncSha256?: Uint8Array },
    hkdfInfo: string,
  ): Promise<Uint8Array> {
    if (!ref.mediaKey || ref.mediaKey.length !== 32) {
      throw new Error("media: blob externo sem mediaKey de 32 bytes");
    }
    const url =
      ref.url && /^https?:\/\//i.test(ref.url)
        ? ref.url
        : ref.directPath
          ? `https://mmg.whatsapp.net${ref.directPath}`
          : undefined;
    if (!url) throw new Error("media: blob externo sem url nem directPath");

    const fetchImpl = o.fetch;
    if (!fetchImpl) throw new Error("media: sem `fetch` — passe `fetch` em openWhatsApp");
    const res = await fetchImpl(url, { headers: { Origin: ORIGIN, Referer: `${ORIGIN}/` } });
    if (!res.ok) throw new Error(`media: GET ${url} → HTTP ${res.status}`);
    if (typeof res.arrayBuffer !== "function") {
      throw new Error("media: a implementação de `fetch` não expõe arrayBuffer()");
    }
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.length <= 10) throw new Error("media: blob externo curto demais");

    const enc = body.subarray(0, body.length - 10);
    const mac = body.subarray(body.length - 10);
    const expanded = c.hkdf(ref.mediaKey, 112, { info: utf8Encode(hkdfInfo) });
    const iv = expanded.subarray(0, 16);
    const cipherKey = expanded.subarray(16, 48);
    const macKey = expanded.subarray(48, 80);

    if (!bytesEqual(c.hmacSha256(macKey, concat(iv, enc)).subarray(0, 10), mac)) {
      throw new Error("media: MAC do blob externo não confere");
    }
    return c.aesCbcDecrypt(cipherKey, iv, enc);
  }

  return {
    buildAudioMessage,
    buildImageMessage,
    buildVideoMessage,
    buildDocumentMessage,
    buildStickerMessage,
    downloadMedia,
    downloadEncryptedBlob,
  };
}

/** `true` se a mensagem carrega um anexo que `downloadMedia` sabe baixar
 *  (imagem/vídeo/áudio/documento/figurinha, inclusive dentro de
 *  `viewOnceMessage`/`deviceSentMessage`). Não tem efeito colateral. */
export function hasDownloadableMedia(msg: E2EMessage): boolean {
  return pickMedia(msg) !== undefined;
}

/** Qual sub-mensagem de mídia (se alguma) e seus campos de download. */
function pickMedia(
  msg: E2EMessage,
): { type: MediaType; m: MediaFields } | undefined {
  const m = msg.deviceSentMessage?.message ?? msg.viewOnceMessage?.message ?? msg;
  if (m.imageMessage) return { type: "image", m: m.imageMessage };
  if (m.videoMessage) return { type: "video", m: m.videoMessage };
  if (m.audioMessage) return { type: "audio", m: m.audioMessage };
  if (m.documentMessage) return { type: "document", m: m.documentMessage };
  if (m.stickerMessage) return { type: "sticker", m: m.stickerMessage };
  return undefined;
}

interface MediaFields {
  url?: string;
  directPath?: string;
  mediaKey?: Uint8Array;
  fileSha256?: Uint8Array;
  fileEncSha256?: Uint8Array;
  mimetype?: string;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// base64url SEM padding — o formato que o servidor de mídia espera na URL.
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function b64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const d = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64URL[a >> 2];
    out += B64URL[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) out += B64URL[((b & 15) << 2) | (d >> 6)];
    if (i + 2 < bytes.length) out += B64URL[d & 63];
  }
  return out;
}
