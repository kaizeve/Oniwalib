// oni-version — a versão do protocolo WhatsApp Web que o cliente anuncia no
// handshake (`userAgent.appVersion`, o triplo `[2, minor, patch]`).
//
// Por que isto existe: quando o WhatsApp sobe essa versão do lado deles, um
// cliente que ainda manda a versão antiga para de funcionar — o QR não conecta,
// o login é recusado. É o mesmo problema que a Baileys resolve com
// `fetchLatestBaileysVersion`. Aqui: **trocar a oni-version devolve o
// funcionamento**, e dá pra fazer isso sem publicar release nova — basta editar
// `oni-version.json` no repo (todo cliente que chama `resolveOniVersion` pega).
//
// Ordem de resolução:  override → cache → fetch (grava no cache) → embutida

export type OniVersion = [number, number, number];

/** Fallback embutido. Atualizado a cada release; vale quando não há rede nem cache. */
export const DEFAULT_ONI_VERSION: OniVersion = [2, 3000, 1043857760];

/** De onde `fetchLatestOniVersion` tenta ler, em ordem. */
export const DEFAULT_SOURCES = [
  // 1. O JSON que este repo publica. Editar ele = atualizar todo mundo.
  "https://raw.githubusercontent.com/Oberonhosting/Oniwalib/main/oni-version.json",
  // 1b. A version.json da Baileys — autoritativa, atualizada com frequência.
  "https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json",
  // 2. A própria WhatsApp Web — fonte autoritativa, formato menos estável.
  "https://web.whatsapp.com/",
] as const;

export interface VersionStore {
  get(): Promise<OniVersion | undefined>;
  set(v: OniVersion): Promise<void>;
}

export function memoryVersionStore(): VersionStore {
  let held: OniVersion | undefined;
  return {
    async get() {
      return held;
    },
    async set(v) {
      held = v;
    },
  };
}

export interface ResolveOptions {
  /** Se definido, é essa versão e ponto — nem cache nem fetch. */
  override?: OniVersion;
  /** Cache entre execuções. */
  store?: VersionStore;
  /** Tentar buscar a mais nova. Default: `true` se houver `fetch` global. */
  fetch?: boolean;
  /** Endpoints (default: `DEFAULT_SOURCES`). */
  sources?: readonly string[];
}

export interface ResolvedVersion {
  version: OniVersion;
  source: "override" | "cache" | "fetch" | "default";
}

export async function resolveOniVersion(opts: ResolveOptions = {}): Promise<ResolvedVersion> {
  if (opts.override) {
    return { version: normalize(opts.override), source: "override" };
  }

  let cached: OniVersion | undefined;
  try {
    cached = await opts.store?.get();
  } catch {
    /* store quebrado — ignora */
  }
  // No RTS o `fetch` bloqueia o event-loop e falha devagar (3 fontes × ~15s) —
  // isso adia o `openWhatsApp` em ~45s. Pula a busca e usa a embutida
  // (`oni-version.json` mantém a default fresca; um binário nativo carrega a que
  // foi compilada). Force com `{ fetch: true }` se precisar.
  const isRts =
    typeof (globalThis as any).Bun === "undefined" &&
    typeof (globalThis as any).__rtsFetchText !== "undefined";
  const wantFetch =
    opts.fetch ??
    (!isRts && typeof (globalThis as { fetch?: unknown }).fetch === "function");

  if (wantFetch) {
    // NUNCA deixa um `fetch` estourar aqui: no RTS ele pode lançar
    // (`fetch: … falhou` / `String.prototype … on null`) e isso derrubaria o
    // `openWhatsApp` inteiro. Qualquer erro → cai pro cache / embutida.
    let latest: OniVersion | undefined;
    try {
      latest = await fetchLatestOniVersion(opts.sources);
    } catch {
      latest = undefined;
    }
    if (latest) {
      try {
        await opts.store?.set(latest);
      } catch {
        /* ignora */
      }
      return { version: latest, source: "fetch" };
    }
  }

  if (cached) {
    return { version: normalize(cached), source: "cache" };
  }
  return { version: DEFAULT_ONI_VERSION, source: "default" };
}

/** Busca a versão mais nova conhecida. `undefined` se nada respondeu. */
/** ms para desistir de CADA fonte. Sem isto, um `fetch` que pendura (visto no
 *  RTS contra `raw.githubusercontent`) trava a resolução de versão inteira e,
 *  com ela, o `openWhatsApp`. */
const FETCH_TIMEOUT_MS = 6000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fetch timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

export async function fetchLatestOniVersion(
  sources: readonly string[] = DEFAULT_SOURCES,
): Promise<OniVersion | undefined> {
  const f = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof f !== "function") return undefined;

  for (const url of sources) {
    try {
      const res = await withTimeout(
        f(url, { headers: { "user-agent": "oniwalib" } }),
        FETCH_TIMEOUT_MS,
      );
      if (!res.ok) continue;
      const body = await withTimeout(res.text(), FETCH_TIMEOUT_MS);
      const parsed = url.endsWith(".json") ? parseJson(body) : parseWhatsAppWeb(body);
      if (parsed) return parsed;
    } catch {
      // rede/CORS/parse/timeout — tenta a próxima fonte
    }
  }
  return undefined;
}

/** `{ "version": [2, 3000, 123] }` */
function parseJson(body: string): OniVersion | undefined {
  try {
    const v = (JSON.parse(body) as { version?: unknown }).version;
    return Array.isArray(v) && v.length === 3 ? normalize(v as OniVersion) : undefined;
  } catch {
    return undefined;
  }
}

/** Extrai o `client_revision` do HTML/bundle da WhatsApp Web e monta `[2, 3000, rev]`. */
function parseWhatsAppWeb(html: string): OniVersion | undefined {
  const m =
    html.match(/"client_revision"\s*:\s*(\d+)/) ??
    html.match(/client_revision\\?"\s*:\s*(\d+)/);
  if (m) return [2, 3000, Number(m[1])];
  // formato alternativo: l="2.xxxx.yy"
  const l = html.match(/["']2\.(\d{3,})\.(\d+)["']/);
  if (l) return [2, Number(l[1]), Number(l[2])];
  return undefined;
}

function normalize(v: OniVersion): OniVersion {
  return [Number(v[0]) || 2, Number(v[1]) || 0, Number(v[2]) || 0];
}

/** `md5("primary.secondary.tertiary")` — o `buildHash` que vai no `regData`. */
export function versionBuildHash(
  v: OniVersion,
  crypto: { md5?: (b: Uint8Array) => Uint8Array; sha256(b: Uint8Array): Uint8Array },
): Uint8Array {
  const text = `${v[0]}.${v[1]}.${v[2]}`;
  const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
  // Node/Baileys usa md5 aqui. Se o adapter não tem md5, cai no prefixo do
  // sha256 — não é o valor real, mas mantém o campo com 16 bytes até a Fase 2.
  return crypto.md5 ? crypto.md5(bytes) : crypto.sha256(bytes).subarray(0, 16);
}
