import type { Chunk } from "./backlog";
import type { Ctx } from "./ctx";
import { spawnGroup } from "./proc";
import { type QuotaResult, evaluateQuota } from "./quota";

export const STOP_MARGIN_MS = 20 * 60_000;
export const MAX_CONSECUTIVE_FAILURES = 2;

export interface Stop {
  reason: string;
  detail?: string;
}

/** `omp usage --json` (read-only, zero model tokens) -> evaluateQuota; logs a `quota` event. */
export async function checkQuota(ctx: Ctx): Promise<QuotaResult> {
  const r = await spawnGroup(["omp", "usage", "--json"], { cwd: ctx.run.repo, timeoutMs: 60_000 });
  let usage: unknown = null;
  try {
    usage = JSON.parse(r.stdout);
  } catch {
    /* unparseable -> evaluateQuota reports quota_unknown */
  }
  const res = evaluateQuota(usage, ctx.run.floors);
  ctx.ledger.log("quota", res.ok ? { ok: true, floors: ctx.run.floors } : { ok: false, reason: res.reason, detail: res.detail });
  return res;
}

/** Stop conditions in plan order: stop_time, max_prs, consecutive_failures, then quota. */
export async function checkStop(ctx: Ctx, chunks: Chunk[], consecutiveFailures: number): Promise<Stop | null> {
  const left = ctx.stopAtMs - Date.now();
  if (left <= STOP_MARGIN_MS) {
    return { reason: "stop_time", detail: `${Math.round(left / 60_000)} min to ${new Date(ctx.stopAtMs).toISOString()}` };
  }
  const prs = chunks.filter((c) => c.status === "passed" || c.status === "flaky").length;
  if (prs >= ctx.run.maxPrs) return { reason: "max_prs", detail: `${prs} >= ${ctx.run.maxPrs}` };
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return { reason: "consecutive_failures", detail: `${consecutiveFailures} failed in a row` };
  }
  const q = await checkQuota(ctx);
  return q.ok ? null : { reason: q.reason, detail: q.detail };
}
