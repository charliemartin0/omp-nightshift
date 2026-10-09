import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBacklog } from "./backlog";
import { type Ctx, deadline } from "./ctx";
import { originUrl, parseRemote } from "./git";
import { type LedgerEntry, readLedger } from "./ledger";
import { errMsg, spawnGroup } from "./proc";
import { checkQuota, STOP_MARGIN_MS } from "./stops";

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** Read-only draft-PR review, limited to successful chunks from this launch, without waiting for quota. */
export async function selfReview(ctx: Ctx): Promise<void> {
  if (ctx.run.forge === "local") return;
  const entries = readLedger(ctx.ledger.file);
  const segment = entries.slice(Math.max(0, entries.findLastIndex((e) => e.event === "run_start")));
  const starts = new Map<string, LedgerEntry>();
  const ends = new Map<string, LedgerEntry>();
  const gates = new Map<string, LedgerEntry>();
  for (const e of segment) {
    if (!e.chunk) continue;
    if (e.event === "chunk_start") {
      starts.set(e.chunk, e);
      gates.delete(e.chunk);
    } else if (e.event === "chunk_end") ends.set(e.chunk, e);
    else if (e.event === "gate" && e.ok === true) gates.set(e.chunk, e);
  }
  const chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
  let slug: string | undefined;
  const reviews = join(ctx.run.runDir, "reviews");
  for (const chunk of chunks) {
    const end = ends.get(chunk.id);
    if (!end || !["passed", "flaky"].includes(String(end.status))) continue;
    const pr = record(record(record(gates.get(chunk.id)?.checks)?.pr)?.pr);
    if (!pr || typeof pr.number !== "number") continue;
    const log = (ok: boolean, fields: Record<string, unknown>) => ctx.ledger.log("self_review", { chunk: chunk.id, pr: pr.number, ok, ...fields });
    if (ctx.clock.now() > deadline(ctx).atMs - STOP_MARGIN_MS) {
      log(false, { detail: "skipped: past deadline" });
      break;
    }
    const quota = await checkQuota(ctx);
    if (!quota.ok) {
      log(false, { detail: `skipped: quota ${quota.reason}` });
      break;
    }
    const start = starts.get(chunk.id);
    const wt = typeof start?.wt === "string" ? start.wt : "";
    if (!wt || !existsSync(wt)) {
      log(false, { detail: "worktree missing" });
      continue;
    }
    try {
      slug ??= parseRemote(await originUrl(ctx.run.repo, ctx.run.remote)).ownerRepo;
      mkdirSync(reviews, { recursive: true });
      const path = join(reviews, `${chunk.id}.md`);
      const prompt = join(ctx.prompts, `${chunk.id}-review.md`);
      writeFileSync(prompt, `Read-only self-review of draft PR #${pr.number} (${typeof pr.url === "string" ? pr.url : ""}) for overnight chunk ${chunk.id}. Use the task tool to run exactly one \`reviewer\` subagent. Give it the output of \`git -C ${JSON.stringify(wt)} diff ${JSON.stringify(String(start?.base ?? ctx.run.trunk))}...HEAD\` and the PR description from \`gh pr view ${pr.number} --repo ${slug} --json body -q .body\`. Ask it to list, as P0–P3 bullets, mismatches between the description and the diff, risky changes, and missing tests. Write its findings (≤200 words) to ${path}. Never comment on, review, edit, approve, mark ready or push the PR; modify no file except that one.\n`);
      rmSync(path, { force: true }); // A previous launch's review must not count as this invocation's output.
      const r = await spawnGroup(["omp", "-p", "--model", ctx.run.models.report, "--config", ctx.overlay, "--no-session", "--no-title", "--cwd", wt, `@${prompt}`], { cwd: wt, timeoutMs: 20 * 60_000, logFile: join(ctx.logs, `${chunk.id}-review.log`) });
      const ok = existsSync(path) && readFileSync(path, "utf8").trim().length > 0;
      log(ok, ok ? { path } : { detail: r.timedOut ? "timed out; review missing or empty" : `exit ${r.code}; review missing or empty` });
    } catch (e) { log(false, { detail: errMsg(e) }); }
  }
}
