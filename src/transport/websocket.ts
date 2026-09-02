// `WebSocketTransport` — `Transport` sobre um WebSocket cliente.
//
// Usa o `WebSocket` global (bun, node 22+, browser). O `Origin` e headers
// custom só entram onde o construtor aceita um 2º argumento `{ headers }` —
// bun e o `ws` do node aceitam; o `WebSocket` do browser não. O WhatsApp exige
// `Origin: https://web.whatsapp.com` no upgrade, então em ambiente sem suporte
// a headers isto não conecta na WA (é a limitação da issue #1; o conector
// nativo do RTS resolve).

import type { ConnectOptions, Transport } from "./types";

type WsCtor = new (url: string, protocolsOrOpts?: unknown) => WebSocketLike;

interface WebSocketLike {
  binaryType: string;
  send(data: Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, cb: (ev: any) => void): void;
  readyState: number;
}

export class WebSocketTransport implements Transport {
  open = false;
  private ws: WebSocketLike;
  private dataHandlers = new Set<(d: Uint8Array) => void>();
  private closeHandlers = new Set<(r?: Error) => void>();

  private constructor(ws: WebSocketLike) {
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (ev: { data: ArrayBuffer | Uint8Array | string }) => {
      const d = ev.data;
      const bytes =
        d instanceof Uint8Array
          ? d
          : d instanceof ArrayBuffer
            ? new Uint8Array(d)
            : new Uint8Array(0);
      for (const h of this.dataHandlers) h(bytes);
    });
    ws.addEventListener("close", (ev: { code?: number; reason?: string }) => {
      this.open = false;
      const err =
        ev.code && ev.code !== 1000
          ? new Error(`websocket fechou ${ev.code}${ev.reason ? ` ${ev.reason}` : ""}`)
          : undefined;
      for (const h of this.closeHandlers) h(err);
    });
    ws.addEventListener("error", () => {
      // o 'close' que segue carrega o motivo
    });
  }

  static connect(opts: ConnectOptions): Promise<WebSocketTransport> {
    const Ctor = (globalThis as { WebSocket?: WsCtor }).WebSocket;
    if (!Ctor) {
      return Promise.reject(new Error("sem WebSocket cliente neste runtime (ver issue #1)"));
    }
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.origin) headers.Origin = opts.origin;

    // bun / ws aceitam `{ headers }`; o browser ignora o 2º arg objeto.
    const ws: WebSocketLike = new Ctor(
      opts.url,
      Object.keys(headers).length ? { headers } : undefined,
    );
    const t = new WebSocketTransport(ws);

    return new Promise((resolve, reject) => {
      const to = opts.timeout
        ? setTimeout(() => reject(new Error("timeout no connect do websocket")), opts.timeout)
        : undefined;
      ws.addEventListener("open", () => {
        if (to) clearTimeout(to);
        t.open = true;
        resolve(t);
      });
      ws.addEventListener("error", (ev: { message?: string }) => {
        if (to) clearTimeout(to);
        reject(new Error("erro no websocket: " + (ev?.message ?? "desconhecido")));
      });
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
      /* já fechado */
    }
  }
}
