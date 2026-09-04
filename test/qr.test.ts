// QR rendering — the module matrix is a real QR, and the colored render keeps
// the module geometry (a scanner reads it because dark stays dark).

import { qrMatrix, renderQr } from "../src/qr/index";

// `qrMatrix` precisa resolver `qrcode-terminal` de node_modules — o RTS ainda
// não faz isso (UrubuCode/rts#2625). Pula limpo lá.
if (
  typeof (globalThis as any).Bun === "undefined" &&
  typeof (globalThis as any).__rtsFetchText !== "undefined"
) {
  console.log("\noniwalib/qr [rts]  0 pass, 0 fail  (pulado — encoder via node_modules, #2625)");
  (globalThis as any).process?.exit?.(0);
}

let pass = 0;
let fail = 0;
const fails: string[] = [];
const ok = (n: string, c: boolean, d = "") => {
  if (c) pass++;
  else {
    fail++;
    fails.push(n + (d ? ` — ${d}` : ""));
  }
};

// --- matrix is a well-formed QR --------------------------------------
{
  const m = qrMatrix("HELLO");
  ok("matriz quadrada", m.length > 0 && m.every((row) => row.length === m.length));
  const n = m.length;
  ok("tamanho ímpar (versão QR válida)", n % 2 === 1 && n >= 21);

  // finder pattern: 7×7 dark border with a 3×3 dark centre, at each of 3 corners
  const finder = (r0: number, c0: number) => {
    for (let i = 0; i < 7; i++) {
      if (!m[r0]![c0 + i] || !m[r0 + 6]![c0 + i]) return false; // top/bottom edge
      if (!m[r0 + i]![c0] || !m[r0 + i]![c0 + 6]) return false; // left/right edge
    }
    return m[r0 + 3]![c0 + 3] === true; // centre
  };
  ok("finder pattern superior-esquerdo", finder(0, 0));
  ok("finder pattern superior-direito", finder(0, n - 7));
  ok("finder pattern inferior-esquerdo", finder(n - 7, 0));

  // maior string → matriz maior (mais versão)
  const big = qrMatrix("x".repeat(300));
  ok("string maior → matriz maior", big.length > n);
}

// --- render: plain vs colored have the SAME geometry ----------------
{
  const text = "2@abc123def456,ghi,jkl,mno";
  const plain = renderQr(text, { plain: true, margin: 1 });
  const color = renderQr(text, { margin: 1 });

  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  // both use the ▀ half-block; strip color and the dark/light pattern must match
  const cStripped = stripAnsi(color);
  ok("colorido: mesma contagem de linhas", color.split("\n").length === plain.split("\n").length);
  // in the colored render every cell is "▀" (fg=top module, bg=bottom); the
  // geometry lives in the color, so after stripping it's a block of ▀.
  ok("colorido: só meio-blocos após tirar ANSI", /^[▀\n]+$/.test(cStripped));
  ok("colorido (256): tem códigos de cor", /\x1b\[38;5;\d+m/.test(color) && /\x1b\[48;5;\d+m/.test(color));
  const tc = renderQr(text, { colorDepth: "truecolor" });
  ok("truecolor opt-in: códigos 24-bit", /\x1b\[38;2;\d+;\d+;\d+m/.test(tc));

  // plain render: real block art — has full blocks, half blocks and gaps
  ok("plain: usa █ ▀ ▄ e espaço", /█/.test(plain) && /▀/.test(plain) && /▄/.test(plain) && / /.test(plain));
}

// --- color options -------------------------------------------------
{
  const solid = renderQr("test", { color: [10, 20, 30], colorDepth: "truecolor" });
  ok("cor sólida truecolor: usa o RGB dado", solid.includes("\x1b[38;2;10;20;30m"));
  const solid256 = renderQr("test", { color: [255, 0, 0] });
  ok("cor sólida 256: emite índice de paleta", /\x1b\[38;5;\d+m/.test(solid256));

  let called = 0;
  renderQr("test", {
    color: (r, c, size) => {
      called++;
      ok.length; // noop
      return [r % 255, c % 255, size % 255] as [number, number, number];
    },
  });
  ok("cor função: chamada por módulo escuro", called > 0);

  const bgCustom = renderQr("test", { background: [1, 2, 3], colorDepth: "truecolor" });
  ok("background custom aplicado", bgCustom.includes("\x1b[48;2;1;2;3m"));
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).__rtsFetchText !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/qr [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
