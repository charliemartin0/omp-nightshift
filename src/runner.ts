import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Need, chunkNeeds, parseBacklog } from "./backlog";
import { isEnvNote, runChunk } from "./chunk";
import { type Ctx, deadline, makeCtx } from "./ctx";
import { dryRunChunk } from "./dryrun";
import { estimate, formatCap, loadHistory } from "./estimate";
import { removeWorktree } from "./git";
import { type KeepAwake, startKeepAwake } from "./keepawake";
import { writeOverlay } from "./overlayfile";
import { type Check, chunksBlockedBy, preflightRequirements, runPreflight } from "./preflight";
import { errMsg, shutdown } from "./proc";
import { writeReport } from "./report";
import { selfReview } from "./review";
import { loadRunJson } from "./runjson";
import { type Stop, checkStop, IDENTICAL_FAILURE_LIMIT, STOP_MARGIN_MS } from "./stops";

/** A chunk killed by a quota error returns to pending at most this many times before it counts as failed. */
export const MAX_QUOTA_REQUEUES = 3;

/** Refresh the finish estimate while keeping the launch's fixed safety cap. */
export function logEstimate(ctx: Ctx): void {
  const ids = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks.filter((c) => c.status === "pending").map((c) => c.id);
  const e = estimate(loadHistory(undefined, [ctx.ledger.file]), ids, ctx.clock.now());
  ctx.ledger.log("estimate", { remaining: e.remaining, finishAt: new Date(e.finishAtMs).toISOString(), p90At: new Date(e.p90AtMs).toISOString(), capAt: new Date(ctx.capAtMs).toISOString() });
}

/** Work through pending chunks in file order until a stop condition (or the backlog) ends the run. */
export async function loop(
  ctx: Ctx,
  dryWorktrees: string[],
  run: typeof runChunk = runChunk,
  recheck: (needs: Need[]) => Promise<Check[]> = (needs) => {
    const chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
    const { dotnetTarget, dotnetCwd } = preflightRequirements(chunks.map((c) => ({ ...c, status: "pending" })));
    return runPreflight(ctx.run, { ledger: ctx.ledger, logFile: join(ctx.logs, "preflight.log"), needs, recheck: true, dotnetTarget, dotnetCwd, deadlineAtMs: deadline(ctx).atMs - STOP_MARGIN_MS, clock: ctx.clock });
  },
): Promise<Stop> {
  const seen = new Set<string>();
  const requeues = new Map<string, number>();
  const failureNotes = new Map<string, number>();
  const envRetried = new Set<string>();
  let failures = 0;
  let lastBranch: string | null = null;
  let dryIndex = 0;
  for (;;) {
    const chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
    const next = chunks.find((c) => c.status === "pending" && !seen.has(c.id));
    if (!next) {
      if (ctx.dryRun) return { reason: "finished" };
      const candidates = chunks.filter((c) => c.status === "blocked" && isEnvNote(c.note) && !envRetried.has(c.id));
      if (!candidates.length) return { reason: "finished" };
      const stop = await checkStop(ctx, chunks, failures);
      if (stop) return stop;
      for (const c of candidates) envRetried.add(c.id);
      const checks = await recheck([...new Set(candidates.flatMap(chunkNeeds))]);
      const failed = checks.filter((c) => !c.ok);
      const retried = failed.some((c) => !c.need) ? [] : candidates.filter((c) => !failed.some((x) => x.need && chunkNeeds(c).includes(x.need)));
      ctx.ledger.log("env_retry", { chunks: candidates.map((c) => c.id), retried: retried.map((c) => c.id), ok: failed.length === 0, failed: failed.map((c) => c.name) });
      const d = deadline(ctx);
      const left = d.atMs - ctx.clock.now();
      if (left <= STOP_MARGIN_MS) return { reason: d.reason, detail: `${Math.round(left / 60_000)} min to ${new Date(d.atMs).toISOString()}` };
      for (const c of retried) {
        ctx.setStatus(c.id, "pending", `env retry: ${c.note}`);
        seen.delete(c.id);
      }
      if (!retried.length) return { reason: "finished" };
      continue;
    }
    const stop = await checkStop(ctx, chunks, failures);
    if (stop) return stop;
    seen.add(next.id);

    if (ctx.dryRun) {
      lastBranch = (await dryRunChunk(ctx, next, dryIndex++, lastBranch, dryWorktrees)) ?? lastBranch;
      ctx.progressAt = ctx.clock.now();
      logEstimate(ctx);
      continue;
    }
    const out = await run(ctx, next, lastBranch);
    ctx.progressAt = ctx.clock.now();
    logEstimate(ctx);
    if (out.requeue) {
      // quota death, not a failure; the next checkStop waits out the window. A fresh run starts a new worktree.
      const n = (requeues.get(next.id) ?? 0) + 1;
      requeues.set(next.id, n);
      if (n < MAX_QUOTA_REQUEUES) {
        seen.delete(next.id);
        continue;
      }
      ctx.setStatus(next.id, "failed", `quota error ${n}x: ${out.note}`);
      failures++;
      continue;
    }
    if (out.status === "failed") {
      failures++;
      const note = out.note.replace(new RegExp(`(?<![\\w-])${next.id}(?!\\w)`, "g"), "<id>").replace(/\d+/g, "#");
      const n = (failureNotes.get(note) ?? 0) + 1;
      failureNotes.set(note, n);
      if (n >= IDENTICAL_FAILURE_LIMIT) return { reason: "safety_cap", detail: `same failure 3x: ${note.slice(0, 150)}` };
    }
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
  let keepAwake: KeepAwake | null = null;
  const onSignal = async () => {
    await shutdown();
    await keepAwake?.stop();
    const chunk = ctx.running;
    if (chunk) ctx.setStatus(chunk, "stopped", "stopped by signal");
    ledger.log("stop", { reason: "signal", ...(chunk ? { chunk } : {}) });
    process.exit(0);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const now = ctx.clock.now();
  if (!run.safetyCap) {
    const pendingIds = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks.filter((c) => c.status === "pending").map((c) => c.id);
    ctx.capAtMs = now + estimate(loadHistory(undefined, [ctx.ledger.file]), pendingIds, now).safetyCapMs;
  }
  ledger.log("run_start", { pid: process.pid, dryRun, stopAt: ctx.stopAtMs !== null ? new Date(ctx.stopAtMs).toISOString() : null, capAt: new Date(ctx.capAtMs).toISOString(), safetyCap: run.safetyCap ?? formatCap(ctx.capAtMs - now) });
  let stop: Stop = { reason: "finished" };
  let exitCode = 0;
  try {
    if (!dryRun) {
      keepAwake = await startKeepAwake({ leaseFile: join(run.runDir, ".keepawake") });
      ledger.log("keepawake", { ok: keepAwake.ok, detail: keepAwake.detail });
    }
    const chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
    const checks = await runPreflight(run, { ledger, logFile: join(ctx.logs, "preflight.log"), ...preflightRequirements(chunks) });
    logEstimate(ctx);
    const failed = checks.filter((c) => !c.ok && !c.need).map((c) => c.name);
    if (failed.length) {
      stop = { reason: "preflight_failed", detail: failed.join(", ") };
      exitCode = 1;
    } else {
      for (const blocked of chunksBlockedBy(chunks, checks)) {
        ctx.setStatus(blocked.id, "blocked", blocked.note);
        ledger.log("chunk_end", { chunk: blocked.id, status: "blocked", note: blocked.note, changedFiles: [], preflight: true });
      }
      ctx.buildProviders = (await writeOverlay(run)).buildProviders;
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
    await keepAwake?.stop();
    for (const wt of dryWorktrees) await removeWorktree(run.repo, wt);
  }
  ledger.log("stop", { ...stop });
  if (run.selfReview && !ctx.dryRun && (stop.reason === "finished" || stop.reason === "max_prs")) await selfReview(ctx);
  await writeReport(ctx);
  return exitCode;
}
