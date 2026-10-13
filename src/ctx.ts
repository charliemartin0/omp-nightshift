import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Status, setChunkStatus } from "./backlog";
import { Ledger } from "./ledger";
import { spawnGroup } from "./proc";
import { type RunJson, parseDuration, resolveStopAt } from "./runjson";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

/** Runs callers one at a time in call order; a rejection does not block later callers. */
export type Lock = <T>(fn: () => Promise<T>) => Promise<T>;

export function makeLock(): Lock {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

export interface Ctx {
  run: RunJson;
  dryRun: boolean;
  ledger: Ledger;
  stopAtMs: number | null;
  capAtMs: number;
  progressAt: number;
  runTokens: number;
  /** providers of the build model's fallback chain (set from the overlay; empty = no chain check) */
  buildProviders: string[];
  clock: Clock;
  /** `omp usage --json` parsed; null when unparseable */
  readUsage(): Promise<unknown>;
  /** chunks currently in status `running` (for the signal handler / crash path) */
  running: Set<string>;
  /**
   * Serialises the runner's shared-repository Git steps (fetch, branch + worktree creation, gt track) across parallel
   * chunks, so they never race each other or claim the same branch or worktree path.
   */
  repoLock: Lock;
  backlog: string;
  overlay: string;
  logs: string;
  prompts: string;
  sessions: string;
  /** Rewrites only that chunk's status/note lines; no-op in dry-run. */
  setStatus(id: string, status: Status, note: string): void;
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
  return {
    run,
    dryRun,
    ledger: new Ledger(join(run.runDir, dryRun ? "ledger.dry-run.jsonl" : "ledger.jsonl")),
    stopAtMs: run.stopAt ? resolveStopAt(run.stopAt).getTime() : null,
    capAtMs: now + (run.safetyCap ? parseDuration(run.safetyCap) : 12 * 3_600_000),
    progressAt: now,
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
    repoLock: makeLock(),
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
  };
}
