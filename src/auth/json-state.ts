// Portable auth persistence — a plain JSON blob, `readFileSync` / `writeFileSync`
// only (no `stat`, no append-log). Works on bun / node / **RTS**, unlike
// `fileAuthState` (which hits a `node:fs` `stat` sequencing edge on the engine).
//
//   // simplest — a file:
//   const auth = jsonFileAuthState("./auth.json");
//   const conn = openWhatsApp({ auth, saveCreds: () => auth.saveCreds() });
//
//   // or bring your own storage (KV, DB, env…):
//   const auth = jsonAuthState(loadStr, saveStr);
//
// The whole state (creds + every Signal key bucket) is rewritten on each
// `saveCreds()` and each `keys.set(...)`. For a bot that's a few KB; fine.
// `Uint8Array` round-trips as `{ __b: <base64> }`, like Baileys' `BufferJSON`.

import { b64, b64decode, initAuthCreds } from "./state";
import type { AuthCreds, AuthenticationState, SignalDataType } from "./state";

type Buckets = Record<string, Record<string, unknown>>;

function replacer(_k: string, v: unknown): unknown {
  if (v instanceof Uint8Array) return { __b: b64(v) };
  const o = v as { type?: string; data?: unknown };
  if (o && o.type === "Buffer" && Array.isArray(o.data)) {
    return { __b: b64(Uint8Array.from(o.data as number[])) };
  }
  return v;
}
function reviver(_k: string, v: unknown): unknown {
  const o = v as { __b?: unknown };
  if (o && typeof o === "object" && typeof o.__b === "string") return b64decode(o.__b);
  return v;
}

export interface JsonAuthState extends AuthenticationState {
  /** The whole state as a JSON string. */
  serialize(): string;
  /** Persist now (calls the `save` you passed). Also runs on every `keys.set`. */
  saveCreds(): void;
}

/** Auth state backed by two callbacks. `load` returns the last JSON blob (or
 *  `undefined` for a fresh state); `save` receives the new blob on every change. */
export function jsonAuthState(
  load?: () => string | undefined | null,
  save?: (json: string) => void,
): JsonAuthState {
  let creds: AuthCreds;
  const store: Buckets = {};

  const raw = load?.();
  if (raw) {
    try {
      const parsed = JSON.parse(raw, reviver) as { creds?: AuthCreds; keys?: Buckets };
      if (parsed.creds) creds = parsed.creds;
      if (parsed.keys) for (const t of Object.keys(parsed.keys)) store[t] = parsed.keys[t]!;
    } catch {
      /* corrompido — começa do zero */
    }
  }
  // @ts-expect-error — atribuído acima quando havia blob; senão cria agora
  if (!creds) creds = initAuthCreds();

  const serialize = (): string =>
    JSON.stringify({ creds, keys: store }, replacer);

  const flush = (): void => {
    try {
      save?.(serialize());
    } catch {
      /* storage indisponível — o próximo flush tenta de novo */
    }
  };

  return {
    get creds() {
      return creds;
    },
    keys: {
      async get(type, ids) {
        const bucket = store[type] ?? {};
        const out: Record<string, unknown> = {};
        for (const id of ids) if (id in bucket) out[id] = bucket[id];
        return out;
      },
      async set(data) {
        for (const type of Object.keys(data) as SignalDataType[]) {
          const incoming = data[type]!;
          const bucket = (store[type] ??= {});
          for (const id of Object.keys(incoming)) {
            const val = incoming[id];
            if (val === undefined || val === null) delete bucket[id];
            else bucket[id] = val;
          }
        }
        flush();
      },
    },
    serialize,
    saveCreds: flush,
  };
}

/** `jsonAuthState` over a single JSON file (`readFileSync` / `writeFileSync`). */
export function jsonFileAuthState(path: string): JsonAuthState {
  // lazy `require` — keeps the module registrable on runtimes without `node:fs`
  // (the browser); RTS / node / bun all have it.
  const fs = (() => {
    try {
      return require("node:fs") as typeof import("node:fs");
    } catch {
      return require("fs") as typeof import("node:fs");
    }
  })();

  return jsonAuthState(
    () => {
      try {
        return fs.readFileSync(path, "utf8");
      } catch {
        return undefined; // não existe ainda
      }
    },
    (json) => {
      fs.writeFileSync(path, json);
    },
  );
}
