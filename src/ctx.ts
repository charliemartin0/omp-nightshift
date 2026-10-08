import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Status, setChunkStatus } from "./backlog";
import { Ledger } from "./ledger";
import { spawnGroup } from "./proc";
import { type RunJson, resolveStopAt } from "./runjson";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

export interface Ctx {
  run: RunJson;
  dryRun: boolean;
  ledger: Ledger;
  stopAtMs: number;
  /** providers of the build model's fallback chain (set from the overlay; empty = no chain check) */
  buildProviders: string[];
  clock: Clock;
  /** `omp usage --json` parsed; null when unparseable */
  readUsage(): Promise<unknown>;
  /** chunk currently in status `running` (for the signal handler / crash path) */
  running: string | null;
  backlog: string;
  overlay: string;
  logs: string;
  prompts: string;
  sessions: string;
  /** Rewrites only that chunk's status/note lines; no-op in dry-run. */
  setStatus(id: string, status: Status, note: string): void;
}

export const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export function makeCtx(run: RunJson, dryRun: boolean): Ctx {
  const logs = join(run.runDir, "logs");
  const prompts = join(run.runDir, "prompts");
  const sessions = join(run.runDir, "sessions");
  for (const d of [logs, prompts, sessions]) mkdirSync(d, { recursive: true });
  const backlog = join(run.runDir, "backlog.md");
  return {
    run,
    dryRun,
    ledger: new Ledger(join(run.runDir, dryRun ? "ledger.dry-run.jsonl" : "ledger.jsonl")),
    stopAtMs: resolveStopAt(run.stopAt).getTime(),
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
    running: null,
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
