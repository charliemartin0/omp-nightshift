import type { Chunk } from "./backlog";
import { type Ctx, deadline } from "./ctx";
import { type QuotaResult, evaluateQuota } from "./quota";

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

function recordQuota(ctx: Ctx, res: QuotaResult, chunk?: string): QuotaResult {
  ctx.ledger.log(
    "quota",
    {
      ...(chunk ? { chunk } : {}),
      ...(res.ok
        ? { ok: true, floors: ctx.run.floors }
        : {
            ok: false,
            reason: res.reason,
            detail: res.detail,
            ...(res.reason === "quota_wait"
              ? { provider: res.provider, window: res.window, resetsAt: new Date(res.resetsAt).toISOString() }
              : {}),
          }),
    },
  );
  return res;
}

/** `omp usage --json` (read-only, zero model tokens) -> evaluateQuota; logs a `quota` event (tagged with the asking chunk). */
export async function checkQuota(ctx: Ctx, chunk?: string): Promise<QuotaResult> {
  return recordQuota(ctx, evaluateQuota(await ctx.readUsage(), ctx.run.floors, ctx.buildProviders, ctx.run.reservePct), chunk);
}

/**
 * Turns a `quota_wait` into a sleep until the earliest reset (+ slack, re-checking every QUOTA_RECHECK_MS), never
 * past the effective deadline. Real future-reset sleeps count as progress; stale usage rechecks do not.
 */
export async function waitForQuota(ctx: Ctx, first: QuotaResult): Promise<Stop | null> {
  let q = first;
  let logged: number | null = null;
  for (;;) {
    if (q.ok) return null;
    if (q.reason !== "quota_wait") return { reason: q.reason, detail: q.detail };
    const now = ctx.clock.now();
    if (now - ctx.progressAt >= NO_PROGRESS_MS) {
      return { reason: "safety_cap", detail: `no progress for ${Math.round((now - ctx.progressAt) / 60_000)} min (quota usage stale after reset)` };
    }
    const target = q.resetsAt + QUOTA_RESET_SLACK_MS;
    const until = target > now ? target : now + QUOTA_RECHECK_MS; // reset passed but usage still stale
    const d = deadline(ctx);
    if (until > d.atMs - STOP_MARGIN_MS) {
      return { reason: d.reason, detail: `quota ${q.provider} ${q.window} resets ${bst(q.resetsAt)}, after ${d.reason} ${bst(d.atMs)}` };
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
    if (target > now) ctx.progressAt = ctx.clock.now();
    q = await checkQuota(ctx);
  }
}

/** Deadline, no-progress and run-token safety limits, then max PRs and consecutive failures (Extract Method; no quota). */
function checkLimits(ctx: Ctx, chunks: Chunk[], consecutiveFailures: number): Stop | null {
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
  return null;
}

/** Deadline, no-progress and run-token safety limits, then max PRs, consecutive failures and quota. */
export async function checkStop(ctx: Ctx, chunks: Chunk[], consecutiveFailures: number): Promise<Stop | null> {
  return checkLimits(ctx, chunks, consecutiveFailures) ?? waitForQuota(ctx, await checkQuota(ctx));
}

/**
 * checkStop while `running` chunks are in flight, without ever sleeping: quota waits, insufficient headroom for
 * the next concurrent slot, or running chunks that could still reach maxPrs hold dispatch until a chunk finishes.
 */
export async function checkDispatch(ctx: Ctx, chunks: Chunk[], consecutiveFailures: number, running: number): Promise<Stop | "hold" | null> {
  const stop = checkLimits(ctx, chunks, consecutiveFailures);
  if (stop) return stop;
  if (chunks.filter((c) => c.status === "passed" || c.status === "flaky").length + running >= ctx.run.maxPrs) return "hold";
  const usage = await ctx.readUsage();
  const q = recordQuota(ctx, evaluateQuota(usage, ctx.run.floors, ctx.buildProviders, ctx.run.reservePct));
  if (!q.ok) return q.reason === "quota_wait" ? "hold" : { reason: q.reason, detail: q.detail };

  const slots = running + 1;
  // Divide allowable consumption across slots, rather than multiplying remaining thresholds beyond 100%.
  const floors = slots === 1 ? ctx.run.floors : Object.fromEntries(
    Object.entries(ctx.run.floors).map(([provider, floor]) => [provider, 1 - (1 - floor) / slots]),
  );
  const reservePct = slots === 1 ? ctx.run.reservePct : (1 - (1 - ctx.run.reservePct / 100) / slots) * 100;
  const admission = slots === 1 ? q : evaluateQuota(usage, floors, ctx.buildProviders, reservePct);
  ctx.ledger.log("quota_admission", {
    slots,
    floors,
    reservePct,
    ok: admission.ok,
    ...(!admission.ok ? { reason: admission.reason, detail: admission.detail } : {}),
  });
  return admission.ok ? null : "hold";
}
