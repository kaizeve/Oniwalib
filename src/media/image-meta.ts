// Metadados de mídia lidos DIRETO do cabeçalho do arquivo — sem decodificar o
// bitmap, sem dependência nativa (a oni não puxa `sharp`/`jimp`/`ffprobe`). Serve
// para o `buildImageMessage`/`buildVideoMessage` preencherem `width`/`height`
// sozinhos quando o chamador não passou — sem isso o WhatsApp mostra um quadrado
// padrão e a mídia "pula" ao terminar de baixar.
//
// Imagem: JPEG, PNG, GIF e WebP. Vídeo: MP4/MOV (box `tkhd` do ISO-BMFF).

export interface ImageSize {
  width: number;
  height: number;
}

const be16 = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;
const be32 = (b: Uint8Array, o: number) =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const le16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const le32 = (b: Uint8Array, o: number) =>
  (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const ascii = (b: Uint8Array, o: number, n: number) =>
  String.fromCharCode(...b.subarray(o, o + n));

/** `{ width, height }` a partir dos bytes de uma imagem, ou `undefined` se o
 *  formato não for reconhecido / o cabeçalho estiver truncado. */
export function imageDimensions(b: Uint8Array): ImageSize | undefined {
  if (b.length < 24) return undefined;

  // --- PNG: assinatura + IHDR (largura/altura BE nos bytes 16..24) ---
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const width = be32(b, 16);
    const height = be32(b, 20);
    return width && height ? { width, height } : undefined;
  }

  // --- GIF: "GIF87a"/"GIF89a" + largura/altura LE nos bytes 6..10 ---
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    const width = le16(b, 6);
    const height = le16(b, 8);
    return width && height ? { width, height } : undefined;
  }

  // --- WebP: RIFF....WEBP + chunk VP8 / VP8L / VP8X ---
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const fourcc = ascii(b, 12, 4);
    if (fourcc === "VP8 " && b.length >= 30) {
      // frame tag (3B) + start code 0x9d 0x01 0x2a, depois 14 bits w / 14 bits h
      const width = le16(b, 26) & 0x3fff;
      const height = le16(b, 28) & 0x3fff;
      return width && height ? { width, height } : undefined;
    }
    if (fourcc === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
      const bits = le32(b, 21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { width, height };
    }
    if (fourcc === "VP8X" && b.length >= 30) {
      const width = (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1;
      const height = (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1;
      return { width, height };
    }
    return undefined;
  }

  // --- JPEG: varre os segmentos até um marcador SOF (0xFFC0..0xFFCF,
  //     exceto DHT 0xC4, JPG 0xC8, DAC 0xCC), lê altura e largura ---
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = b[o + 1]!;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2;
        continue;
      }
      const len = be16(b, o + 2);
      if (len < 2) return undefined;
      const isSOF =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        const height = be16(b, o + 5);
        const width = be16(b, o + 7);
        return width && height ? { width, height } : undefined;
      }
      o += 2 + len;
    }
    return undefined;
  }

  return undefined;
}

/** `{ width, height }` de um MP4/MOV lendo o box `tkhd` da primeira trilha com
 *  dimensão não-nula (as de vídeo; áudio vem 0×0). `undefined` se não achar. */
export function mp4Dimensions(b: Uint8Array): ImageSize | undefined {
  // Anda pelos boxes de [start, end); desce em `moov`/`trak`; lê `tkhd`.
  const walk = (start: number, end: number): ImageSize | undefined => {
    let o = start;
    while (o + 8 <= end) {
      let size = be32(b, o);
      const type = ascii(b, o + 4, 4);
      let head = 8;
      if (size === 1) {
        // 64-bit — só o low32 nos interessa (nenhum box de header passa de 4 GiB)
        if (o + 16 > end) return undefined;
        size = be32(b, o + 12);
        head = 16;
      }
      if (size < head || o + size > end) return undefined;

      if (type === "moov" || type === "trak" || type === "mdia") {
        const hit = walk(o + head, o + size);
        if (hit) return hit;
      } else if (type === "tkhd") {
        const p = o + head; // início do payload
        const version = b[p]!;
        const dimOff = p + 4 + (version === 1 ? 32 : 20) + 8 + 8 + 36;
        if (dimOff + 8 <= o + size) {
          const width = be32(b, dimOff) >>> 16; // 16.16 fixed → parte inteira
          const height = be32(b, dimOff + 4) >>> 16;
          if (width && height) return { width, height };
        }
      }
      o += size;
    }
    return undefined;
  };
  return b.length >= 16 ? walk(0, b.length) : undefined;
}
