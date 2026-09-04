// Terminal QR rendering — including a colorful / RGB variant. A QR reader only
// cares about the LUMINANCE contrast between "dark" and "light" modules, not the
// hue — so the dark modules can be any color as long as they stay dark enough.
// (The "rainbow QR your friend had" works for exactly this reason.)
//
//   import { renderQr } from "oniwalib";
//   conn.events.on("connection.update", (u) => { if (u.qr) console.log(renderQr(u.qr)); });
//
// Uses `qrcode-terminal`'s bundled QR encoder for the module matrix, then draws
// it with half-block characters (two module rows per text line) and ANSI
// truecolor. `plain: true` falls back to a black-and-white render.

type Rgb = [number, number, number];

export interface QrOptions {
  /** `"rainbow"` (hue sweeps across the code — the colorful look), a single
   *  `[r,g,b]` for every dark module, or a `(row, col, size) => [r,g,b]`.
   *  Default `"rainbow"`. */
  color?: "rainbow" | Rgb | ((row: number, col: number, size: number) => Rgb);
  /** Background behind the light modules. Default near-white `[235,235,235]` —
   *  keep it light for contrast. */
  background?: Rgb;
  /** Quiet-zone width in modules (each side). Default 2. Scanners want ≥ 1. */
  margin?: number;
  /** No ANSI color — plain `█`/space blocks. Default `false`. */
  plain?: boolean;
  /** `"256"` (xterm-256, the widest support — the default) or `"truecolor"`
   *  (24-bit `\x1b[38;2;r;g;b`, only on capable terminals). */
  colorDepth?: "256" | "truecolor";
}

/** The QR module matrix for `text`: `m[row][col]` is `true` for a dark module.
 *  Uses `qrcode-terminal`'s bundled encoder — needs `node_modules` resolution,
 *  so on RTS (which can't yet, UrubuCode/rts#2625) this throws; callers should
 *  fall back to printing the raw QR string. */
export function qrMatrix(text: string): boolean[][] {
  let QRCode: new (
    typeNumber: number,
    errorLevel: number,
  ) => { addData(s: string): void; make(): void; getModuleCount(): number; isDark(r: number, c: number): boolean };
  let L: number;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    QRCode = require("qrcode-terminal/vendor/QRCode");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    L = (require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel") as { L: number }).L;
  } catch {
    throw new Error(
      "qrMatrix: não achei o encoder `qrcode-terminal` (resolução de node_modules " +
        "indisponível neste runtime — ex.: RTS). Imprima a string do QR direto.",
    );
  }

  const q = new QRCode(-1, L); // -1 = auto-fit the version to the data
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const out: boolean[][] = [];
  for (let r = 0; r < n; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c++) row.push(q.isDark(r, c));
    out.push(row);
  }
  return out;
}

function hueToRgb(h: number): Rgb {
  // h in [0,1). Full-saturation, ~45% lightness → vivid but still "dark" enough
  // to read against a light background.
  const s = 1;
  const l = 0.45;
  const k = (x: number) => (x + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (x: number) => l - a * Math.max(-1, Math.min(k(x) - 3, Math.min(9 - k(x), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function darkColor(opt: QrOptions["color"], r: number, c: number, size: number): Rgb {
  if (Array.isArray(opt)) return opt;
  if (typeof opt === "function") return opt(r, c, size);
  // "rainbow" (default): hue follows the diagonal, one full sweep across the code
  return hueToRgb(((r + c) / (size * 2)) % 1);
}

const RESET = "\x1b[0m";

/** RGB → nearest xterm-256 palette index (6×6×6 cube + grey ramp). */
function rgbTo256([r, g, b]: Rgb): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round((r - 8) / 247 * 24);
  }
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.round((v - 35) / 40));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

const fgTrue = ([r, g, b]: Rgb) => `\x1b[38;2;${r};${g};${b}m`;
const bgTrue = ([r, g, b]: Rgb) => `\x1b[48;2;${r};${g};${b}m`;
const fg256 = (c: Rgb) => `\x1b[38;5;${rgbTo256(c)}m`;
const bg256 = (c: Rgb) => `\x1b[48;5;${rgbTo256(c)}m`;

/** A QR for `text` as a string of terminal lines. Colorful by default. */
export function renderQr(text: string, opts: QrOptions = {}): string {
  const m = qrMatrix(text);
  const size = m.length;
  const margin = opts.margin ?? 2;
  const light: Rgb = opts.background ?? [235, 235, 235];
  const plain = !!opts.plain;

  const dark = (r: number, c: number): boolean => {
    const rr = r - margin;
    const cc = c - margin;
    if (rr < 0 || cc < 0 || rr >= size || cc >= size) return false; // quiet zone
    return m[rr]![cc]!;
  };

  const total = size + margin * 2;
  const sameRgb = (a: Rgb, b: Rgb) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  const truecolor = opts.colorDepth === "truecolor";
  const fg = truecolor ? fgTrue : fg256;
  const bg = truecolor ? bgTrue : bg256;

  const lines: string[] = [];
  for (let r = 0; r < total; r += 2) {
    if (plain) {
      let line = "";
      for (let c = 0; c < total; c++) {
        const top = dark(r, c);
        const bot = r + 1 < total ? dark(r + 1, c) : false;
        line += top ? (bot ? "█" : "▀") : bot ? "▄" : " ";
      }
      lines.push(line);
      continue;
    }
    // colored: the CHARACTER carries the dark/light pattern (so it still scans
    // if a terminal drops the ANSI codes), the colour carries the hue. Re-emit
    // an SGR only when it changes.
    let line = "";
    let curFg: Rgb | undefined;
    let curBg: Rgb | undefined;
    const setFg = (c: Rgb) => {
      if (!curFg || !sameRgb(curFg, c)) {
        line += fg(c);
        curFg = c;
      }
    };
    const setBg = (c: Rgb) => {
      if (!curBg || !sameRgb(curBg, c)) {
        line += bg(c);
        curBg = c;
      }
    };
    for (let c = 0; c < total; c++) {
      const top = dark(r, c);
      const bot = r + 1 < total ? dark(r + 1, c) : false;
      const topCol: Rgb = top ? darkColor(opts.color, r, c, size) : light;
      const botCol: Rgb = bot ? darkColor(opts.color, r + 1, c, size) : light;
      if (top && bot) {
        setFg(topCol);
        setBg(botCol);
        line += "█"; // full block — reads as dark even with colour stripped
      } else if (top) {
        setFg(topCol);
        setBg(light);
        line += "▀";
      } else if (bot) {
        setFg(botCol);
        setBg(light);
        line += "▄";
      } else {
        setBg(light);
        line += " ";
      }
    }
    lines.push(line + RESET);
  }
  return lines.join("\n");
}

/** Print `renderQr(text, opts)` to stdout (a `console.log` shortcut). */
export function printQr(text: string, opts?: QrOptions): void {
  // eslint-disable-next-line no-console
  console.log("\n" + renderQr(text, opts) + "\n");
}
