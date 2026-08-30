// pm2 — mantém o OniBot no ar e SEMPRE na versão atual da lib.
//
//   npm run bot:up          # sobe com watch (recarrega ao salvar código)
//   npm run bot:up:stable    # sobe SEM watch (pra hackear vários arquivos)
//   npm run bot:restart      # reinício manual
//   npm run bot:down         # derruba
//   npm run bot:logs         # acompanha
//
// `watch` observa SÓ `src/` e `examples/` (nunca `oni-auth/`, que o bot
// reescreve a cada reconexão). Salvou um `.ts` → recarrega, reaproveitando a
// sessão em `./oni-auth/` (sem QR). Editar MUITOS arquivos seguidos derruba e
// sobe o bot toda hora — nesse caso use `bot:up:stable` e depois `bot:restart`.
// PM2_BOT_WATCH=off também desliga o watch.
//
// pm2 não é dependência do projeto; `npx pm2 …` baixa sob demanda. Precisa de
// uma sessão já pareada (rode `npm run bot` uma vez e escaneie o QR).

const { existsSync } = require("node:fs");
const { join } = require("node:path");

// bun costuma não estar no PATH do daemon do pm2 — resolve o binário aqui.
const BUN =
  process.env.PM2_BUN ||
  [join(process.env.HOME || "/root", ".bun/bin/bun"), "/usr/local/bin/bun", "bun"].find(
    (p) => p === "bun" || existsSync(p),
  );

module.exports = {
  apps: [
    {
      name: "oni-bot",
      script: "examples/connect-bot.ts",
      interpreter: BUN,
      cwd: __dirname,

      // Recarrega quando o CÓDIGO muda. `oni-auth/` fica de fora (o bot
      // reescreve as credenciais a cada reconexão — se entrasse aqui, loop).
      watch: process.env.PM2_BOT_WATCH === "off" ? false : ["src", "examples", "oni-version.json"],
      ignore_watch: [
        "oni-auth",
        "node_modules",
        "\\.git",
        "test",
        "scripts",
        "assets",
        "logs",
        "\\.log$",
        "\\.owl",
      ],
      watch_delay: 4000,

      autorestart: true,
      restart_delay: 3000,
      max_restarts: 100,
      min_uptime: "15s",
      kill_timeout: 8000,

      time: true,
      merge_logs: true,
      out_file: "logs/oni-bot.out.log",
      error_file: "logs/oni-bot.err.log",

      env: { NODE_ENV: "production" },
    },
  ],
};
