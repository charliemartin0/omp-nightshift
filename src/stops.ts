import type { Chunk } from "./backlog";
import { type Ctx, deadline } from "./ctx";
import { type QuotaResult, evaluateQuota } from "./quota";
import { SUSPEND_GAP_MS } from "./suspend";

export const STOP_MARGIN_MS = 20 * 60_000;
export const MAX_CONSECUTIVE_FAILURES = 2;
export const QUOTA_RECHECK_MS = 10 * 60_000;
export const QUOTA_RESET_SLACK_MS = 2 * 60_000;
export const NO_PROGRESS_MS = 60 * 60_000;
export const IDENTICAL_FAILURE_LIMIT = 3;

export interface Stop {
  reason: string;
  detail?: string;
}

/** London wall-clock time, e.g. "03:12 BST". */
export function bst(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(ms);
}

/** `omp usage --json` (read-only, zero model tokens) -> evaluateQuota; logs a `quota` event. */
export async function checkQuota(ctx: Ctx): Promise<QuotaResult> {
  const res = evaluateQuota(await ctx.readUsage(), ctx.run.floors, ctx.buildProviders, ctx.run.reservePct);
  ctx.ledger.log(
    "quota",
    res.ok
      ? { ok: true, floors: ctx.run.floors }
      : {
          ok: false,
          reason: res.reason,
          detail: res.detail,
          ...(res.reason === "quota_wait"
            ? { provider: res.provider, window: res.window, resetsAt: res.resetsAt === null ? null : new Date(res.resetsAt).toISOString() }
            : {}),
        },
  );
  return res;
}

/**
 * Quota never stops a run: `quota_wait` becomes a sleep until the earliest reset (+ slack, re-checking every
 * QUOTA_RECHECK_MS), 7d windows included. Waiting toward a known future reset is not working time, so it extends the
 * safety cap and counts as progress; an explicit `stopAt` override stays wall-clock and ends the run, and a window with
 * no reset time (or stale usage after one) is bounded by the cap / the 60 min no-progress limit. Only unreadable usage
 * (`quota_unknown`) is returned as a stop.
 */
export async function waitForQuota(ctx: Ctx, first: QuotaResult): Promise<Stop | null> {
  let q = first;
  let logged: number | null | undefined;
  for (;;) {
    if (q.ok) return null;
    if (q.reason !== "quota_wait") return { reason: q.reason, detail: q.detail };
    const now = ctx.clock.now();
    if (now - ctx.progressAt >= NO_PROGRESS_MS) {
      return { reason: "safety_cap", detail: `no progress for ${Math.round((now - ctx.progressAt) / 60_000)} min (quota ${q.resetsAt === null ? "reset time unknown" : "usage stale after reset"})` };
    }
    const target = q.resetsAt === null ? null : q.resetsAt + QUOTA_RESET_SLACK_MS;
    const real = target !== null && target > now; // a genuine wait toward a future reset
    const until = real ? target : now + QUOTA_RECHECK_MS;
    const resetText = q.resetsAt === null ? "reset time unknown" : `resets ${bst(q.resetsAt)}`;
    if (ctx.stopAtMs !== null && until > ctx.stopAtMs - STOP_MARGIN_MS) {
      return { reason: "stopAt", detail: `quota ${q.provider} ${q.window} ${resetText}, after stopAt ${bst(ctx.stopAtMs)}` };
    }
    if (!real && until > ctx.capAtMs - STOP_MARGIN_MS) {
      return { reason: "safety_cap", detail: `quota ${q.provider} ${q.window} ${resetText}, safety cap ${bst(ctx.capAtMs)}` };
    }
    if (logged !== q.resetsAt) {
      ctx.ledger.log("quota_wait", {
        provider: q.provider,
        window: q.window,
        resetsAt: q.resetsAt === null ? null : new Date(q.resetsAt).toISOString(),
        message: `build chain exhausted; waiting for ${q.provider} ${q.window} ${resetText}${real ? " (+2 min)" : ""}`,
      });
      logged = q.resetsAt;
    }
    if (ctx.dryRun) return { reason: "quota_wait", detail: q.detail };
    const slept = Math.min(QUOTA_RECHECK_MS, until - now);
    await ctx.clock.sleep(slept);
    const late = ctx.clock.now() - now - slept; // a sleep that overshoots by minutes means the host was suspended
    if (late >= SUSPEND_GAP_MS) ctx.noteSuspend(late, "quota_wait");
    if (real) {
      ctx.progressAt = ctx.clock.now();
      ctx.capAtMs += slept; // waiting for a quota reset does not use up the safety cap
    }
    q = await checkQuota(ctx);
  }
}

/** Deadline, no-progress and run-token safety limits, then max PRs, consecutive failures and quota. */
export async function checkStop(ctx: Ctx, chunks: Chunk[], consecutiveFailures: number): Promise<Stop | null> {
  const now = ctx.clock.now();
  const d = deadline(ctx);
  const left = d.atMs - now;
  if (left <= STOP_MARGIN_MS) {
    return { reason: d.reason, detail: `${Math.round(left / 60_000)} min to ${new Date(d.atMs).toISOString()}` };
  }
  if (now - ctx.progressAt >= NO_PROGRESS_MS) {
    return { reason: "safety_cap", detail: `no progress for ${Math.round((now - ctx.progressAt) / 60_000)} min` };
  }
  const tokenCap = ctx.run.limits.tokenCap * chunks.length;
  if (ctx.runTokens > tokenCap) return { reason: "safety_cap", detail: `run tokens ${ctx.runTokens} > ${tokenCap}` };
  const prs = chunks.filter((c) => c.status === "passed" || c.status === "flaky").length;
  if (prs >= ctx.run.maxPrs) return { reason: "max_prs", detail: `${prs} >= ${ctx.run.maxPrs}` };
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return { reason: "consecutive_failures", detail: `${consecutiveFailures} failed in a row` };
  }
  return waitForQuota(ctx, await checkQuota(ctx));
}
