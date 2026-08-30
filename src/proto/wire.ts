// Codec protobuf mínimo — varint, length-delimited, fixed32/64.
//
// Substitui o `protobufjs` (pesado) pelos ~4 wire types que o WhatsApp usa de
// fato. Sem geração de código: cada mensagem tem um par encode/decode escrito à
// mão sobre `Writer`/`Reader` (ver `handshake-proto.ts`).
//
// Limite conhecido: varint é lido/escrito como `number`, então um campo acima
// de 2^53 perde precisão. Os campos do WhatsApp que importam aqui — número de
// telefone (~2^40), keyId (2^24), timestamps em segundos — cabem folgado.

export const WIRE = {
  VARINT: 0,
  I64: 1,
  LEN: 2,
  I32: 5,
} as const;

export class Writer {
  private buf: number[] = [];

  private varint(n: number): void {
    let v = n >>> 0 === n ? n : Math.floor(n);
    while (v > 0x7f) {
      this.buf.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    this.buf.push(v & 0x7f);
  }

  private tag(field: number, wire: number): void {
    this.varint((field << 3) | wire);
  }

  uint(field: number, value: number): this {
    if (value === 0) return this;
    this.tag(field, WIRE.VARINT);
    this.varint(value);
    return this;
  }

  bool(field: number, value: boolean): this {
    if (!value) return this;
    this.tag(field, WIRE.VARINT);
    this.buf.push(1);
    return this;
  }

  /** Como `uint`, mas escreve MESMO sendo 0 — para campos `optional` (proto2)
   *  que o WhatsApp espera presentes. */
  uintF(field: number, value: number): this {
    this.tag(field, WIRE.VARINT);
    this.varint(value);
    return this;
  }

  /** Como `bool`, mas escreve `false` explícito. */
  boolF(field: number, value: boolean): this {
    this.tag(field, WIRE.VARINT);
    this.buf.push(value ? 1 : 0);
    return this;
  }

  bytes(field: number, value: Uint8Array | undefined): this {
    if (!value) return this;
    this.tag(field, WIRE.LEN);
    this.varint(value.length);
    for (let i = 0; i < value.length; i++) this.buf.push(value[i]!);
    return this;
  }

  string(field: number, value: string | undefined): this {
    if (value === undefined || value === "") return this;
    return this.bytes(field, utf8(value));
  }

  /** Sub-mensagem: passa um Writer já preenchido. */
  message(field: number, sub: Writer): this {
    return this.bytes(field, sub.finish());
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

export interface Field {
  field: number;
  wire: number;
  /** varint/i32/i64 → number; LEN → Uint8Array */
  value: number | Uint8Array;
}

export class Reader {
  private i = 0;
  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.i >= this.buf.length;
  }

  private varint(): number {
    let shift = 1;
    let result = 0;
    for (;;) {
      const b = this.buf[this.i++]!;
      result += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) break;
      shift *= 128;
    }
    return result;
  }

  next(): Field {
    const key = this.varint();
    const field = key >>> 3;
    const wire = key & 0x7;
    switch (wire) {
      case WIRE.VARINT:
        return { field, wire, value: this.varint() };
      case WIRE.I64: {
        let v = 0;
        for (let k = 0; k < 8; k++) v += this.buf[this.i++]! * 2 ** (8 * k);
        return { field, wire, value: v };
      }
      case WIRE.LEN: {
        const len = this.varint();
        const bytes = this.buf.subarray(this.i, this.i + len);
        this.i += len;
        return { field, wire, value: bytes };
      }
      case WIRE.I32: {
        let v = 0;
        for (let k = 0; k < 4; k++) v += this.buf[this.i++]! * 2 ** (8 * k);
        return { field, wire, value: v };
      }
      default:
        throw new Error(`protobuf: wire type ${wire} não suportado`);
    }
  }

  /** Lê todos os campos num mapa `field → lista de valores` (repetidos incluídos). */
  fields(): Map<number, Array<number | Uint8Array>> {
    const out = new Map<number, Array<number | Uint8Array>>();
    while (!this.done) {
      const f = this.next();
      const list = out.get(f.field) ?? [];
      list.push(f.value);
      out.set(f.field, list);
    }
    return out;
  }
}

function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      c = 0x10000 + ((c & 0x3ff) << 10) + (s.charCodeAt(++i) & 0x3ff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}
