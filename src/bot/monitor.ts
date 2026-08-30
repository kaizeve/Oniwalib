// Amostragem de CPU/RAM/uptime. Funciona em bun, node e RTS — só usa
// `process` (global) e `node:os`, que os três provêem.

import os from "node:os";

export interface Stats {
  /** Segundos desde o start do processo. */
  uptime: number;
  /** Bytes residentes (RSS). */
  rss: number;
  /** Bytes fora do heap JS (buffers nativos etc.). */
  external: number;
  /** % de CPU do processo desde a última amostra (0..100·nCPUs). `null` na 1ª. */
  cpuPercent: number | null;
  /** Load average do sistema (1/5/15 min). */
  load: [number, number, number];
  /** Núcleos. */
  cpus: number;
  /** Memória livre / total do sistema, em bytes. */
  freemem: number;
  totalmem: number;
  platform: string;
}

/** Formata bytes em algo legível. */
export function humanBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/** Formata segundos em `1d 2h 3m 4s`. */
export function humanDuration(seconds: number): string {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s % 60}s`);
  return parts.join(" ");
}

export class Monitor {
  private lastCpu = process.cpuUsage();
  private lastAt = now();

  /** Uma amostra. Chame periodicamente; o `cpuPercent` é o intervalo desde a
   *  chamada anterior. */
  sample(): Stats {
    const cpu = process.cpuUsage();
    const at = now();
    const elapsedUs = (at - this.lastAt) * 1000; // ms → µs
    const usedUs =
      cpu.user - this.lastCpu.user + (cpu.system - this.lastCpu.system);
    const cpuPercent = elapsedUs > 0 ? Math.min(100 * (usedUs / elapsedUs), 100 * this.cpuCount()) : null;
    this.lastCpu = cpu;
    this.lastAt = at;

    const mem = process.memoryUsage();
    return {
      uptime: process.uptime(),
      rss: mem.rss,
      external: mem.external ?? 0,
      cpuPercent: this.first ? null : round1(cpuPercent),
      load: safeLoad(),
      cpus: this.cpuCount(),
      freemem: os.freemem(),
      totalmem: os.totalmem(),
      platform: os.platform(),
    };
  }

  private first = true;
  private cachedCpus = 0;
  private cpuCount(): number {
    if (!this.cachedCpus) {
      try {
        this.cachedCpus = os.cpus().length || 1;
      } catch {
        this.cachedCpus = 1;
      }
    }
    return this.cachedCpus;
  }

  /** Marca que a próxima amostra já pode reportar cpuPercent. */
  prime(): void {
    this.lastCpu = process.cpuUsage();
    this.lastAt = now();
    this.first = false;
  }
}

function now(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p && typeof p.now === "function" ? p.now() : Date.now();
}

function round1(n: number | null): number | null {
  return n === null ? null : Math.round(n * 10) / 10;
}

function safeLoad(): [number, number, number] {
  try {
    const l = os.loadavg();
    return [l[0] ?? 0, l[1] ?? 0, l[2] ?? 0];
  } catch {
    return [0, 0, 0];
  }
}
