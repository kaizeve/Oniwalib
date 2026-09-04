// The default transport connector: a real `wss://` client that can set the
// `Origin` header WhatsApp's upgrade demands.
//
// Uses the `ws` package when it resolves (node after `npm install`, bun, and
// RTS — where `ws` runs on the engine's `node:net` / `node:tls` and connects
// for real). Falls back to the global `WebSocket` (bun / browser) — that path
// can't set `Origin` on every runtime, so `ws` is preferred.
//
// Handles both event styles: `ws` / node use `.on(event, cb)`; the browser
// `WebSocket` uses `.addEventListener`. Message payloads are normalized to
// `Uint8Array` regardless of `Buffer` / `ArrayBuffer` / string.

import type { ConnectOptions, Connector, Transport } from "./types";

interface WsLike {
  binaryType?: string;
  send(data: Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  on?(event: string, cb: (...args: any[]) => void): void;
  addEventListener?(type: string, cb: (ev: any) => void): void;
  removeAllListeners?(): void;
  readyState?: number;
}
type WsCtor = new (url: string, opts?: unknown) => WsLike;

function toBytes(d: unknown): Uint8Array {
  if (d instanceof Uint8Array) return d;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) {
    const v = d as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  if (Array.isArray(d)) {
    // some ws builds hand back an array of Buffer chunks
    let n = 0;
    for (const c of d) n += (c as Uint8Array).length ?? 0;
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of d) {
      const cu = toBytes(c);
      out.set(cu, o);
      o += cu.length;
    }
    return out;
  }
  if (typeof d === "string") {
    const out = new Uint8Array(d.length);
    for (let i = 0; i < d.length; i++) out[i] = d.charCodeAt(i) & 0xff;
    return out;
  }
  return new Uint8Array(0);
}

async function loadWsCtor(): Promise<WsCtor | undefined> {
  try {
    const mod: any = await import("ws");
    const c = mod?.WebSocket ?? mod?.default ?? mod;
    if (typeof c === "function") return c as WsCtor;
  } catch {
    /* not installed / not shimmed — fall back below */
  }
  const g = (globalThis as { WebSocket?: WsCtor }).WebSocket;
  return typeof g === "function" ? g : undefined;
}

/** Attach a handler to whichever event API the socket exposes. */
function bind(ws: WsLike, event: string, cb: (ev: any) => void): void {
  if (typeof ws.on === "function") ws.on(event, cb);
  else if (typeof ws.addEventListener === "function") ws.addEventListener(event, cb);
}

class WsTransport implements Transport {
  open = false;
  private dataHandlers = new Set<(d: Uint8Array) => void>();
  private closeHandlers = new Set<(r?: Error) => void>();

  constructor(private readonly ws: WsLike) {
    try {
      ws.binaryType = "arraybuffer";
    } catch {
      /* some shims don't allow it */
    }
    bind(ws, "message", (ev: any) => {
      // `.on("message", data)` gives the payload directly; addEventListener
      // gives an event with `.data`.
      const payload = ev && typeof ev === "object" && "data" in ev ? ev.data : ev;
      const bytes = toBytes(payload);
      for (const h of this.dataHandlers) h(bytes);
    });
    bind(ws, "close", (ev: any) => {
      this.open = false;
      const code = typeof ev === "number" ? ev : ev?.code;
      const reason = typeof ev === "object" ? ev?.reason : undefined;
      const err =
        code && code !== 1000
          ? new Error(`websocket fechou ${code}${reason ? ` ${reason}` : ""}`)
          : undefined;
      for (const h of this.closeHandlers) h(err);
    });
    bind(ws, "error", () => {
      /* the following 'close' carries the reason */
    });
  }

  send(data: Uint8Array): void {
    if (!this.open) throw new Error("transport fechado");
    this.ws.send(data);
  }
  onData(h: (d: Uint8Array) => void): () => void {
    this.dataHandlers.add(h);
    return () => this.dataHandlers.delete(h);
  }
  onClose(h: (r?: Error) => void): () => void {
    this.closeHandlers.add(h);
    return () => this.closeHandlers.delete(h);
  }
  close(): void {
    this.open = false;
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/** Build a `Connector` over a specific WebSocket constructor. `wsConnector` is
 *  `makeWsConnector()` — resolves `ws` (or the global) lazily. Passing an
 *  explicit `getCtor` is for tests. */
export function makeWsConnector(
  getCtor: () => Promise<WsCtor | undefined> = loadWsCtor,
): Connector {
  return async (opts: ConnectOptions): Promise<Transport> => connectWith(await getCtor(), opts);
}

async function connectWith(Ctor: WsCtor | undefined, opts: ConnectOptions): Promise<Transport> {
  if (!Ctor) {
    throw new Error(
      "sem cliente WebSocket: instale `ws` (`npm i ws`) ou rode num runtime com `WebSocket` global",
    );
  }

  const headers: Record<string, string> = { ...opts.headers };
  if (opts.origin) headers.Origin = opts.origin;

  // `ws` accepts `{ headers, origin }`; bun's global accepts `{ headers }`; the
  // browser global ignores an options object. Passing it is safe everywhere.
  const ws = new Ctor(opts.url, {
    headers,
    origin: opts.origin,
  }) as WsLike;

  const t = new WsTransport(ws);

  return new Promise<Transport>((resolve, reject) => {
    let settled = false;
    const timer = opts.timeout
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error(`timeout no connect do websocket (${opts.timeout}ms)`));
        }, opts.timeout)
      : undefined;

    bind(ws, "open", () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      t.open = true;
      resolve(t);
    });
    bind(ws, "error", (ev: any) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const msg = ev?.message ?? ev?.error?.message ?? ev?.type ?? "erro no websocket";
      reject(new Error(String(msg)));
    });
  });
}

/** The default `Connector`. Resolves a real `wss://` transport with `Origin` —
 *  uses `ws` when it resolves, else the global `WebSocket`. */
export const wsConnector: Connector = makeWsConnector();
