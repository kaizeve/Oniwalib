// Enquadramento do stream Noise do WhatsApp.
//
// Cada frame no fio é [3 bytes big-endian de tamanho][payload]. O PRIMEIRO
// frame que o cliente manda é precedido de um cabeçalho de introdução:
// `WA` + major + minor  (ex.: 57 41 06 00), opcionalmente com bytes de routing
// info antes.

const WA_MAGIC = Uint8Array.from([0x57, 0x41]); // "WA"

export interface FrameHeaderOpts {
  version?: [number, number];
  routingInfo?: Uint8Array;
}

export function introHeader(opts: FrameHeaderOpts = {}): Uint8Array {
  // WhatsApp: "WA" + 6 + DICT_VERSION (3 no protocolo atual — ver Baileys
  // Defaults.NOISE_WA_HEADER).
  const [major, minor] = opts.version ?? [6, 3];
  const parts: number[] = [];
  if (opts.routingInfo) {
    // ED tag 0xF8 + tamanho, no formato que o edge usa antes do WA magic.
    parts.push(0xed, 0xf0, opts.routingInfo.length >> 8, opts.routingInfo.length & 0xff);
    for (const b of opts.routingInfo) parts.push(b);
  }
  parts.push(WA_MAGIC[0], WA_MAGIC[1], major, minor);
  return Uint8Array.from(parts);
}

export function encodeFrame(payload: Uint8Array): Uint8Array {
  if (payload.length >= 1 << 24) {
    throw new RangeError("frame Noise acima de 16MB");
  }
  const out = new Uint8Array(3 + payload.length);
  out[0] = (payload.length >> 16) & 0xff;
  out[1] = (payload.length >> 8) & 0xff;
  out[2] = payload.length & 0xff;
  out.set(payload, 3);
  return out;
}

// Decodificador de stream: alimenta bytes, tira frames completos. O TCP entrega
// pedaços arbitrários, então isto guarda o resto entre chamadas.
export class FrameDecoder {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    this.buf = concat(this.buf, chunk);
    const frames: Uint8Array[] = [];
    for (;;) {
      if (this.buf.length < 3) break;
      const size = (this.buf[0] << 16) | (this.buf[1] << 8) | this.buf[2];
      if (this.buf.length < 3 + size) break;
      frames.push(this.buf.subarray(3, 3 + size));
      this.buf = this.buf.subarray(3 + size);
    }
    return frames;
  }

  get pending(): number {
    return this.buf.length;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
