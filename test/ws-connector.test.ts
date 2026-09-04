// wsConnector — a fake `ws`-shaped socket exercises both event styles
// (`.on(...)` and `.addEventListener`), payload normalization, and the
// open/error/close/timeout plumbing. No network: `makeWsConnector` takes an
// explicit constructor.

import { makeWsConnector } from "../src/transport/ws-connector";

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
const eqBytes = (a: Uint8Array, b: number[]) =>
  a.length === b.length && b.every((x, i) => a[i] === x);
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

let inst: FakeWs | undefined;

// EventEmitter-style fake (`.on(event, cb)`), like `ws` / node.
class FakeWs {
  static lastUrl = "";
  static lastOpts: any;
  binaryType = "";
  sent: Uint8Array[] = [];
  private ls: Record<string, Array<(...a: any[]) => void>> = {};
  constructor(url: string, opts?: any) {
    FakeWs.lastUrl = url;
    FakeWs.lastOpts = opts;
    inst = this;
  }
  on(ev: string, cb: (...a: any[]) => void) {
    (this.ls[ev] ??= []).push(cb);
  }
  emit(ev: string, ...args: any[]) {
    for (const cb of this.ls[ev] ?? []) cb(...args);
  }
  send(d: Uint8Array) {
    this.sent.push(d);
  }
  close() {
    this.emit("close", 1000);
  }
}
const connector = makeWsConnector(async () => FakeWs as any);

// --- happy path: url/headers, open, message normalization, send, close ---
{
  inst = undefined;
  const p = connector({ url: "wss://wa/chat", origin: "https://web.whatsapp.com", timeout: 500 });
  await tick();
  ok("passa a url", FakeWs.lastUrl === "wss://wa/chat");
  ok("Origin nos headers", FakeWs.lastOpts?.headers?.Origin === "https://web.whatsapp.com");
  ok("origin no options", FakeWs.lastOpts?.origin === "https://web.whatsapp.com");

  inst!.emit("open");
  const t = await p;
  ok("resolve com transport aberto", t.open === true);

  const chunks: Uint8Array[] = [];
  t.onData((d) => chunks.push(d));
  inst!.emit("message", new Uint8Array([1, 2, 3]).buffer); // ArrayBuffer
  inst!.emit("message", new Uint8Array([9, 8])); // Uint8Array
  inst!.emit("message", "AB"); // string
  ok("ArrayBuffer → bytes", eqBytes(chunks[0]!, [1, 2, 3]));
  ok("Uint8Array passa direto", eqBytes(chunks[1]!, [9, 8]));
  ok("string → charCodes", eqBytes(chunks[2]!, [65, 66]));

  t.send(new Uint8Array([7, 7]));
  ok("send encaminha", eqBytes(inst!.sent[0]!, [7, 7]));

  let closeErr: Error | undefined = "x" as never;
  t.onClose((e) => (closeErr = e));
  inst!.emit("close", 1000);
  ok("close 1000 → sem erro", closeErr === undefined);
  ok("open=false após close", t.open === false);
  let threw = false;
  try {
    t.send(new Uint8Array([1]));
  } catch {
    threw = true;
  }
  ok("send após close lança", threw);
}

// --- close com código de erro vira Error ------------------------------
{
  inst = undefined;
  const p = connector({ url: "wss://wa/chat", timeout: 500 });
  await tick();
  inst!.emit("open");
  const t = await p;
  let err: Error | undefined;
  t.onClose((e) => (err = e));
  inst!.emit("close", 1006, "abnormal");
  ok("close 1006 → Error com o código", !!err && /1006/.test(err!.message));
}

// --- error antes do open → rejeita ----------------------------------
{
  inst = undefined;
  const p = connector({ url: "wss://wa/chat", timeout: 500 });
  await tick();
  inst!.emit("error", { message: "ECONNREFUSED" });
  let msg = "";
  try {
    await p;
  } catch (e) {
    msg = (e as Error).message;
  }
  ok("rejeita no error pré-open", msg.includes("ECONNREFUSED"));
}

// --- timeout -------------------------------------------------------
{
  inst = undefined;
  const p = connector({ url: "wss://wa/chat", timeout: 40 });
  await tick();
  let msg = "";
  try {
    await p;
  } catch (e) {
    msg = (e as Error).message;
  }
  ok("timeout rejeita citando a duração", /timeout/i.test(msg) && msg.includes("40"));
}

// --- sem construtor de WebSocket → erro claro ----------------------
{
  const none = makeWsConnector(async () => undefined);
  let msg = "";
  try {
    await none({ url: "wss://x" });
  } catch (e) {
    msg = (e as Error).message;
  }
  ok("sem WebSocket → mensagem sobre instalar `ws`", /ws/.test(msg) && /WebSocket/.test(msg));
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).__rtsFetchText !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/ws-connector [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
