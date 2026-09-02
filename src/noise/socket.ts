// NoiseSocket — junta transporte + handshake + WABinary numa conexão.
//
// Fluxo:
//   1. `connect()` manda o cabeçalho de introdução + ClientHello enquadrado,
//      espera o ServerHello, manda o ClientFinish, deriva as chaves de
//      transporte.
//   2. Conectado: `sendNode(node)` cifra e enquadra; cada frame que chega é
//      decifrado, decodificado e emitido em `node.recv`.
//
// A camada de transporte (TLS + WebSocket) e o protobuf do handshake são os
// dois pontos ainda abertos — ver `transport/` e `noise/wire.ts`. O resto
// abaixo é completo e testado sobre `MockTransport`.

import type { Crypto, KeyPair } from "../crypto/types";
import { decodeBinaryNode, type Inflate } from "../frame/decode";
import { encodeBinaryNode } from "../frame/encode";
import type { BinaryNode } from "../frame/node";
import { Emitter } from "../events/emitter";
import { FrameDecoder, encodeFrame, introHeader } from "./frame";
import { NoiseHandshake } from "./handshake";
import { decodeHandshake, encodeHandshake } from "./wire";
import type { Transport } from "../transport/types";

export interface NoiseSocketOptions {
  transport: Transport;
  crypto: Crypto;
  staticKey: KeyPair;
  /** O ClientPayload já serializado (protobuf, quando existir). */
  clientPayload: Uint8Array;
  /** Certificado Noise recebido — validação da cadeia fica a cargo de quem chama. */
  onCertificate?: (cert: Uint8Array, serverStatic: Uint8Array) => void;
  /** Descompressão zlib para frames comprimidos (bit 1 do flag). */
  inflate?: Inflate;
}

export class NoiseSocket {
  readonly events = new Emitter();
  private hs: NoiseHandshake;
  private decoder = new FrameDecoder();
  private ephemeral: KeyPair;
  private connectedResolve?: () => void;
  private connectedReject?: (e: Error) => void;
  private state: "idle" | "handshaking" | "open" | "closed" = "idle";

  private readonly header = introHeader();

  constructor(private readonly opts: NoiseSocketOptions) {
    // O header `WA 6 3` entra no transcript do Noise (prologue).
    this.hs = new NoiseHandshake(opts.crypto, this.header);
    this.ephemeral = opts.crypto.generateX25519();
  }

  get status(): string {
    return this.state;
  }

  connect(): Promise<void> {
    if (this.state !== "idle") {
      return Promise.reject(new Error(`connect() em estado ${this.state}`));
    }
    this.state = "handshaking";
    this.opts.transport.onData((d) => this.onBytes(d));
    this.opts.transport.onClose((r) => this.onClosed(r));

    return new Promise<void>((resolve, reject) => {
      this.connectedResolve = resolve;
      this.connectedReject = reject;

      const hello = this.hs.clientHello(this.ephemeral);
      // O mesmo header que entrou no prologue vai colado no primeiro frame.
      const framed = encodeFrame(encodeHandshake({ clientHello: { ephemeral: hello } }));
      const first = new Uint8Array(this.header.length + framed.length);
      first.set(this.header, 0);
      first.set(framed, this.header.length);
      this.opts.transport.send(first);
    });
  }

  private onBytes(bytes: Uint8Array): void {
    for (const frame of this.decoder.push(bytes)) {
      if (this.state === "handshaking") {
        this.onHandshakeFrame(frame);
      } else if (this.state === "open") {
        this.onTransportFrame(frame);
      }
    }
  }

  private onHandshakeFrame(frame: Uint8Array): void {
    let msg;
    try {
      msg = decodeHandshake(frame);
    } catch (e) {
      return this.fail(e as Error);
    }
    const sh = msg.serverHello;
    if (!sh || !sh.ephemeral || !sh.static || !sh.payload) {
      return this.fail(new Error("handshake: ServerHello malformado"));
    }
    try {
      const { serverStatic, payload } = this.hs.readServerHello(
        this.ephemeral,
        sh.ephemeral,
        sh.static,
        sh.payload,
      );
      this.opts.onCertificate?.(payload, serverStatic);

      const fin = this.hs.clientFinish(this.opts.staticKey, sh.ephemeral, this.opts.clientPayload);
      const out = encodeFrame(
        encodeHandshake({
          clientFinish: { static: fin.staticCipher, payload: fin.payloadCipher },
        }),
      );
      this.opts.transport.send(out);

      this.hs.finish();
      this.state = "open";
      this.connectedResolve?.();
      this.events.emit("connection.update", { connection: "open" });
    } catch (e) {
      this.fail(e as Error);
    }
  }

  private onTransportFrame(frame: Uint8Array): void {
    try {
      const plain = this.hs.transportDecrypt(frame);
      const node = decodeBinaryNode(plain, this.opts.inflate);
      this.events.emit("node.recv", node);
    } catch (e) {
      this.fail(e as Error);
    }
  }

  /** Cifra e enquadra um binary node. Só depois de `connect()` resolver. */
  sendNode(node: BinaryNode): void {
    if (this.state !== "open") throw new Error(`sendNode em estado ${this.state}`);
    const framed = encodeFrame(this.hs.transportEncrypt(encodeBinaryNode(node)));
    this.opts.transport.send(framed);
    this.events.emit("node.send", node);
  }

  close(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.opts.transport.close();
    this.events.emit("connection.update", { connection: "close" });
  }

  private onClosed(reason?: Error): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.connectedReject?.(reason ?? new Error("transporte fechou"));
    this.events.emit("connection.update", {
      connection: "close",
      lastDisconnect: reason ? { error: reason, date: new Date() } : undefined,
    });
  }

  private fail(error: Error): void {
    this.connectedReject?.(error);
    this.close();
  }
}
