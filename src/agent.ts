import { closeSync, existsSync, readdirSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "./ctx";
import { openAppend, readLines, settle, startGroup } from "./proc";
import { parseDuration } from "./runjson";
import { type Trip, Watchdog } from "./watchdog";

export const TICK_MS = 30_000;
const HARD_SLACK_MS = 5 * 60_000;

export interface AgentRun {
  code: number;
  trip: Trip | null;
  /** cumulative tokens for the chunk (seeded with earlier runs) */
  tokens: number;
  sessionId: string | null;
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
  o: { chunk: string; wt: string; n: number; mode: OmpMode; tokensUsed: number },
): Promise<AgentRun> {
  const { limits } = ctx.run;
  const maxTime = o.mode.kind === "initial" ? limits.maxTime : limits.resumeMaxTime;
  const t0 = Date.now();
  const hardMs = Math.min(parseDuration(maxTime) + HARD_SLACK_MS, ctx.stopAtMs - t0);
  if (o.tokensUsed >= limits.tokenCap) {
    ctx.ledger.log("watchdog", { chunk: o.chunk, trip: "token_cap", tokens: o.tokensUsed, detail: "cap already spent; omp not started" });
    return { code: -1, trip: "token_cap", tokens: o.tokensUsed, sessionId: null };
  }
  if (hardMs <= 0) {
    ctx.ledger.log("watchdog", { chunk: o.chunk, trip: "timeout", tokens: o.tokensUsed, detail: "past stop time; omp not started" });
    return { code: -1, trip: "timeout", tokens: o.tokensUsed, sessionId: null };
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
  let lastMtime = newestMtime(dir);
  const tick = setInterval(() => {
    const now = Date.now();
    const m = newestMtime(dir);
    if (m > lastMtime) {
      lastMtime = m;
      wd.touch(now);
    }
    const t = trip ? null : wd.check(now);
    if (t) {
      trip = t;
      ctx.ledger.log("watchdog", { chunk: o.chunk, trip: t, tokens: wd.tokens });
      void g.kill();
    }
  }, TICK_MS);

  const pumps = Promise.all([
    (async () => {
      for await (const line of readLines(g.stdout)) {
        writeSync(out, `${line}\n`);
        wd.onLine(line, Date.now());
      }
    })(),
    (async () => {
      for await (const line of readLines(g.stderr)) writeSync(err, `${line}\n`);
    })(),
  ]);
  const code = await g.exited;
  await settle(pumps, 3000); // a stray grandchild must not hold us here
  clearInterval(tick);
  closeSync(out);
  closeSync(err);
  // omp may exit between ticks with the cap already spent: never let that reach the gate/fix-resume path.
  if (!trip && wd.tokens >= limits.tokenCap) {
    trip = "token_cap";
    ctx.ledger.log("watchdog", { chunk: o.chunk, trip, tokens: wd.tokens });
  }
  ctx.ledger.log("omp_exit", { chunk: o.chunk, code, trip, tokens: wd.tokens, sessionId: wd.sessionId });
  return { code, trip, tokens: wd.tokens, sessionId: wd.sessionId };
}
