// A tomada onde os bytes entram e saem. O núcleo do oniwalib não conhece
// WebSocket, TLS nem socket — só isto. Um `Transport` é full-duplex e binário.
//
// Implementações:
//   - `MockTransport` (memória, pareado) — testes
//   - `WebSocketTransport` — sobre um WebSocket cliente (pendente: headers
//     custom + Origin, que o `WebSocket` global não deixa setar; precisa do
//     `ws` do node ou do `rts-node/src/ws`)

export interface Transport {
  /** Envia um frame de bytes. */
  send(data: Uint8Array): void;
  /** Registra o handler de bytes recebidos. Devolve o cancelador. */
  onData(handler: (data: Uint8Array) => void): () => void;
  /** Registra o handler de fechamento. Devolve o cancelador. */
  onClose(handler: (reason?: Error) => void): () => void;
  /** Fecha a conexão. */
  close(): void;
  /** `true` enquanto dá pra enviar. */
  readonly open: boolean;
}

export interface ConnectOptions {
  url: string;
  headers?: Record<string, string>;
  origin?: string;
  /** ms; rejeita o connect se estourar. */
  timeout?: number;
}

/** Assinatura de um conector de transporte. */
export type Connector = (opts: ConnectOptions) => Promise<Transport>;

/** O endpoint do edge do WhatsApp Web. Runtime export — mantém este módulo
 *  registrável mesmo depois do type-strip (o RTS não registra módulo vazio). */
export const WA_WS_ENDPOINT = "wss://web.whatsapp.com/ws/chat";

/** Origin exigida pelo handshake HTTP do WebSocket do WhatsApp. */
export const WA_WS_ORIGIN = "https://web.whatsapp.com";
