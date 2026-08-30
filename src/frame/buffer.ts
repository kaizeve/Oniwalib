// Leitura/escrita de bytes para o WABinary. Big-endian, como o protocolo.
//
// O WhatsApp não usa varint aqui: inteiros são de largura fixa (8/16/20/32 bits)
// e o tamanho é escolhido pela TAG que precede o valor. Por isso `BufferReader`
// expõe `readUint(n)` em vez de um `readVarint` genérico.

export class BufferReader {
  private i = 0;
  constructor(private readonly buf: Uint8Array) {}

  get offset(): number {
    return this.i;
  }

  get remaining(): number {
    return this.buf.length - this.i;
  }

  private need(n: number): void {
    if (this.i + n > this.buf.length) {
      throw new RangeError(
        `WABinary: leitura além do fim (${this.i}+${n} > ${this.buf.length})`,
      );
    }
  }

  readByte(): number {
    this.need(1);
    return this.buf[this.i++];
  }

  readUint(n: number): number {
    this.need(n);
    let v = 0;
    for (let k = 0; k < n; k++) {
      v = (v << 8) | this.buf[this.i++];
    }
    // `<<` opera em int32 com sinal; para 4 bytes força não-negativo.
    return v >>> 0;
  }

  // Inteiro de 20 bits: 1 byte com os 4 bits altos + 2 bytes baixos.
  readUint20(): number {
    this.need(3);
    const a = this.buf[this.i++] & 0x0f;
    const b = this.buf[this.i++];
    const c = this.buf[this.i++];
    return (a << 16) | (b << 8) | c;
  }

  readBytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.subarray(this.i, this.i + n);
    this.i += n;
    return out;
  }

  readUtf8(n: number): string {
    return utf8Decode(this.readBytes(n));
  }
}

export class BufferWriter {
  private parts: number[] = [];

  get length(): number {
    return this.parts.length;
  }

  writeByte(b: number): void {
    this.parts.push(b & 0xff);
  }

  writeUint(v: number, n: number): void {
    for (let k = n - 1; k >= 0; k--) {
      this.parts.push((v >>> (8 * k)) & 0xff);
    }
  }

  writeUint20(v: number): void {
    this.parts.push((v >>> 16) & 0x0f);
    this.parts.push((v >>> 8) & 0xff);
    this.parts.push(v & 0xff);
  }

  writeBytes(bytes: Uint8Array): void {
    for (let k = 0; k < bytes.length; k++) {
      this.parts.push(bytes[k]);
    }
  }

  writeUtf8(s: string): void {
    this.writeBytes(utf8Encode(s));
  }

  toBuffer(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

// UTF-8 sem depender de TextEncoder/TextDecoder — o RTS ainda está fechando
// cobertura desses, e o codec não pode depender de um global que pode faltar.
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let k = 0; k < s.length; k++) {
    let c = s.charCodeAt(k);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && k + 1 < s.length) {
      const lo = s.charCodeAt(++k);
      c = 0x10000 + ((c & 0x3ff) << 10) + (lo & 0x3ff);
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

export function utf8Decode(bytes: Uint8Array): string {
  let s = "";
  let k = 0;
  while (k < bytes.length) {
    const b = bytes[k++];
    if (b < 0x80) {
      s += String.fromCharCode(b);
    } else if (b >= 0xc0 && b < 0xe0) {
      s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[k++] & 0x3f));
    } else if (b >= 0xe0 && b < 0xf0) {
      s += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[k++] & 0x3f) << 6) | (bytes[k++] & 0x3f),
      );
    } else {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[k++] & 0x3f) << 12) |
        ((bytes[k++] & 0x3f) << 6) |
        (bytes[k++] & 0x3f);
      const u = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff));
    }
  }
  return s;
}
