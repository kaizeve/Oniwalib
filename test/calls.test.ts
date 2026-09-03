// Camada de chamadas (src/calls): normaliza `<call>` → WACall e recusa.

import { createCallsLayer, extractCall } from "../src/calls";
import { node, type BinaryNode } from "../src/frame/node";
import { Emitter } from "../src/events/emitter";

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

const FROM = "5511999999999@s.whatsapp.net";

// --- offer de voz -------------------------------------------------
{
  const ev = new Emitter();
  const got: any[] = [];
  ev.on("call", (c) => got.push(...c));
  const sent: BinaryNode[] = [];
  const calls = createCallsLayer({ events: ev, sendNode: (n) => sent.push(n) });

  const stanza = node("call", { from: FROM, id: "CALLID1", t: "1700000000" }, [
    node("offer", { "call-id": "CALLID1", "call-creator": FROM }, [node("audio", {})]),
  ]);
  ok("handleCallNode reconhece", calls.handleCallNode(stanza) === true);
  ok("emitiu 1 call", got.length === 1);
  ok("status offer", got[0]?.status === "offer");
  ok("id", got[0]?.id === "CALLID1");
  ok("from = call-creator", got[0]?.from === FROM);
  ok("chatId = from da stanza", got[0]?.chatId === FROM);
  ok("não é vídeo", got[0]?.isVideo === false);
  ok("date do t", got[0]?.date instanceof Date && got[0].date.getTime() === 1700000000000);
  ok("não é grupo", !got[0]?.isGroup);
}

// --- offer de vídeo em grupo -----------------------------------
{
  const ev = new Emitter();
  const got: any[] = [];
  ev.on("call", (c) => got.push(...c));
  const calls = createCallsLayer({ events: ev, sendNode: () => {} });

  calls.handleCallNode(
    node("call", { from: FROM, id: "C2" }, [
      node("offer", { "call-id": "C2", "call-creator": FROM, "group-jid": "123@g.us" }, [
        node("video", {}),
      ]),
    ]),
  );
  ok("vídeo detectado", got[0]?.isVideo === true);
  ok("grupo detectado", got[0]?.isGroup === true);
  ok("groupJid", got[0]?.groupJid === "123@g.us");
}

// --- terminate por timeout vs normal --------------------------
{
  const t1 = extractCall(
    node("call", { from: FROM }, [node("terminate", { "call-id": "C3", reason: "timeout" })]),
  );
  ok("terminate reason=timeout → status timeout", t1?.status === "timeout");
  const t2 = extractCall(
    node("call", { from: FROM }, [node("terminate", { "call-id": "C3" })]),
  );
  ok("terminate sem reason → status terminate", t2?.status === "terminate");
  const r = extractCall(node("call", { from: FROM }, [node("reject", { "call-id": "C3" })]));
  ok("reject → status reject", r?.status === "reject");
  const a = extractCall(node("call", { from: FROM }, [node("accept", { "call-id": "C3" })]));
  ok("accept → status accept", a?.status === "accept");
}

// --- rejectCall monta o stanza --------------------------------
{
  const sent: BinaryNode[] = [];
  const calls = createCallsLayer({ events: new Emitter(), sendNode: (n) => sent.push(n) });
  calls.rejectCall("CALLID1", FROM);
  ok("mandou <call>", sent[0]?.tag === "call" && sent[0]?.attrs.to === FROM);
  const rej = Array.isArray(sent[0]?.content) ? sent[0]!.content[0] : undefined;
  ok("<reject call-id call-creator count>", (rej as BinaryNode)?.tag === "reject" && (rej as BinaryNode)?.attrs["call-id"] === "CALLID1" && (rej as BinaryNode)?.attrs.count === "0");
}

// --- malformado --------------------------------------------------
{
  const calls = createCallsLayer({ events: new Emitter(), sendNode: () => {} });
  ok("sem from → false", calls.handleCallNode(node("call", {}, [node("offer", {})])) === false);
  ok("sem filho → false", calls.handleCallNode(node("call", { from: FROM })) === false);
}

const rt =
  typeof (globalThis as any).Bun !== "undefined"
    ? "bun"
    : typeof (globalThis as any).RTS !== "undefined"
      ? "rts"
      : "node";
console.log(`\noniwalib/calls [${rt}]  ${pass} pass, ${fail} fail`);
for (const f of fails) console.log("  ✗ " + f);
if (fail > 0) {
  if (typeof process !== "undefined") process.exitCode = 1;
  throw new Error(`${fail} falha(s)`);
}
