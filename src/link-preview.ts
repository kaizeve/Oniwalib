// Preview de link para `sendText(jid, texto, { linkPreview: true })`. Pega a 1ª
// URL do texto, busca a página e tira título/descrição/URL canônica das meta
// tags (OpenGraph → Twitter → <title>/<meta name=description>).
//
// SEM imagem: gerar o `jpegThumbnail` do preview exigiria baixar e
// decodificar/redimensionar a og:image, e a oni não tem lib nativa de imagem.
// O WhatsApp renderiza o card mesmo só com título + descrição.

import type { FetchLike } from "./media";

export interface LinkPreview {
  /** A URL que casou no texto — vai no `extendedTextMessage.matchedText`. */
  matchedText: string;
  canonicalUrl?: string;
  title?: string;
  description?: string;
}

const URL_RE = /https?:\/\/[^\s<>()]+/i;
const MAX_BYTES = 512 * 1024;

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};
function unescapeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}
function safeCodePoint(n: number): string {
  try {
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

/** `content` de uma `<meta …>` cujo atributo de chave casa com `keyRe`. */
function metaContent(html: string, keyRe: RegExp): string | undefined {
  const tagRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    if (!keyRe.test(tag)) continue;
    const c = /\bcontent\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/i.exec(tag);
    const v = c?.[2] ?? c?.[3] ?? c?.[4];
    if (v) return unescapeHtml(v);
  }
  return undefined;
}

/** Primeira URL de `text`, sem pontuação final grudada. */
export function firstUrl(text: string): string | undefined {
  return URL_RE.exec(text)?.[0]?.replace(/[.,;:!?)\]]+$/, "");
}

/** Busca e monta o preview da 1ª URL de `text`. Devolve `undefined` se não há
 *  URL, não há `fetchImpl`, o GET falha, a resposta não é HTML, ou não deu pra
 *  extrair nem título nem descrição. NUNCA lança. */
export async function fetchLinkPreview(
  text: string,
  fetchImpl: FetchLike | undefined,
): Promise<LinkPreview | undefined> {
  const url = firstUrl(text);
  if (!url || !fetchImpl) return undefined;
  try {
    const res = await fetchImpl(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; oniwalib link preview)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return undefined;
    let html = await res.text();
    if (html.length > MAX_BYTES) html = html.slice(0, MAX_BYTES);
    if (!/<html|<meta|<title/i.test(html)) return undefined;

    const title =
      metaContent(html, /property\s*=\s*["']og:title["']/i) ??
      metaContent(html, /name\s*=\s*["']twitter:title["']/i) ??
      (unescapeHtml(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "") || undefined);
    const description =
      metaContent(html, /property\s*=\s*["']og:description["']/i) ??
      metaContent(html, /name\s*=\s*["']description["']/i) ??
      metaContent(html, /name\s*=\s*["']twitter:description["']/i);
    const canonicalUrl = metaContent(html, /property\s*=\s*["']og:url["']/i) ?? url;

    if (!title && !description) return undefined;
    return { matchedText: url, canonicalUrl, title, description };
  } catch {
    return undefined;
  }
}
