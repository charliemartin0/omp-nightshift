import type { Chunk } from "./backlog";
import type { Ctx } from "./ctx";
import { type QuotaResult, evaluateQuota } from "./quota";

export const STOP_MARGIN_MS = 20 * 60_000;
export const MAX_CONSECUTIVE_FAILURES = 2;
export const QUOTA_RECHECK_MS = 10 * 60_000;
export const QUOTA_RESET_SLACK_MS = 2 * 60_000;

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
            ? { provider: res.provider, window: res.window, resetsAt: new Date(res.resetsAt).toISOString() }
            : {}),
        },
  );
  return res;
}

/**
 * Turns a `quota_wait` into a sleep until the earliest reset (+ slack, re-checking every QUOTA_RECHECK_MS), never
 * past the stop time. Any other failure is a stop; dry runs never sleep.
 */
export async function waitForQuota(ctx: Ctx, first: QuotaResult): Promise<Stop | null> {
  let q = first;
  let logged: number | null = null;
  for (;;) {
    if (q.ok) return null;
    if (q.reason !== "quota_wait") return { reason: q.reason, detail: q.detail };
    const now = ctx.clock.now();
    const target = q.resetsAt + QUOTA_RESET_SLACK_MS;
    const until = target > now ? target : now + QUOTA_RECHECK_MS; // reset passed but usage still stale
    if (until > ctx.stopAtMs - STOP_MARGIN_MS) {
      return { reason: "stop_time", detail: `quota ${q.provider} ${q.window} resets ${bst(q.resetsAt)}, after stop ${bst(ctx.stopAtMs)}` };
    }
    if (logged !== q.resetsAt) {
      ctx.ledger.log("quota_wait", {
        provider: q.provider,
        window: q.window,
        resetsAt: new Date(q.resetsAt).toISOString(),
        message: `build chain exhausted; waiting for ${q.provider} ${q.window} reset at ${bst(q.resetsAt)} (+2 min)`,
      });
      logged = q.resetsAt;
    }
    if (ctx.dryRun) return { reason: "quota_wait", detail: q.detail };
    await ctx.clock.sleep(Math.min(QUOTA_RECHECK_MS, until - now));
    q = await checkQuota(ctx);
  }
}

/** Stop conditions in plan order: stop_time, max_prs, consecutive_failures, then quota (waiting out short windows). */
export async function checkStop(ctx: Ctx, chunks: Chunk[], consecutiveFailures: number): Promise<Stop | null> {
  const left = ctx.stopAtMs - ctx.clock.now();
  if (left <= STOP_MARGIN_MS) {
    return { reason: "stop_time", detail: `${Math.round(left / 60_000)} min to ${new Date(ctx.stopAtMs).toISOString()}` };
  }
  const prs = chunks.filter((c) => c.status === "passed" || c.status === "flaky").length;
  if (prs >= ctx.run.maxPrs) return { reason: "max_prs", detail: `${prs} >= ${ctx.run.maxPrs}` };
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return { reason: "consecutive_failures", detail: `${consecutiveFailures} failed in a row` };
  }
  return waitForQuota(ctx, await checkQuota(ctx));
}
