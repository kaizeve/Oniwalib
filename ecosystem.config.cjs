// pm2 — mantém o OniBot no ar e SEMPRE na versão atual da lib.
//
//   npm run bot:up        # sobe (roda via bun) e abre os logs
//   npm run bot:restart   # reinício manual
//   npm run bot:down      # derruba
//   npm run bot:logs      # acompanha
//
// `watch` está ligado em src/ e examples/: qualquer alteração no código
// reinicia o processo sozinho. A sessão fica em ./oni-auth/ e é reaproveitada,
// então o bot volta sem QR — é isso que o deixa "atualizado sempre".
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
      watch: ["src", "examples", "oni-version.json"],
      ignore_watch: ["oni-auth", "node_modules", ".git", "test", "scripts", "assets", "logs", "*.log"],
      watch_delay: 2500,

      autorestart: true,
      restart_delay: 3000,
      max_restarts: 50,
      min_uptime: "8s",
      kill_timeout: 8000,

      time: true,
      merge_logs: true,
      out_file: "logs/oni-bot.out.log",
      error_file: "logs/oni-bot.err.log",

      env: { NODE_ENV: "production" },
    },
  ],
};
