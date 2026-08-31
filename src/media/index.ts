// Camada de MÍDIA — subir um anexo cifrado ao servidor de mídia do WhatsApp e
// devolver o `Message` pronto para `messages.sendMessage`. Hoje: só ÁUDIO (o
// tipo mais simples — sem thumbnail, sem sidecar de streaming).
//
// Fluxo (espelha o `@whiskeysockets/baileys`, sem importar nada dele):
//   1. cifra os bytes: `mediaKey` aleatória → HKDF-SHA256(112 bytes, info
//      "WhatsApp Audio Keys") → iv(16) ‖ cipherKey(32) ‖ macKey(32) ‖ ref(32).
//      `enc = AES-256-CBC(cipherKey, iv, plaintext)` (PKCS#7);
//      `mac = HMAC-SHA256(macKey, iv ‖ enc)[:10]`; `body = enc ‖ mac`.
//   2. `<iq type=set xmlns=w:m><media_conn/></iq>` → `auth` + lista de `host`.
//   3. `POST https://{host}/mms/audio/{b64url(sha256(body))}?auth=…&token=…`
//      com `body` cru → JSON `{ url, direct_path }`.
//   4. monta `audioMessage` com url/directPath/mediaKey/hashes.
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
import type { E2EMessage } from "../proto/e2e-message";

/** Subconjunto do `fetch` que a camada usa. `globalThis.fetch` satisfaz. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: Uint8Array;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface MediaLayerOptions {
  crypto: Crypto;
  /** Faz um `<iq>` e resolve com o `<iq type=result>` correspondente. */
  query: (n: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>;
  /** `undefined` = ambiente sem rede HTTP; `sendAudio` então lança. */
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

export interface MediaLayer {
  /** Cifra + sobe `data` e devolve `{ audioMessage }` pronto para enviar. */
  buildAudioMessage(data: Uint8Array, opts?: AudioOptions): Promise<E2EMessage>;
}

const S_WHATSAPP_NET = "@s.whatsapp.net";
const ORIGIN = "https://web.whatsapp.com";
const AUDIO_HKDF_INFO = "WhatsApp Audio Keys";

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

  async function buildAudioMessage(
    data: Uint8Array,
    opts: AudioOptions = {},
  ): Promise<E2EMessage> {
    const fetchImpl = o.fetch;
    if (!fetchImpl) {
      throw new Error("media: sem `fetch` — passe `fetch` em openWhatsApp para enviar mídia");
    }
    if (data.length === 0) throw new Error("media: áudio vazio");

    const mediaKey = c.randomBytes(32);
    const expanded = c.hkdf(mediaKey, 112, { info: utf8Encode(AUDIO_HKDF_INFO) });
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
        `https://${host}/mms/audio/${token}` +
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
      audioMessage: {
        url: out.url || undefined,
        directPath: out.directPath || undefined,
        mediaKey,
        mimetype: opts.mimetype ?? "audio/mp4",
        fileSha256,
        fileEncSha256,
        fileLength: data.length,
        seconds: opts.seconds,
        ptt: opts.ptt,
        mediaKeyTimestamp: Math.floor(Date.now() / 1000),
      },
    };
  }

  return { buildAudioMessage };
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
