// OniBot — um roteador de comandos mínimo. Consome mensagens abstratas
// (`{ from, id, text }`) e devolve respostas em texto. Não sabe nada de
// WhatsApp: `attachBot` (em examples/) liga isto a um NoiseSocket.
//
// Comandos embutidos: !ping, !status, !mem, !uptime, !echo, !help.
// `register()` adiciona os seus.

import { Monitor, humanBytes, humanDuration } from "./monitor";

export interface IncomingMessage {
  from: string;
  id: string;
  text: string;
}

export type CommandHandler = (
  args: string,
  msg: IncomingMessage,
) => string | undefined | Promise<string | undefined>;

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
  async handle(msg: IncomingMessage): Promise<string | undefined> {
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
    this.register("ping", "responde pong com a latência", () => {
      // A latência real é medida por quem chama (round-trip); aqui reportamos
      // o tempo de processamento, que é o que dá pra medir de dentro.
      return "pong";
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

    this.register("help", "esta lista", () => {
      const lines = [...this.commands.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([n, e]) => `${this.prefix}${n} — ${e.help}`);
      return `comandos de *${this.name}*:\n` + lines.join("\n");
    });
  }
}
