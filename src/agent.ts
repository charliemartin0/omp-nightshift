import { closeSync, existsSync, readdirSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { type Ctx, deadline } from "./ctx";
import { openAppend, readLines, settle, startGroup } from "./proc";
import { parseDuration } from "./runjson";
import { sweepLogger } from "./sweep";
import { GapDetector, SUSPEND_GAP_MS } from "./suspend";
import { QUOTA_ERROR_RE, type Trip, Watchdog } from "./watchdog";

export const TICK_MS = 30_000;
const HARD_SLACK_MS = 5 * 60_000;

export interface AgentRun {
  code: number;
  trip: Trip | null;
  /** cumulative tokens for the chunk (seeded with earlier runs) */
  tokens: number;
  sessionId: string | null;
  /** the final assistant message died on a quota / rate-limit error */
  quotaError: string | null;
  /** awake run time (host-suspend gaps excluded) and the hard limit it was measured against */
  elapsedMs: number;
  hardMs: number;
  /** host-suspend time that was excluded from this invocation's timers */
  suspendMs: number;
}

/** Test seams for the tick loop (real clock and 30 s tick otherwise). */
export interface AgentTuning {
  tickMs?: number;
  now?: () => number;
  gapThresholdMs?: number;
  /** replaces the computed hard limit */
  hardMs?: number;
}

export type OmpMode =
  | { kind: "initial"; promptFile: string }
  | { kind: "resume"; session: string; message: string };

export function sessionsDir(ctx: Ctx, chunkId: string): string {
  return join(ctx.sessions, chunkId);
}

/** Exact omp argv (without the setsid prefix). */
export function ompArgv(ctx: Ctx, chunkId: string, wt: string, mode: OmpMode): string[] {
  const { models, limits } = ctx.run;
  const sessionDir = sessionsDir(ctx, chunkId);
  if (mode.kind === "initial") {
    return [
      "omp", "-p", "--mode", "json", "--model", models.plan, "--plan-yolo", "--plan-yolo-into", models.build,
      "--max-time", limits.maxTime, "--config", ctx.overlay, "--session-dir", sessionDir, "--cwd", wt,
      "--no-title", `@${mode.promptFile}`,
    ];
  }
  return [
    "omp", "-p", "--mode", "json", "--model", models.build, "-r", mode.session, "--session-dir", sessionDir,
    "--max-time", limits.resumeMaxTime, "--config", ctx.overlay, "--cwd", wt, "--no-title", mode.message,
  ];
}

/** Newest mtime (ms) of any file under dir, recursively; 0 if absent. */
function newestMtime(dir: string): number {
  let newest = 0;
  if (!existsSync(dir)) return 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    try {
      newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
    } catch {
      /* raced with a delete */
    }
  }
  return newest;
}

/** Newest top-level *.jsonl in the session dir (fallback when the stream header had no session id). */
export function newestSessionFile(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const mtime = statSync(join(dir, e.name)).mtimeMs;
    if (!best || mtime > best.mtime) best = { path: join(dir, e.name), mtime };
  }
  return best?.path ?? null;
}

/**
 * One omp invocation under a watchdog. Every TICK_MS: touch on session-dir activity, check for a trip,
 * and on a trip kill the process group (SIGTERM, 15 s, SIGKILL).
 */
export async function runOmp(
  ctx: Ctx,
  o: { chunk: string; wt: string; n: number; mode: OmpMode; tokensUsed: number; tuning?: AgentTuning },
): Promise<AgentRun> {
  const { limits } = ctx.run;
  const now = o.tuning?.now ?? Date.now;
  const tickMs = o.tuning?.tickMs ?? TICK_MS;
  const maxTime = o.mode.kind === "initial" ? limits.maxTime : limits.resumeMaxTime;
  const t0 = now();
  const hardMs = o.tuning?.hardMs ?? Math.min(parseDuration(maxTime) + HARD_SLACK_MS, deadline(ctx).atMs - t0);
  if (o.tokensUsed >= limits.tokenCap) {
    ctx.ledger.log("watchdog", { chunk: o.chunk, trip: "token_cap", tokens: o.tokensUsed, detail: "cap already spent; omp not started" });
    return { code: -1, trip: "token_cap", tokens: o.tokensUsed, sessionId: null, quotaError: null, elapsedMs: 0, hardMs, suspendMs: 0 };
  }
  if (hardMs <= 0) {
    ctx.ledger.log("watchdog", { chunk: o.chunk, trip: "timeout", tokens: o.tokensUsed, detail: `past ${deadline(ctx).reason} deadline; omp not started` });
    return { code: -1, trip: "timeout", tokens: o.tokensUsed, sessionId: null, quotaError: null, elapsedMs: 0, hardMs, suspendMs: 0 };
  }
  const wd = new Watchdog({
    now: t0,
    stallMs: limits.stallMinutes * 60_000,
    hardMs,
    tokenCap: limits.tokenCap,
    tokensUsed: o.tokensUsed,
  });
  const dir = sessionsDir(ctx, o.chunk);
  const logBase = join(ctx.logs, `${o.chunk}-omp-${o.n}`);
  const out = openAppend(`${logBase}.jsonl`);
  const err = openAppend(`${logBase}.stderr.log`);
  const g = startGroup(ompArgv(ctx, o.chunk, o.wt, o.mode), { cwd: o.wt });

  let trip: Trip | null = null;
  let suspendMs = 0;
  let lastMtime = newestMtime(dir);
  const gaps = new GapDetector(t0, tickMs, o.tuning?.gapThresholdMs ?? SUSPEND_GAP_MS);
  const tick = setInterval(() => {
    const at = now();
    // A tick that arrives hours late means the host slept: exclude the gap BEFORE any limit is checked.
    const gap = gaps.sample(at);
    if (gap > 0) {
      wd.shift(gap);
      suspendMs += gap;
      ctx.noteSuspend(gap, "agent", o.chunk);
    }
    const m = newestMtime(dir);
    if (m > lastMtime) {
      lastMtime = m;
      wd.touch(at);
    }
    const t = trip ? null : wd.check(at);
    if (t) {
      trip = t;
      ctx.ledger.log("watchdog", {
        chunk: o.chunk, trip: t, tokens: wd.tokens, tokenCap: limits.tokenCap,
        elapsedMin: Math.round((at - t0 - suspendMs) / 60_000), hardMin: Math.round(hardMs / 60_000), suspendedMin: Math.round(suspendMs / 60_000),
      });
      void g.kill();
    }
  }, tickMs);

  const pumps = Promise.all([
    (async () => {
      for await (const line of readLines(g.stdout)) {
        writeSync(out, `${line}\n`);
        wd.onLine(line, now());
      }
    })(),
    (async () => {
      for await (const line of readLines(g.stderr)) writeSync(err, `${line}\n`);
    })(),
  ]);
  const code = await g.exited;
  // Orphans of the session (dev servers, browsers) must not outlive it: they would fail the next phase's ports.
  const swept = await g.sweep(true);
  sweepLogger(ctx, "agent", o.chunk)(swept);
  await settle(pumps, 3000); // a stray grandchild must not hold us here
  clearInterval(tick);
  closeSync(out);
  closeSync(err);
  ctx.runTokens += wd.tokens - o.tokensUsed;
  // omp may exit between ticks with the cap already spent: never let that reach the gate/fix-resume path.
  if (!trip && wd.tokens >= limits.tokenCap) {
    trip = "token_cap";
    ctx.ledger.log("watchdog", { chunk: o.chunk, trip, tokens: wd.tokens });
  }
  const quotaError = wd.lastError !== null && QUOTA_ERROR_RE.test(wd.lastError) ? wd.lastError : null;
  ctx.ledger.log("omp_exit", { chunk: o.chunk, code, trip, tokens: wd.tokens, sessionId: wd.sessionId, quotaError, swept: swept.found });
  return { code, trip, tokens: wd.tokens, sessionId: wd.sessionId, quotaError, elapsedMs: now() - t0 - suspendMs, hardMs, suspendMs };
}
