import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBacklog } from "./backlog";
import { runChunk } from "./chunk";
import { type Ctx, makeCtx } from "./ctx";
import { dryRunChunk } from "./dryrun";
import { removeWorktree } from "./git";
import { writeOverlay } from "./overlayfile";
import { runPreflight } from "./preflight";
import { errMsg, shutdown } from "./proc";
import { writeReport } from "./report";
import { loadRunJson } from "./runjson";
import { type Stop, checkStop } from "./stops";

/** Work through pending chunks in file order until a stop condition (or the backlog) ends the run. */
async function loop(ctx: Ctx, dryWorktrees: string[]): Promise<Stop> {
  const seen = new Set<string>();
  let failures = 0;
  let lastBranch: string | null = null;
  let dryIndex = 0;
  for (;;) {
    const chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
    const next = chunks.find((c) => c.status === "pending" && !seen.has(c.id));
    if (!next) return { reason: "backlog_exhausted" };
    const stop = await checkStop(ctx, chunks, failures);
    if (stop) return stop;
    seen.add(next.id);

    if (ctx.dryRun) {
      lastBranch = (await dryRunChunk(ctx, next, dryIndex++, lastBranch, dryWorktrees)) ?? lastBranch;
      continue;
    }
    const out = await runChunk(ctx, next, lastBranch);
    if (out.status === "failed") failures++;
    else if (out.status === "passed" || out.status === "flaky") {
      failures = 0;
      lastBranch = out.branch;
    } // blocked/skipped neither count nor reset
    if (out.stopReason) return { reason: out.stopReason, detail: out.stopDetail };
  }
}

/** The unattended run body (`cli.ts run`). Returns the process exit code. */
export async function runMain(runJsonPath: string, dryRun: boolean): Promise<number> {
  const run = loadRunJson(runJsonPath);
  const ctx = makeCtx(run, dryRun);
  const { ledger } = ctx;
  const dryWorktrees: string[] = [];

  // SIGTERM/SIGINT: kill the current child group, mark the running chunk `stopped`, no report, exit 0.
  // Worktrees, branches and PRs are never touched.
  const onSignal = async () => {
    await shutdown();
    const chunk = ctx.running;
    if (chunk) ctx.setStatus(chunk, "stopped", "stopped by signal");
    ledger.log("stop", { reason: "signal", ...(chunk ? { chunk } : {}) });
    process.exit(0);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  ledger.log("run_start", { pid: process.pid, dryRun, stopAt: new Date(ctx.stopAtMs).toISOString() });
  let stop: Stop = { reason: "backlog_exhausted" };
  let exitCode = 0;
  try {
    const checks = await runPreflight(run, { ledger, logFile: join(ctx.logs, "preflight.log") });
    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    if (failed.length) {
      stop = { reason: "preflight_failed", detail: failed.join(", ") };
      exitCode = 1;
    } else {
      await writeOverlay(run);
      stop = await loop(ctx, dryWorktrees);
    }
  } catch (e) {
    stop = { reason: "runner_error", detail: errMsg(e) };
    exitCode = 1;
    if (ctx.running) {
      ctx.setStatus(ctx.running, "failed", `runner_error: ${stop.detail}`);
      ctx.running = null;
    }
  } finally {
    for (const wt of dryWorktrees) await removeWorktree(run.repo, wt);
  }
  ledger.log("stop", { ...stop });
  await writeReport(ctx);
  return exitCode;
}
