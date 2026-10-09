// Run-time estimate from past ledgers: per chunk type (id prefix) median/p90 durations plus the average quota wait
// per chunk. Pure apart from loadHistory.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type LedgerEntry, readLedger } from "./ledger";
import { bst } from "./stops";

export const MIN_SAMPLES = 3;
export const DEFAULT_MEDIAN_MS = 30 * 60_000;
export const DEFAULT_P90_MS = 60 * 60_000;
export const SAFETY_CAP_MULTIPLE = 2;
export const MIN_SAFETY_CAP_MS = 2 * 3_600_000;

const HOUR_MS = 3_600_000;
const NOT_A_RUN = ["pending", "dry_run", "stopped"];

/** `fe-plans` -> `fe`. */
export const chunkType = (id: string): string => id.split("-")[0];

export interface History {
  /** chunk durations (ms) by chunk type */
  durations: Record<string, number[]>;
  /** total quota wait (ms) */
  waitMs: number;
  /** finished chunk runs counted in `durations` */
  chunks: number;
  ledgers: number;
}

export interface TypeStats {
  median: number;
  p90: number;
  n: number;
  source: "type" | "pooled" | "default";
}

export interface Estimate {
  remaining: number;
  finishAtMs: number;
  p90AtMs: number;
  /** expected quota wait for the remaining chunks */
  waitMs: number;
  safetyCapMs: number;
}

const tsMs = (e: LedgerEntry): number => Date.parse(e.ts);

/**
 * Chunk durations (chunk_start -> chunk_end of a real outcome) and quota waits (first `quota_wait` until the next
 * chunk_start / run_start / stop / ok quota) from each ledger, walked in order.
 */
export function historyFromLedgers(ledgers: LedgerEntry[][]): History {
  const h: History = { durations: {}, waitMs: 0, chunks: 0, ledgers: ledgers.length };
  for (const entries of ledgers) {
    const starts = new Map<string, number>();
    let waitFrom: number | null = null;
    const closeWait = (at: number) => {
      if (waitFrom !== null && at >= waitFrom) h.waitMs += at - waitFrom;
      waitFrom = null;
    };
    for (const e of entries) {
      const at = tsMs(e);
      if (Number.isNaN(at)) continue;
      if (e.event === "chunk_start") {
        if (e.chunk) starts.set(e.chunk, at);
        closeWait(at);
      } else if (e.event === "chunk_end" && e.chunk) {
        const start = starts.get(e.chunk);
        starts.delete(e.chunk);
        if (start === undefined || NOT_A_RUN.includes(String(e.status))) continue;
        (h.durations[chunkType(e.chunk)] ??= []).push(at - start);
        h.chunks++;
      } else if (e.event === "quota_wait") {
        if (waitFrom === null) waitFrom = at;
      } else if (e.event === "run_start" || e.event === "stop" || (e.event === "quota" && e.ok === true)) {
        closeWait(at);
      }
    }
  }
  return h;
}

const subdirs = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name)) : [];

/** History from `<runsRoot>/<repo>/<date>/ledger.jsonl` (never dry-run ledgers) plus `extra`, deduplicated. */
export function loadHistory(runsRoot = join(homedir(), ".omp/overnight"), extra: string[] = []): History {
  const files = [...subdirs(runsRoot).flatMap((repo) => subdirs(repo).map((d) => join(d, "ledger.jsonl"))), ...extra];
  const seen = new Set<string>();
  const ledgers: LedgerEntry[][] = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const real = realpathSync(f);
    if (seen.has(real)) continue;
    seen.add(real);
    ledgers.push(readLedger(real));
  }
  return historyFromLedgers(ledgers);
}

function median(sorted: number[]): number {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** Nearest-rank p90. */
const p90 = (sorted: number[]): number => sorted[Math.ceil(0.9 * sorted.length) - 1];

/** The type's own samples when there are MIN_SAMPLES, else all types pooled, else the defaults. */
export function typeStats(h: History, type: string): TypeStats {
  const own = h.durations[type] ?? [];
  const pooled = Object.values(h.durations).flat();
  const [samples, source] = own.length >= MIN_SAMPLES ? [own, "type" as const] : [pooled, "pooled" as const];
  if (samples.length < MIN_SAMPLES) return { median: DEFAULT_MEDIAN_MS, p90: DEFAULT_P90_MS, n: 0, source: "default" };
  const sorted = [...samples].sort((a, b) => a - b);
  return { median: median(sorted), p90: p90(sorted), n: sorted.length, source };
}

const ceilToHour = (ms: number): number => Math.ceil(ms / HOUR_MS) * HOUR_MS;

/** Expected finish (medians), p90 finish, and the safety cap: max(2x the p90 span, 2h), rounded up to the hour. */
export function estimate(h: History, chunkIds: string[], nowMs: number): Estimate {
  const waitPerChunk = h.chunks ? h.waitMs / h.chunks : 0;
  const waitMs = chunkIds.length * waitPerChunk;
  let med = 0;
  let p = 0;
  for (const id of chunkIds) {
    const s = typeStats(h, chunkType(id));
    med += s.median;
    p += s.p90;
  }
  const finishAtMs = nowMs + med + waitMs;
  const p90AtMs = nowMs + p + waitMs;
  const safetyCapMs = ceilToHour(Math.max(SAFETY_CAP_MULTIPLE * (p90AtMs - nowMs), MIN_SAFETY_CAP_MS));
  return { remaining: chunkIds.length, finishAtMs, p90AtMs, waitMs, safetyCapMs };
}

/** `2h36m`, `13m`. */
export function formatDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  const h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

/** Whole hours, rounded up, in run.json `safetyCap` form (`6h`). */
export const formatCap = (ms: number): string => `${Math.ceil(ms / HOUR_MS)}h`;

/** CLI `estimate` output. */
export function estimateText(h: History, chunks: string[], nowMs: number): string {
  const counts = new Map<string, number>();
  for (const id of chunks) counts.set(chunkType(id), (counts.get(chunkType(id)) ?? 0) + 1);
  const types = [...counts.keys()].sort();
  const e = estimate(h, chunks, nowMs);
  const waitPerChunk = h.chunks ? h.waitMs / h.chunks : 0;
  return [
    `chunks: ${chunks.length} pending (${types.map((t) => `${t} ${counts.get(t)}`).join(", ")})`,
    `history: ${h.chunks} chunk runs from ${h.ledgers} ledger(s)`,
    ...types.map((t) => {
      const s = typeStats(h, t);
      return `  ${t}: median ${formatDuration(s.median)}, p90 ${formatDuration(s.p90)} (${s.n} ${s.source} samples)`;
    }),
    `expected quota waits: ${formatDuration(waitPerChunk)} per chunk, ${formatDuration(e.waitMs)} total`,
    `estimated finish ~${bst(e.finishAtMs)} (p90 ~${bst(e.p90AtMs)})`,
    `safetyCap: ${formatCap(e.safetyCapMs)}`,
  ].join("\n");
}
