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

/** O que um comando pode devolver: texto puro, um `Message` rico, ou uma lista
 *  deles (mandados em ordem — ex.: menu em texto + o mesmo menu em botões). */
export type CommandReply = string | E2EMessage;
export type CommandResult = CommandReply | CommandReply[];

export type CommandHandler = (
  args: string,
  msg: IncomingMessage,
) => CommandResult | undefined | Promise<CommandResult | undefined>;

/** `[id, rótulo, descrição]` de uma linha de menu. O `id` já vem com prefixo. */
type MenuRow = [id: string, label: string, desc: string];

const MENU_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

/** "2" ou "2️⃣" → 2; qualquer outra coisa → undefined. */
function menuIndex(text: string): number | undefined {
  const t = text.trim();
  if (/^[1-9]$/.test(t) || t === "10") return Number(t);
  const e = MENU_EMOJI.indexOf(t);
  return e >= 0 ? e + 1 : undefined;
}

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
  /** Comandos (sem prefixo) do último menu mostrado em cada chat — a resposta
   *  "2" cai no comando da 2ª linha. */
  private lastMenu = new Map<string, string[]>();

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
  async handle(msg: IncomingMessage): Promise<CommandResult | undefined> {
    const text = msg.text.trim();

    // Resposta a um menu de texto ("2" / "2️⃣") → o comando daquela linha.
    const pick = menuIndex(text);
    if (pick !== undefined) {
      const cmd = this.lastMenu.get(msg.from)?.[pick - 1];
      if (cmd) return this.dispatch(cmd, "", msg);
    }

    if (!text.startsWith(this.prefix)) return undefined;
    const sp = text.indexOf(" ");
    const cmd = (sp < 0 ? text.slice(this.prefix.length) : text.slice(this.prefix.length, sp)).toLowerCase();
    const args = sp < 0 ? "" : text.slice(sp + 1).trim();
    return this.dispatch(cmd, args, msg);
  }

  private async dispatch(
    cmd: string,
    args: string,
    msg: IncomingMessage,
  ): Promise<CommandResult | undefined> {
    const entry = this.commands.get(cmd);
    if (!entry) return `comando desconhecido: ${cmd}. tente ${this.prefix}help`;
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

    // buttonsMessage/listMessage legados o WhatsApp não renderiza mais de cliente
    // não-oficial, e o native flow (interactiveMessage) some inteiro em muitas
    // contas. Então mandamos SEMPRE dois: (1) o menu em texto puro — renderiza
    // em qualquer cliente, e a resposta "2" roda o comando da 2ª linha; (2) o
    // mesmo menu como botões, pra contas/versões onde ainda desenha.
    const diagRows: MenuRow[] = [
      [`${this.prefix}ping`, "🏓 ping", "latência"],
      [`${this.prefix}status`, "📊 status", "cpu / ram / uptime"],
      [`${this.prefix}table`, "📋 table", "stats em tabela"],
    ];

    this.register("buttons", "menu de comandos (botões + texto)", (_args, msg) => {
      this.rememberMenu(msg, diagRows);
      return [
        this.textMenu(`*${this.name}* · escolha um comando`, diagRows),
        this.quickReplies(
          `*${this.name}* · toque um botão`,
          diagRows.map(([id, label]) => [label, id]),
        ),
      ];
    });

    const listSections: Array<{ title: string; rows: MenuRow[] }> = [
      { title: "diagnóstico", rows: diagRows },
      { title: "outros", rows: [[`${this.prefix}uptime`, "⏱️ uptime", "tempo no ar"]] },
    ];
    const listReply: CommandHandler = (_args, msg) => {
      const flat = listSections.reduce<MenuRow[]>((acc, s) => acc.concat(s.rows), []);
      this.rememberMenu(msg, flat);
      return [
        this.textMenu(`menu do ${this.name} — escolha um comando`, flat),
        this.singleSelect(`menu do ${this.name}`, "abrir menu", listSections),
      ];
    };
    this.register("list", "menu selecionável (lista + texto)", listReply);
    this.register("menu", "alias de !list", listReply);

    this.register("help", "esta lista", () => {
      const lines = [...this.commands.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([n, e]) => `${this.prefix}${n} — ${e.help}`);
      return `comandos de *${this.name}*:\n` + lines.join("\n");
    });
  }

  // O WhatsApp parou de desenhar `buttonsMessage`/`listMessage` legados vindos
  // de cliente não-oficial. O caminho que ainda renderiza é `interactiveMessage`
  // + `nativeFlowMessage`, embrulhado em `viewOnceMessage` com um
  // `messageContextInfo` (deviceListMetadataVersion 2). O toque volta como
  // `interactiveResponseMessage` e o `messageText` do codec extrai o `id`
  // — que a gente põe como `!comando`, então cai no mesmo handler do texto.
  private interactiveViewOnce(body: string, buttons: Array<{ name: string; params: unknown }>): E2EMessage {
    return {
      viewOnceMessage: {
        message: {
          messageContextInfo: { deviceListMetadataVersion: 2 },
          interactiveMessage: {
            body: { text: body },
            footer: { text: "oniwalib" },
            nativeFlowMessage: {
              buttons: buttons.map((b) => ({
                name: b.name,
                buttonParamsJson: JSON.stringify(b.params),
              })),
            },
          },
        },
      },
    };
  }

  /** N botões de resposta rápida. `buttons` = `[rótulo, id]`. */
  private quickReplies(body: string, buttons: Array<[label: string, id: string]>): E2EMessage {
    return this.interactiveViewOnce(
      body,
      buttons.map(([display_text, id]) => ({
        name: "quick_reply",
        params: { display_text, id },
      })),
    );
  }

  /** Menu de seleção única. `sections[].rows` = `[id, título, descrição]`. */
  private singleSelect(
    body: string,
    buttonLabel: string,
    sections: Array<{ title: string; rows: Array<[id: string, title: string, description: string]> }>,
  ): E2EMessage {
    return this.interactiveViewOnce(body, [
      {
        name: "single_select",
        params: {
          title: buttonLabel,
          sections: sections.map((s) => ({
            title: s.title,
            rows: s.rows.map(([id, title, description]) => ({ header: "", title, description, id })),
          })),
        },
      },
    ]);
  }

  /** Menu numerado em texto puro — renderiza em qualquer cliente. */
  private textMenu(header: string, rows: MenuRow[]): string {
    const body = rows
      .map(([id, , desc], i) => `${MENU_EMOJI[i] ?? `${i + 1}.`}  ${id} — ${desc}`)
      .join("\n");
    return `${header}\n\n${body}\n\nresponda com o número ou digite o comando`;
  }

  /** Guarda os comandos (sem prefixo) do último menu mostrado nesse chat. */
  private rememberMenu(msg: IncomingMessage, rows: MenuRow[]): void {
    if (this.lastMenu.size > 500) this.lastMenu.clear(); // teto simples
    this.lastMenu.set(
      msg.from,
      rows.map(([id]) => id.slice(this.prefix.length)),
    );
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
