import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompArgv } from "./agent";
import type { Chunk } from "./backlog";
import { fetchTrunk, planChunk, runSetupCommand } from "./chunk";
import type { Ctx } from "./ctx";
import { commonDir, git, gitOut, trunkBase } from "./git";
import { renderChunkPrompt } from "./prompt";
import { beginSetup } from "./setup";

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
  const setup = beginSetup(ctx, chunk.id);
  const fail = (note: string) => {
    ctx.settingUp.delete(chunk.id);
    ledger.log("chunk_end", { chunk: chunk.id, status: "failed", note, changedFiles: [] });
    return null;
  };

  // The same locked plan + worktree claim as a real chunk, so parallel dry runs never share a worktree path.
  const { plan, error } = await ctx.repoLock(async () => {
    const plan = await planChunk(ctx, chunk, lastBranch);
    ledger.log("chunk_start", { chunk: chunk.id, setup, dryRun: true, branch: plan.branch, base: plan.base, wt: plan.wt });
    const fetchErr = await fetchTrunk(ctx);
    if (fetchErr !== null) return { plan, error: `fetch_failed: ${fetchErr.trim()}` };
    const baseSha = await gitOut(run.repo, ["rev-parse", "--verify", `${(await trunkBase(run)).ref}^{commit}`]);
    ledger.log("setup_intent", { chunk: chunk.id, setup, dryRun: true, wt: plan.wt, root: dirname(plan.wt), branch: null, ref: null, baseSha, commonGitDir: await commonDir(run.repo) });
    const add = await git(run.repo, ["worktree", "add", "--detach", plan.wt, baseSha]);
    if (add.code !== 0) return { plan, error: `worktree_failed: ${add.stderr.trim()}` };
    created.push(plan.wt);
    return { plan, error: null };
  });
  if (error !== null) return fail(error);
  if (index === 0) {
    const setupErr = await runSetupCommand(ctx, chunk.id, plan.wt);
    if (setupErr !== null) return fail(`setup_failed: ${setupErr}`);
  }
  const promptFile = join(ctx.prompts, `${chunk.id}.md`);
  writeFileSync(promptFile, renderChunkPrompt(run, chunk, plan));
  mkdirSync(join(ctx.sessions, chunk.id), { recursive: true });
  ledger.log("dry_run_omp", { chunk: chunk.id, argv: ompArgv(ctx, chunk.id, plan.wt, { kind: "initial", promptFile }) });
  ctx.settingUp.delete(chunk.id);
  ledger.log("chunk_end", { chunk: chunk.id, status: "dry_run", note: "no omp session started", changedFiles: [] });
  return plan.branch;
}
