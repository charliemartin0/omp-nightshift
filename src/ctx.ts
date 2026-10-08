import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Status, setChunkStatus } from "./backlog";
import { Ledger } from "./ledger";
import { type RunJson, resolveStopAt } from "./runjson";

export interface Ctx {
  run: RunJson;
  dryRun: boolean;
  ledger: Ledger;
  stopAtMs: number;
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
