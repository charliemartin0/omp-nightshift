import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ompArgv } from "./agent";
import type { Chunk } from "./backlog";
import { fetchTrunk, planChunk, runSetupCommand } from "./chunk";
import type { Ctx } from "./ctx";
import { git, trunkBase } from "./git";
import { renderChunkPrompt } from "./prompt";

/**
 * Dry-run of one chunk: fetch, detached worktree, setupCommand (first chunk only), prompt file, and the exact
 * omp argv in the ledger. Never starts an omp session, never creates a branch, gt track, push or PR.
 * Returns the branch name the real run would have used. Created worktrees are appended to `created`.
 */
export async function dryRunChunk(
  ctx: Ctx,
  chunk: Chunk,
  index: number,
  lastBranch: string | null,
  created: string[],
): Promise<string | null> {
  const { run, ledger } = ctx;
  const plan = await planChunk(ctx, chunk, lastBranch);
  const fail = (note: string) => {
    ledger.log("chunk_end", { chunk: chunk.id, status: "failed", note, changedFiles: [] });
    return null;
  };

  ledger.log("chunk_start", { chunk: chunk.id, dryRun: true, branch: plan.branch, base: plan.base, wt: plan.wt });
  const fetchErr = await fetchTrunk(ctx);
  if (fetchErr !== null) return fail(`fetch_failed: ${fetchErr.trim()}`);
  const add = await git(run.repo, ["worktree", "add", "--detach", plan.wt, (await trunkBase(run)).ref]);
  if (add.code !== 0) return fail(`worktree_failed: ${add.stderr.trim()}`);
  created.push(plan.wt);
  if (index === 0) {
    const setupErr = await runSetupCommand(ctx, chunk.id, plan.wt);
    if (setupErr !== null) return fail(`setup_failed: ${setupErr}`);
  }
  const promptFile = join(ctx.prompts, `${chunk.id}.md`);
  writeFileSync(promptFile, renderChunkPrompt(run, chunk, plan));
  mkdirSync(join(ctx.sessions, chunk.id), { recursive: true });
  ledger.log("dry_run_omp", { chunk: chunk.id, argv: ompArgv(ctx, chunk.id, plan.wt, { kind: "initial", promptFile }) });
  ledger.log("chunk_end", { chunk: chunk.id, status: "dry_run", note: "no omp session started", changedFiles: [] });
  return plan.branch;
}
