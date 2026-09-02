// LidStore (src/signal/lid.ts): mapa número↔lid + roster de contatos, ambos
// persistidos no `SignalKeyStore`. Usa o store de memória do `memoryAuthState`.

import { makeLidStore } from "../src/signal/lid";
import { memoryAuthState } from "../src/auth/state";

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

const PN = "5533998068399@s.whatsapp.net";
const LID = "199887766554433@lid";

// --- mapa número↔lid ----------------------------------------------------------
{
  const { keys } = memoryAuthState();
  const lid = makeLidStore(keys);

  await lid.remember(PN, LID);
  ok("toPn(lid) → número", (await lid.toPn(LID)) === PN);
  ok("toPn(lid com device) normaliza", (await lid.toPn("199887766554433:7@lid")) === PN);
  ok("toLid(pn) → lid", (await lid.toLid(PN)) === LID);
  ok("toPn(pn) passthrough", (await lid.toPn(PN)) === PN);
  ok("toLid(lid) passthrough", (await lid.toLid(LID)) === LID);
  ok("toPn(lid desconhecido) → undefined", (await lid.toPn("123@lid")) === undefined);

  // lixo não quebra nem grava
  await lid.remember(undefined, LID);
  await lid.remember(PN, undefined);
  await lid.remember(LID, PN); // trocado
  ok("remember com lixo não inventa mapa", (await lid.toPn("123@lid")) === undefined);

  // remember NÃO mexe no roster
  ok("remember não popula roster", (await lid.contacts()).length === 0);
}

// --- roster de contatos -----------------------------------------------------
{
  const { keys } = memoryAuthState();
  const lid = makeLidStore(keys);

  await lid.noteContact(PN);
  await lid.noteContact("5511999999999@s.whatsapp.net");
  await lid.noteContact(PN); // idempotente
  await lid.noteContact("status@broadcast"); // ignora não-pessoa
  await lid.noteContact(undefined);

  const c1 = await lid.contacts();
  ok("roster tem os 2 contatos", c1.length === 2 && c1.includes(PN));
  ok("roster ignora não-pessoa", !c1.some((j) => j.includes("broadcast")));

  // par número/lid colapsa num jid só (número quando conhecido)
  await lid.remember(PN, LID);
  await lid.noteContact(LID); // mesmo humano do PN, via lid
  const c2 = await lid.contacts();
  ok("roster colapsa par número/lid", c2.length === 2 && c2.filter((j) => j === PN).length === 1);
  ok("roster não lista o lid junto do número", !c2.includes(LID));
}

// --- persistência: outra instância sobre o mesmo store enxerga o roster -----
{
  const auth = memoryAuthState();
  const a = makeLidStore(auth.keys);
  await a.noteContact(PN);
  await a.remember(PN, LID);

  const b = makeLidStore(auth.keys); // nova instância, mesmo cofre
  ok("nova instância lê o roster do cofre", (await b.contacts()).includes(PN));
  ok("nova instância lê o mapa do cofre", (await b.toPn(LID)) === PN);
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/lid [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
