import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Chunk, type Need, chunkNeeds, parseBacklog } from "./backlog";
import { type Outcome, isEnvNote, runChunk } from "./chunk";
import { type Ctx, deadline, makeCtx, realClock } from "./ctx";
import type { DiskSample } from "./disk";
import { dryRunChunk } from "./dryrun";
import { estimate, formatCap, loadHistory } from "./estimate";
import { removeWorktree } from "./git";
import { writeOverlay } from "./overlayfile";
import { type Check, chunksBlockedBy, preflightRequirements, runPreflight } from "./preflight";
import { errMsg, shutdown } from "./proc";
import { writeReport } from "./report";
import { selfReview } from "./review";
import { loadRunJson } from "./runjson";
import { type Stop, checkDispatch, checkStop, IDENTICAL_FAILURE_LIMIT, MAX_CONSECUTIVE_FAILURES, STOP_MARGIN_MS } from "./stops";
import { markInterrupted, recoverSetup } from "./setup";

/** A chunk killed by a quota error returns to pending at most this many times before it counts as failed. */
export const MAX_QUOTA_REQUEUES = 3;

/** How often a low-space run re-measures and re-logs while it waits for free space to come back. */
export const DISK_POLL_MS = 5 * 60_000;

/** `disk_wait` ledger line: same shape as `quota_wait`, tagged with the measured volumes. */
export function logDiskWait(ctx: Ctx, sample: DiskSample, waitedMinutes: number): void {
  ctx.ledger.log("disk_wait", {
    detail: sample.detail,
    volumes: sample.volumes,
    waitedMinutes,
    waitMinutes: ctx.run.disk.waitMinutes,
    message: `free space below threshold; waiting up to ${ctx.run.disk.waitMinutes} min for it before stopping`,
  });
}

/** Refresh the finish estimate while keeping the launch's fixed safety cap. */
export function logEstimate(ctx: Ctx): void {
  const ids = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks.filter((c) => c.status === "pending").map((c) => c.id);
  const e = estimate(loadHistory(undefined, [ctx.ledger.file]), ids, ctx.clock.now());
  ctx.ledger.log("estimate", { remaining: e.remaining, finishAt: new Date(e.finishAtMs).toISOString(), p90At: new Date(e.p90AtMs).toISOString(), capAt: new Date(ctx.capAtMs).toISOString() });
}

/** A started chunk once it settles: its real or dry-run outcome, or the error that escaped it. */
type Done = { chunk: Chunk; sequence: number } & (
  | { kind: "run"; out: Outcome & { branch: string } }
  | { kind: "dry"; branch: string | null }
  | { kind: "error"; cause: unknown }
);

/**
 * Work through pending chunks in file order, up to `run.concurrency` at a time, until a stop condition (or the
 * backlog) ends the run. Chunk exceptions become failed outcomes; global stops/errors drain running chunks first.
 * Failure limits are applied in dispatch order; out-of-order outcomes hold admission until their predecessors finish.
 */
export async function loop(
  ctx: Ctx,
  dryWorktrees: string[],
  run: typeof runChunk = runChunk,
  recheck: (needs: Need[]) => Promise<Check[]> = (needs) => {
    const chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
    const { dotnetTarget, dotnetCwd } = preflightRequirements(chunks.map((c) => ({ ...c, status: "pending" })));
    return runPreflight(ctx.run, { ledger: ctx.ledger, logFile: join(ctx.logs, "preflight.log"), needs, recheck: true, readDisk: () => ctx.readDisk(), dotnetTarget, dotnetCwd, deadlineAtMs: deadline(ctx).atMs - STOP_MARGIN_MS, clock: ctx.clock });
  },
): Promise<Stop> {
  const seen = new Set<string>();
  const requeues = new Map<string, number>();
  const failureNotes = new Map<string, number>();
  const envRetried = new Set<string>();
  const inFlight = new Map<string, Promise<Done>>();
  let failures = 0;
  let dispatched = 0;
  let nextAccount = 0;
  const completed = new Map<number, { chunk: Chunk; out: Outcome & { branch: string } }>();
  let lastBranch: string | null = null;
  let dryIndex = 0;
  let stop: Stop | null = null;
  let error: { cause: unknown } | null = null;

  // Free-space guard state. `lowSince` spans the whole low episode, not one admission, so the wait budget is
  // measured from the first low sample and survives chunk completions.
  const diskWaitMs = ctx.run.disk.waitMinutes * 60_000;
  let diskLowSince: number | null = null;
  let diskLoggedAt: number | null = null;
  let diskNextPollAt = 0;

  /** Milliseconds to the next re-probe, bounded by the wait budget and the effective deadline; positive while low. */
  const diskPollIn = (): number => {
    const now = ctx.clock.now();
    return Math.max(0, Math.min(diskNextPollAt, (diskLowSince ?? now) + diskWaitMs, deadline(ctx).atMs - STOP_MARGIN_MS) - now);
  };

  /**
   * Free-space gate: `null` admits, `"wait"` defers admission while space is low, otherwise the run stops. A failed
   * probe counts as low space, so a broken measurement can never be mistaken for available capacity.
   */
  const diskGate = async (): Promise<Stop | "wait" | null> => {
    const sample = await ctx.readDisk();
    const now = ctx.clock.now();
    if (sample.ok) {
      diskLowSince = null;
      diskLoggedAt = null;
      return null;
    }
    if (diskLowSince === null) diskLowSince = now;
    if (diskLoggedAt === null || now - diskLoggedAt >= DISK_POLL_MS) {
      logDiskWait(ctx, sample, Math.round((now - diskLowSince) / 60_000));
      diskLoggedAt = now;
    }
    diskNextPollAt = now + DISK_POLL_MS;
    if (ctx.dryRun) return { reason: "disk", detail: sample.detail };
    const d = deadline(ctx);
    const waitLimit = diskLowSince + diskWaitMs;
    const marginAt = d.atMs - STOP_MARGIN_MS;
    if (now >= waitLimit || now >= marginAt) {
      if (marginAt <= waitLimit) return { reason: d.reason, detail: `${Math.round((d.atMs - now) / 60_000)} min to ${new Date(d.atMs).toISOString()}` };
      return { reason: "disk", detail: `free space below threshold for ${Math.round((now - diskLowSince) / 60_000)} min: ${sample.detail}` };
    }
    return "wait";
  };

  /** Cancellable disk-poll timer; unref'd on the real clock so a pending poll never holds the process open. */
  const pollTimer = (ms: number): { promise: Promise<void>; cancel(): void } => {
    if (ctx.clock !== realClock) return { promise: ctx.clock.sleep(ms), cancel: () => {} };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref();
    });
    return { promise, cancel: () => clearTimeout(timer ?? undefined) };
  };

  const start = async (chunk: Chunk, sequence: number): Promise<Done> => {
    try {
      if (ctx.dryRun) return { chunk, sequence, kind: "dry", branch: await dryRunChunk(ctx, chunk, dryIndex++, lastBranch, dryWorktrees) };
      return { chunk, sequence, kind: "run", out: await run(ctx, chunk, lastBranch) };
    } catch (cause) {
      return { chunk, sequence, kind: "error", cause };
    }
  };

  /** Start pending chunks while slots are free; returns when the backlog has none, dispatch holds, or a stop is due. */
  const fill = async (): Promise<void> => {
    if (completed.size) return; // do not outrun a failure limit hidden behind an earlier, still-running attempt
    while (inFlight.size < ctx.run.concurrency) {
      const chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
      const next = chunks.find((c) => c.status === "pending" && !seen.has(c.id));
      if (!next) return;
      // Only an idle runner may sleep through a quota wait; with chunks in flight the next finish re-evaluates.
      const verdict = inFlight.size ? await checkDispatch(ctx, chunks, failures, inFlight.size) : await checkStop(ctx, chunks, failures);
      if (verdict === "hold") return;
      if (verdict) {
        stop = verdict;
        return;
      }
      let gate = await diskGate();
      // Idle and low: wait for the next poll, then re-probe. Running chunks are never interrupted by this guard.
      while (gate === "wait" && inFlight.size === 0) {
        // diskGate reports "wait" only before the wait budget and the deadline margin, so this sleep is positive.
        const ms = diskPollIn();
        await ctx.clock.sleep(ms);
        ctx.progressAt += ms; // an intentional disk wait is not a stall
        gate = await diskGate();
      }
      if (gate === "wait") return; // chunks in flight: the poll timer re-enters admission
      if (gate) {
        stop = gate;
        return;
      }
      seen.add(next.id);
      inFlight.set(next.id, start(next, dispatched++));
    }
  };

  /** Requeue, failure and branch bookkeeping for one finished chunk; returns a stop its outcome demands. */
  const settle = (done: Exclude<Done, { kind: "error" }>): Stop | null => {
    ctx.progressAt = ctx.clock.now();
    logEstimate(ctx);
    if (done.kind === "dry") lastBranch = done.branch ?? lastBranch;
    const { chunk } = done;
    let out: Outcome & { branch: string } = done.kind === "dry"
      ? { status: "skipped", note: "dry-run accounting", branch: done.branch ?? "" }
      : done.out;
    if (out.requeue) {
      const n = (requeues.get(chunk.id) ?? 0) + 1;
      requeues.set(chunk.id, n);
      if (n < MAX_QUOTA_REQUEUES) seen.delete(chunk.id);
      else {
        out = { status: "failed", note: `quota error ${n}x: ${out.note}`, branch: out.branch };
        ctx.setStatus(chunk.id, out.status, out.note);
      }
    }
    completed.set(done.sequence, { chunk, out });
    let orderedStop: Stop | null = null;
    while (completed.has(nextAccount)) {
      const { chunk: accounted, out: result } = completed.get(nextAccount)!;
      completed.delete(nextAccount++);
      if (result.status === "failed") {
        failures++;
        const note = result.note.replace(new RegExp(`(?<![\\w-])${accounted.id}(?!\\w)`, "g"), "<id>").replace(/\d+/g, "#");
        const n = (failureNotes.get(note) ?? 0) + 1;
        failureNotes.set(note, n);
        if (n >= IDENTICAL_FAILURE_LIMIT) orderedStop ??= { reason: "safety_cap", detail: `same failure 3x: ${note.slice(0, 150)}` };
        if (failures >= MAX_CONSECUTIVE_FAILURES) orderedStop ??= { reason: "consecutive_failures", detail: `${failures} failed in dispatch order` };
      } else if (result.status === "passed" || result.status === "flaky") {
        failures = 0;
        lastBranch = result.branch;
      } // blocked/skipped/requeue neither count nor reset
    }
    return out.stopReason ? { reason: out.stopReason, detail: out.stopDetail } : orderedStop;
  };

  for (;;) {
    if (!stop && !error) {
      try {
        await fill();
      } catch (cause) {
        error = { cause };
      }
    }
    if (inFlight.size) {
      const poll = diskLowSince === null || stop || error ? null : pollTimer(diskPollIn());
      let first: Done | void;
      try {
        first = await Promise.race(poll ? [...inFlight.values(), poll.promise] : [...inFlight.values()]);
      } finally {
        poll?.cancel();
      }
      if (!first) {
        // A disk poll tick re-measures here: fill() can return before the gate (held dispatch, no unseen pending
        // chunk, held-back outcomes), and re-arming an already-elapsed timer would spin at tick cadence.
        const gate = await diskGate();
        if (gate && gate !== "wait") stop ??= gate;
        continue;
      }
      const done = first;
      inFlight.delete(done.chunk.id);
      try {
        let result: Exclude<Done, { kind: "error" }>;
        if (done.kind === "error") {
          const note = `chunk_error: ${errMsg(done.cause)}`;
          ctx.setStatus(done.chunk.id, "failed", note);
          ctx.running.delete(done.chunk.id);
          ctx.settingUp.delete(done.chunk.id);
          ctx.ledger.log("chunk_end", { chunk: done.chunk.id, status: "failed", note, changedFiles: [] });
          result = { ...done, kind: "run", out: { status: "failed", note, branch: "" } };
        } else result = done;
        const s = settle(result);
        stop ??= s; // the first global stop wins; later outcomes are still recorded
      } catch (cause) {
        error ??= { cause };
      }
      continue;
    }
    if (error) throw error.cause;
    if (stop) return stop;

    // Idle with no pending chunk left: environment-blocked chunks get their one recheck per runner process.
    const chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
    if (ctx.dryRun) return { reason: "finished" };
    const candidates = chunks.filter((c) => c.status === "blocked" && isEnvNote(c.note) && !envRetried.has(c.id));
    if (!candidates.length) return { reason: "finished" };
    const halt = await checkStop(ctx, chunks, failures);
    if (halt) return halt;
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
  }
}

/** The unattended run body (`cli.ts run`). Returns the process exit code. */
export async function runMain(runJsonPath: string, dryRun: boolean): Promise<number> {
  const run = loadRunJson(runJsonPath);
  const ctx = makeCtx(run, dryRun);
  const { ledger } = ctx;
  const dryWorktrees: string[] = [];

  // Shutdown parks subprocess callers before recording every admitted setup/running chunk. Recovery on relaunch
  // only releases proven pristine setup ownership; agent-started worktrees remain untouched.
  const onSignal = async () => {
    await shutdown();
    markInterrupted(ctx);
    process.exit(0);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const now = ctx.clock.now();
  if (!run.safetyCap) {
    const pendingIds = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks.filter((c) => c.status === "pending").map((c) => c.id);
    ctx.capAtMs = now + estimate(loadHistory(undefined, [ctx.ledger.file]), pendingIds, now).safetyCapMs;
  }
  ledger.log("run_start", { pid: process.pid, dryRun, concurrency: run.concurrency, stopAt: ctx.stopAtMs !== null ? new Date(ctx.stopAtMs).toISOString() : null, capAt: new Date(ctx.capAtMs).toISOString(), safetyCap: run.safetyCap ?? formatCap(ctx.capAtMs - now) });
  let stop: Stop = { reason: "finished" };
  let exitCode = 0;
  try {
    await recoverSetup(ctx);
    const chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
    // `readDisk` comes from the context, so tests never measure the machine they run on.
    const checks = await runPreflight(run, { ledger, logFile: join(ctx.logs, "preflight.log"), readDisk: () => ctx.readDisk(), ...preflightRequirements(chunks) });
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
  } finally {
    for (const wt of dryWorktrees) {
      try {
        await removeWorktree(run.repo, wt);
      } catch (e) {
        const detail = errMsg(e);
        ledger.log("cleanup_error", { wt, detail });
        stop = { reason: "runner_error", detail: `dry worktree cleanup: ${detail}` };
        exitCode = 1;
      }
    }
  }
  await finishRun(ctx, stop);
  return exitCode;
}

/** Finalize a complete or partial launch once; selfReview itself enforces quota and deadline headroom. */
export async function finishRun(ctx: Ctx, stop: Stop): Promise<void> {
  ctx.ledger.log("stop", { ...stop });
  if (ctx.run.selfReview && !ctx.dryRun) await selfReview(ctx);
  await writeReport(ctx);
}
