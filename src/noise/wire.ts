// `HandshakeMessage` — o protobuf que vai dentro dos frames do handshake Noise.
//
// Campos reais do WAProto:
//   HandshakeMessage { ClientHello clientHello = 2; ServerHello serverHello = 3;
//                      ClientFinish clientFinish = 4; }
//   ClientHello / ServerHello { bytes ephemeral = 1; bytes static = 2; bytes payload = 3; }
//   ClientFinish              { bytes static = 1; bytes payload = 2; }
//
// Sobre o codec `proto/wire.ts` (varint + length-delimited), não sobre
// protobufjs.

import { Reader, Writer } from "../proto/wire";

export interface Hello {
  ephemeral?: Uint8Array;
  static?: Uint8Array;
  payload?: Uint8Array;
}

export interface ClientFinish {
  static?: Uint8Array;
  payload?: Uint8Array;
}

export interface HandshakeMessage {
  clientHello?: Hello;
  serverHello?: Hello;
  clientFinish?: ClientFinish;
}

function encHello(h: Hello): Writer {
  return new Writer().bytes(1, h.ephemeral).bytes(2, h.static).bytes(3, h.payload);
}

function decHello(bytes: Uint8Array): Hello {
  const f = new Reader(bytes).fields();
  return {
    ephemeral: f.get(1)?.[0] as Uint8Array | undefined,
    static: f.get(2)?.[0] as Uint8Array | undefined,
    payload: f.get(3)?.[0] as Uint8Array | undefined,
  };
}

export function encodeHandshake(m: HandshakeMessage): Uint8Array {
  const w = new Writer();
  if (m.clientHello) w.message(2, encHello(m.clientHello));
  if (m.serverHello) w.message(3, encHello(m.serverHello));
  if (m.clientFinish) {
    w.message(
      4,
      new Writer().bytes(1, m.clientFinish.static).bytes(2, m.clientFinish.payload),
    );
  }
  return w.finish();
}

export function decodeHandshake(bytes: Uint8Array): HandshakeMessage {
  const f = new Reader(bytes).fields();
  const out: HandshakeMessage = {};
  const ch = f.get(2)?.[0];
  const sh = f.get(3)?.[0];
  const cf = f.get(4)?.[0];
  if (ch instanceof Uint8Array) out.clientHello = decHello(ch);
  if (sh instanceof Uint8Array) out.serverHello = decHello(sh);
  if (cf instanceof Uint8Array) {
    const cff = new Reader(cf).fields();
    out.clientFinish = {
      static: cff.get(1)?.[0] as Uint8Array | undefined,
      payload: cff.get(2)?.[0] as Uint8Array | undefined,
    };
  }
  return out;
}
