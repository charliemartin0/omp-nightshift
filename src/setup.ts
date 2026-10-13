import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { parseBacklog } from "./backlog";
import type { Ctx } from "./ctx";
import { commonDir, git } from "./git";
import { type LedgerEntry, readLedger } from "./ledger";
import { errMsg } from "./proc";

const SETUP_SIGNAL_NOTE = "stopped by signal during setup";

/** Synchronous admission, before planning or waiting for the repository lock. */
export function beginSetup(ctx: Ctx, chunk: string): string {
  const setup = randomUUID();
  ctx.settingUp.add(chunk);
  ctx.ledger.log("setup_begin", { chunk, setup, dryRun: ctx.dryRun });
  return setup;
}

/** Called only after subprocess shutdown, so no setup can transition to running underneath it. */
export function markInterrupted(ctx: Ctx): void {
  const running = [...ctx.running];
  const settingUp = [...ctx.settingUp].filter((id) => !ctx.running.has(id));
  for (const chunk of settingUp) {
    ctx.setStatus(chunk, "stopped", SETUP_SIGNAL_NOTE);
    ctx.ledger.log("chunk_end", { chunk, status: "stopped", note: SETUP_SIGNAL_NOTE, phase: "setup", changedFiles: [] });
  }
  for (const chunk of running) {
    const note = "stopped by signal during agent execution";
    ctx.setStatus(chunk, "stopped", note);
    ctx.ledger.log("chunk_end", { chunk, status: "stopped", note, phase: "running", changedFiles: [] });
  }
  ctx.settingUp.clear();
  ctx.running.clear();
  ctx.ledger.log("stop", { reason: "signal", chunks: [...settingUp, ...running], settingUp, running });
}

interface PendingSetup {
  chunk: string;
  setup: string;
  intent?: LedgerEntry;
}

interface Worktree {
  path: string;
  head?: string;
  branch?: string;
}

/** Unmatched ownership only: starting an agent or explicitly ending a chunk relinquishes recovery rights. */
function unfinished(entries: LedgerEntry[]): PendingSetup[] {
  const pending = new Map<string, PendingSetup>();
  for (const entry of entries) {
    if (typeof entry.chunk !== "string") continue;
    if (entry.event === "setup_begin" && entry.dryRun === false && typeof entry.setup === "string") {
      pending.set(entry.chunk, { chunk: entry.chunk, setup: entry.setup });
      continue;
    }
    const current = pending.get(entry.chunk);
    if (!current) continue;
    if (entry.event === "setup_intent" && entry.setup === current.setup) current.intent = entry;
    if (entry.event === "chunk_start"
      || (entry.event === "chunk_end" && !(entry.status === "stopped" && entry.phase === "setup"))
      || (entry.event === "setup_recovered" && entry.setup === current.setup)) pending.delete(entry.chunk);
  }
  return [...pending.values()];
}

/** Refuse path/ref tricks even when a ledger contains a plausible-looking ownership entry. */
async function cleanIntent(ctx: Ctx, entry: LedgerEntry): Promise<{ resolution: "removed" | "absent" | "retained"; reason: string }> {
  const retain = (reason: string) => ({ resolution: "retained" as const, reason });
  const { wt, branch, ref, baseSha, chunk, root } = entry;
  if (entry.dryRun !== false || typeof chunk !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(chunk)
    || typeof wt !== "string" || typeof branch !== "string" || typeof baseSha !== "string"
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseSha)) return retain("invalid ownership intent");
  if (entry.commonGitDir !== await commonDir(ctx.run.repo)) return retain("ownership belongs to a different common Git directory");
  const branchBase = `overnight/${ctx.run.date}-${chunk}`;
  const suffix = branch.slice(branchBase.length);
  if (!branch.startsWith(branchBase) || (suffix !== "" && !/^-(?:[2-9]|[1-9][0-9]+)$/.test(suffix))
    || ref !== `refs/heads/${branch}`) return retain("unexpected branch/ref");
  if (!existsSync(ctx.run.worktreeRoot)) return retain("worktree root missing");
  const canonicalRoot = realpathSync(ctx.run.worktreeRoot);
  const pathSuffix = basename(wt).slice(chunk.length);
  if (root !== canonicalRoot || !isAbsolute(wt) || resolve(wt) !== wt || dirname(wt) !== canonicalRoot
    || !basename(wt).startsWith(chunk) || (pathSuffix !== "" && !/^-(?:[2-9]|[1-9][0-9]+)$/.test(pathSuffix))) return retain("worktree path outside owned root/name");
  if (lstatSync(ctx.run.worktreeRoot).isSymbolicLink()) return retain("symlink worktree root");
  let pathExists = false;
  try {
    const stat = lstatSync(wt);
    pathExists = true;
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(wt) !== wt) return retain("symlink or noncanonical worktree path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const listed = await git(ctx.run.repo, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.code !== 0) return retain("cannot verify worktree registration");
  const worktrees: Worktree[] = listed.stdout.split("\0\0").filter(Boolean).map((block) => {
    const fields = block.split("\0");
    return {
      path: fields.find((field) => field.startsWith("worktree "))?.slice(9) ?? "",
      head: fields.find((field) => field.startsWith("HEAD "))?.slice(5),
      branch: fields.find((field) => field.startsWith("branch "))?.slice(7),
    };
  });
  const registered = worktrees.find((worktree) => worktree.path === wt);
  if (worktrees.some((worktree) => worktree.branch === ref && worktree.path !== wt)) return retain("branch belongs to another worktree");
  const symbolic = await git(ctx.run.repo, ["symbolic-ref", "--quiet", String(ref)]);
  if (symbolic.code !== 1) return retain("symbolic or unverifiable branch ref");
  const branchSha = await git(ctx.run.repo, ["rev-parse", "--verify", "--quiet", String(ref)]);
  const branchExists = branchSha.code === 0;
  if (branchExists && branchSha.stdout.trim() !== baseSha) return retain("branch advanced from setup base");
  if (!branchExists && branchSha.code !== 1) return retain("cannot verify branch");
  if (registered) {
    if (!branchExists || registered.branch !== ref || registered.head !== baseSha) return retain("worktree branch/HEAD changed");
    if (pathExists) {
      if (await commonDir(wt) !== await commonDir(ctx.run.repo)) return retain("worktree Git directory changed");
      const head = await git(wt, ["symbolic-ref", "--quiet", "HEAD"]);
      const status = await git(wt, ["status", "--porcelain", "--untracked-files=all", "--ignored"]);
      if (head.code !== 0 || head.stdout.trim() !== ref || status.code !== 0 || status.stdout.trim()) return retain("worktree has changed, untracked, or ignored files");
    }
    const removed = await git(ctx.run.repo, ["worktree", "remove", "--force", wt]);
    if (removed.code !== 0) return retain(`worktree cleanup refused: ${removed.stderr.trim()}`);
  } else if (pathExists) {
    return retain("unregistered directory is not runner-owned");
  }
  // Compare-and-delete also handles worktree add interrupted after branch creation but before registration.
  if (branchExists) {
    const removed = await git(ctx.run.repo, ["update-ref", "--no-deref", "-d", String(ref), baseSha]);
    if (removed.code !== 0) return retain(`branch cleanup refused: ${removed.stderr.trim()}`);
  }
  return { resolution: registered || branchExists ? "removed" : "absent", reason: "interrupted setup ownership released" };
}

/** Real-run relaunch only; dry-run ledgers never authorise deletion of real resources. */
export async function recoverSetup(ctx: Ctx): Promise<void> {
  if (ctx.dryRun) return;
  const pending = unfinished(readLedger(ctx.ledger.file));
  if (!pending.length) return;
  await ctx.repoLock(async () => {
    const chunks = new Map(parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks.map((chunk) => [chunk.id, chunk]));
    for (const candidate of pending) {
      const chunk = chunks.get(candidate.chunk);
      let result: { resolution: "removed" | "absent" | "retained"; reason: string };
      if (!chunk || (chunk.status !== "pending" && !(chunk.status === "stopped" && chunk.note === SETUP_SIGNAL_NOTE))) {
        result = { resolution: "retained", reason: "chunk is missing or explicitly ended/started" };
      } else if (candidate.intent) {
        try {
          result = await cleanIntent(ctx, candidate.intent);
        } catch (error) {
          result = { resolution: "retained", reason: `ownership verification failed: ${errMsg(error)}` };
        }
      } else {
        result = { resolution: "absent", reason: "setup interrupted before ownership intent" };
      }
      if (result.resolution !== "retained") ctx.setStatus(candidate.chunk, "pending", "recovered interrupted setup");
      ctx.ledger.log("setup_recovered", { chunk: candidate.chunk, setup: candidate.setup, ...result });
    }
  });
}
