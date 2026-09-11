// Logger injetável — a lib nunca deve decidir sozinha, de forma fixa, onde os
// próprios diagnósticos vão parar. Sem isto, `console.log`/`console.error`
// espalhados pelo código poluem o stdout/stderr de QUALQUER app que embuta a
// lib, sem jeito de silenciar, redirecionar pra um logger estruturado (pino,
// winston, …), ou filtrar por nível.
//
//   openWhatsApp({ auth, logger: silentLogger });               // cala tudo
//   openWhatsApp({ auth, logger: { error: meuAlertaDeProdução } }); // só troca 1 nível
//
// `resolveLogger` completa os níveis que faltarem com `consoleLogger` — passar
// `{ error: fn }` troca só `error`; `debug`/`info`/`warn` continuam no console.

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/** O comportamento histórico da lib (antes do logger existir): `debug`/`info`
 *  em `console.log`, `warn` em `console.warn`, `error` em `console.error`.
 *  É o default — quem nunca passou `logger` não percebe diferença nenhuma. */
export const consoleLogger: Logger = {
  // eslint-disable-next-line no-console
  debug: (msg, ...args) => console.log(msg, ...args),
  // eslint-disable-next-line no-console
  info: (msg, ...args) => console.log(msg, ...args),
  // eslint-disable-next-line no-console
  warn: (msg, ...args) => console.warn(msg, ...args),
  // eslint-disable-next-line no-console
  error: (msg, ...args) => console.error(msg, ...args),
};

/** Não imprime nada. Útil quando o app consome `conn.events` pro próprio
 *  logging/alertas e não quer o stdout da lib duplicando informação. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Completa um logger parcial com `consoleLogger` nos níveis que faltarem. */
export function resolveLogger(partial?: Partial<Logger>): Logger {
  if (!partial) return consoleLogger;
  return { ...consoleLogger, ...partial };
}
