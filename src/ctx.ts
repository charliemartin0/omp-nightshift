import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Status, setChunkStatus } from "./backlog";
import { Ledger } from "./ledger";
import { withRepoLock } from "./repolock";
import { spawnGroup } from "./proc";
import { type RunJson, parseDuration, resolveStopAt } from "./runjson";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

/** Serialises short repository mutation callbacks; nested runner scopes reenter the same lock. */
export type Lock = <T>(fn: () => Promise<T>) => Promise<T>;

export interface Ctx {
  run: RunJson;
  dryRun: boolean;
  ledger: Ledger;
  stopAtMs: number | null;
  capAtMs: number;
  progressAt: number;
  /** total host-suspend time excluded from the safety cap, no-progress and per-phase timers */
  suspendMs: number;
  runTokens: number;
  /** providers of the build model's fallback chain (set from the overlay; empty = no chain check) */
  buildProviders: string[];
  clock: Clock;
  /** `omp usage --json` parsed; null when unparseable */
  readUsage(): Promise<unknown>;
  /** chunks currently in status `running` (for the signal handler / crash path) */
  running: Set<string>;
  /** Chunks admitted to setup, including planning and waiting for the repository lock. */
  settingUp: Set<string>;
  /**
   * Serialises short shared-repository steps against both runner chunks and agent shell wrappers, using flock in
   * the common Git directory. Setup commands, agents and tests run outside this lock.
   */
  repoLock: Lock;
  backlog: string;
  overlay: string;
  logs: string;
  prompts: string;
  sessions: string;
  /** Rewrites only that chunk's status/note lines; no-op in dry-run. */
  setStatus(id: string, status: Status, note: string): void;
  /** Record a host suspend: the safety cap and the no-progress timer do not count the gap. `stopAt` stays wall-clock. */
  noteSuspend(gapMs: number, where: string, chunk?: string): void;
}

export const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The optional wall-clock override wins only when it is earlier than the safety cap. */
export function deadline(ctx: Ctx): { atMs: number; reason: "safety_cap" | "stopAt" } {
  return ctx.stopAtMs !== null && ctx.stopAtMs <= ctx.capAtMs
    ? { atMs: ctx.stopAtMs, reason: "stopAt" }
    : { atMs: ctx.capAtMs, reason: "safety_cap" };
}

export function makeCtx(run: RunJson, dryRun: boolean): Ctx {
  const logs = join(run.runDir, "logs");
  const prompts = join(run.runDir, "prompts");
  const sessions = join(run.runDir, "sessions");
  for (const d of [logs, prompts, sessions]) mkdirSync(d, { recursive: true });
  const backlog = join(run.runDir, "backlog.md");
  const now = Date.now();
  const ctx: Ctx = {
    run,
    dryRun,
    ledger: new Ledger(join(run.runDir, dryRun ? "ledger.dry-run.jsonl" : "ledger.jsonl")),
    stopAtMs: run.stopAt ? resolveStopAt(run.stopAt).getTime() : null,
    capAtMs: now + (run.safetyCap ? parseDuration(run.safetyCap) : 12 * 3_600_000),
    progressAt: now,
    suspendMs: 0,
    runTokens: 0,
    buildProviders: [],
    clock: realClock,
    async readUsage() {
      const r = await spawnGroup(["omp", "usage", "--json"], { cwd: run.repo, timeoutMs: 60_000 });
      try {
        return JSON.parse(r.stdout);
      } catch {
        return null;
      }
    },
    running: new Set(),
    settingUp: new Set(),
    repoLock: (fn) => withRepoLock(run.repo, fn),
    backlog,
    overlay: join(run.runDir, "overlay.yml"),
    logs,
    prompts,
    sessions,
    setStatus(id, status, note) {
      if (dryRun) return;
      const tmp = `${backlog}.tmp`;
      writeFileSync(tmp, setChunkStatus(readFileSync(backlog, "utf8"), id, status, oneLine(note)));
      renameSync(tmp, backlog);
    },
    noteSuspend(gapMs, where, chunk) {
      ctx.suspendMs += gapMs;
      ctx.capAtMs += gapMs;
      ctx.progressAt += gapMs;
      ctx.ledger.log("host_suspend", { ...(chunk ? { chunk } : {}), where, gapSec: Math.round(gapMs / 1000) });
    },
  };
  return ctx;
}
