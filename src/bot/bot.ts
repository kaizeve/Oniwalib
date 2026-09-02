// OniBot — um roteador de comandos mínimo. Consome mensagens abstratas
// (`{ from, id, text, timestamp? }`) e devolve respostas: uma string de texto,
// ou um `Message` inteiro (botões / lista) para quem sabe enviá-lo.
// Não sabe nada de WhatsApp: os exemplos ligam isto a um NoiseSocket.
//
// Comandos embutidos: !ping, !status, !mem, !uptime, !echo, !buttons, !list,
// !menu, !table, !help. `register()` adiciona os seus.
//
// Um toque em botão/linha chega aqui já como texto (o `messageText` do codec
// devolve o `buttonId` / `rowId`), então dá para usar `!ping` como id de botão
// e o toque cai no mesmo handler do comando digitado.

import type { E2EMessage } from "../proto/e2e-message";
import { Monitor, humanBytes, humanDuration } from "./monitor";

export interface IncomingMessage {
  from: string;
  id: string;
  text: string;
  /** Carimbo do servidor, em segundos unix. Usado pelo `!ping` para a latência. */
  timestamp?: number;
}

/** O que um comando pode devolver: texto puro, ou um `Message` rico. */
export type CommandReply = string | E2EMessage;

export type CommandHandler = (
  args: string,
  msg: IncomingMessage,
) => CommandReply | undefined | Promise<CommandReply | undefined>;

export interface OniBotOptions {
  /** Prefixo dos comandos. Default `!`. */
  prefix?: string;
  /** Nome que aparece no !help / !status. */
  name?: string;
}

export class OniBot {
  private prefix: string;
  private name: string;
  private commands = new Map<string, { handler: CommandHandler; help: string }>();
  private monitor = new Monitor();
  private startedAt = Date.now();

  constructor(opts: OniBotOptions = {}) {
    this.prefix = opts.prefix ?? "!";
    this.name = opts.name ?? "oni";
    this.monitor.prime();
    this.installBuiltins();
  }

  register(name: string, help: string, handler: CommandHandler): this {
    this.commands.set(name.toLowerCase(), { handler, help });
    return this;
  }

  /** Processa uma mensagem. Devolve a resposta, ou `undefined` se não for comando. */
  async handle(msg: IncomingMessage): Promise<CommandReply | undefined> {
    const text = msg.text.trim();
    if (!text.startsWith(this.prefix)) return undefined;
    const sp = text.indexOf(" ");
    const cmd = (sp < 0 ? text.slice(this.prefix.length) : text.slice(this.prefix.length, sp)).toLowerCase();
    const args = sp < 0 ? "" : text.slice(sp + 1).trim();
    const entry = this.commands.get(cmd);
    if (!entry) {
      return `comando desconhecido: ${cmd}. tente ${this.prefix}help`;
    }
    return entry.handler(args, msg);
  }

  get commandNames(): string[] {
    return [...this.commands.keys()];
  }

  private installBuiltins(): void {
    this.register("ping", "responde pong com a latência", (_args, msg) => {
      // Latência real = atraso WhatsApp→bot: `now - carimbo do servidor`. O
      // carimbo tem resolução de 1s (~±1s de folga). Sem carimbo (testes,
      // transportes que não passam `t`) responde só "pong". Se o atraso for
      // grande, a mensagem ficou na fila (bot estava fora) — dizemos isso em
      // vez de cuspir um número gigante.
      if (!msg.timestamp) return "pong";
      const lagMs = Math.max(0, Date.now() - msg.timestamp * 1000);
      if (lagMs > 60_000) return `pong · (essa mensagem esperou ${humanDuration(lagMs / 1000)} na fila)`;
      return `pong · ~${lagMs}ms`;
    });

    this.register("uptime", "há quanto tempo o bot está no ar", () => {
      return `no ar há ${humanDuration((Date.now() - this.startedAt) / 1000)}`;
    });

    this.register("mem", "uso de memória", () => {
      const s = this.monitor.sample();
      return `RAM: ${humanBytes(s.rss)} RSS (+${humanBytes(s.external)} nativo) · sistema ${humanBytes(s.totalmem - s.freemem)}/${humanBytes(s.totalmem)}`;
    });

    this.register("status", "cpu, ram, uptime, sistema", () => {
      const s = this.monitor.sample();
      const cpu = s.cpuPercent === null ? "—" : `${s.cpuPercent}%`;
      return [
        `*${this.name}* · ${s.platform} · ${s.cpus} vCPU`,
        `uptime  ${humanDuration(s.uptime)}`,
        `cpu     ${cpu}   load ${s.load.map((x) => x.toFixed(2)).join(" / ")}`,
        `ram     ${humanBytes(s.rss)} RSS`,
        `sistema ${humanBytes(s.totalmem - s.freemem)} / ${humanBytes(s.totalmem)}`,
      ].join("\n");
    });

    this.register("echo", "repete o texto", (args) => args || "(nada pra repetir)");

    this.register("table", "stats numa tabela monoespaçada", () => {
      const s = this.monitor.sample();
      const table = asciiTable(
        ["métrica", "valor"],
        [
          ["uptime", humanDuration(s.uptime)],
          ["cpu", s.cpuPercent === null ? "—" : `${s.cpuPercent}%`],
          ["load", s.load.map((x) => x.toFixed(2)).join(" / ")],
          ["ram (RSS)", humanBytes(s.rss)],
          ["sistema", `${humanBytes(s.totalmem - s.freemem)} / ${humanBytes(s.totalmem)}`],
        ],
      );
      // ``` faz o WhatsApp renderizar monoespaçado (alinha as colunas).
      return "```\n" + table + "\n```";
    });

    this.register("buttons", "3 botões de resposta rápida (buttonsMessage)", () => ({
      buttonsMessage: {
        contentText: `*${this.name}* · toque um botão`,
        footerText: "oniwalib",
        headerType: 1,
        buttons: [
          { buttonId: `${this.prefix}ping`, buttonText: { displayText: "🏓 ping" }, type: 1 },
          { buttonId: `${this.prefix}status`, buttonText: { displayText: "📊 status" }, type: 1 },
          { buttonId: `${this.prefix}table`, buttonText: { displayText: "📋 table" }, type: 1 },
        ],
      },
    }));

    const listReply = (): E2EMessage => ({
      listMessage: {
        title: `menu do ${this.name}`,
        description: "escolha um comando para rodar",
        buttonText: "abrir menu",
        footerText: "oniwalib",
        listType: 1,
        sections: [
          {
            title: "diagnóstico",
            rows: [
              { title: "🏓 ping", description: "latência", rowId: `${this.prefix}ping` },
              { title: "📊 status", description: "cpu / ram / uptime", rowId: `${this.prefix}status` },
              { title: "📋 table", description: "stats em tabela", rowId: `${this.prefix}table` },
            ],
          },
          {
            title: "outros",
            rows: [{ title: "⏱️ uptime", description: "tempo no ar", rowId: `${this.prefix}uptime` }],
          },
        ],
      },
    });
    this.register("list", "menu selecionável (listMessage)", listReply);
    this.register("menu", "alias de !list", listReply);

    this.register("help", "esta lista", () => {
      const lines = [...this.commands.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([n, e]) => `${this.prefix}${n} — ${e.help}`);
      return `comandos de *${this.name}*:\n` + lines.join("\n");
    });
  }
}

/** Tabela ASCII simples: cabeçalho + linhas, colunas alinhadas à largura máxima. */
export function asciiTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    "│ " + cells.map((c, i) => (c ?? "").padEnd(widths[i]!)).join(" │ ") + " │";
  const rule = (l: string, m: string, r: string) =>
    l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  return [
    rule("┌", "┬", "┐"),
    line(headers),
    rule("├", "┼", "┤"),
    ...rows.map(line),
    rule("└", "┴", "┘"),
  ].join("\n");
}
