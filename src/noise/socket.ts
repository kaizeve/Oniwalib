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
import { decodeBinaryNode } from "../frame/decode";
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
}

export class NoiseSocket {
  readonly events = new Emitter();
  private hs: NoiseHandshake;
  private decoder = new FrameDecoder();
  private ephemeral: KeyPair;
  private connectedResolve?: () => void;
  private connectedReject?: (e: Error) => void;
  private state: "idle" | "handshaking" | "open" | "closed" = "idle";

  constructor(private readonly opts: NoiseSocketOptions) {
    this.hs = new NoiseHandshake(opts.crypto);
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
      // Intro header vai colado no primeiro frame.
      const framed = encodeFrame(encodeHandshake({ kind: "clientHello", fields: [hello] }));
      const first = new Uint8Array(introHeader().length + framed.length);
      first.set(introHeader(), 0);
      first.set(framed, introHeader().length);
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
    if (msg.kind !== "serverHello" || msg.fields.length < 3) {
      return this.fail(new Error("handshake: ServerHello malformado"));
    }
    const [serverEph, serverStaticCipher, payloadCipher] = msg.fields;
    try {
      const { serverStatic, payload } = this.hs.readServerHello(
        this.ephemeral,
        serverEph!,
        serverStaticCipher!,
        payloadCipher!,
      );
      this.opts.onCertificate?.(payload, serverStatic);

      const fin = this.hs.clientFinish(this.opts.staticKey, serverEph!, this.opts.clientPayload);
      const out = encodeFrame(
        encodeHandshake({ kind: "clientFinish", fields: [fin.staticCipher, fin.payloadCipher] }),
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
      const node = decodeBinaryNode(plain);
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
