// Par de transportes ligados em memória — o que um envia, o outro recebe.
// Para testar o handshake e o loop de nodes sem rede.

import type { Transport } from "./types";

class Endpoint implements Transport {
  open = true;
  private dataHandlers = new Set<(d: Uint8Array) => void>();
  private closeHandlers = new Set<(r?: Error) => void>();
  peer!: Endpoint;

  send(data: Uint8Array): void {
    if (!this.open) throw new Error("transport fechado");
    // Cópia: quem recebe não deve ver mutação posterior do buffer de origem.
    const copy = data.slice();
    queueMicrotask(() => {
      if (this.peer.open) {
        for (const h of this.peer.dataHandlers) h(copy);
      }
    });
  }

  onData(handler: (d: Uint8Array) => void): () => void {
    this.dataHandlers.add(handler);
    return () => this.dataHandlers.delete(handler);
  }

  onClose(handler: (r?: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    for (const h of this.closeHandlers) h();
    if (this.peer.open) this.peer.close();
  }
}

export function mockTransportPair(): [Transport, Transport] {
  const a = new Endpoint();
  const b = new Endpoint();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
