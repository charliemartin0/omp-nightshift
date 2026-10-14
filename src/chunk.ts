import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AgentRun, type OmpMode, newestSessionFile, runOmp, sessionsDir } from "./agent";
import type { Chunk, Status } from "./backlog";
import { type Ctx, oneLine } from "./ctx";
import { runGate } from "./gate";
import { commonDir, freePath, git, gitOut, originUrl, parseRemote, pickBranch, trunkBase } from "./git";
import { STALL_RESUME_MESSAGE, fixResumeMessage, renderChunkPrompt } from "./prompt";
import { spawnGroup } from "./proc";
import { beginSetup } from "./setup";
import { checkQuota } from "./stops";

export const ENV_BLOCK_RE = /\b(chrom(e|ium)|playwright|browser|docker|socket|permission denied|EACCES|ENOENT|command not found|not installed|ECONNREFUSED|connection refused|daemon|MCP)\b|fail(ed|s)? to (start|launch|connect|initiali[sz]e)|cannot (start|launch|connect|initiali[sz]e)/i;

/** Explicit env prefix wins; old agent notes get a bounded keyword fallback. */
export function classifyBlocked(reason: string): string {
  return /^env:/i.test(reason) || ENV_BLOCK_RE.test(reason) ? `env: ${reason.replace(/^env:\s*/i, "")}` : reason;
}
export const isEnvNote = (note: string): boolean => note.startsWith("env: ");

export interface ChunkPlan {
  chunk: Chunk;
  branch: string;
  /** git ref the branch is created from */
  base: string;
  /** expected PR base branch */
  prBase: string;
  wt: string;
}
export interface Outcome {
  status: Status;
  note: string;
  /** set when the whole run must stop (e.g. quota gone after a failed gate) */
  stopReason?: string;
  stopDetail?: string;
  /** quota death: chunk goes back to pending and is retried after the quota wait */
  requeue?: boolean;
}

/** Unambiguous trip cause: names the limit that fired and the ones that did not (a timeout is not a token cap). */
export function tripNote(ctx: Ctx, r: AgentRun): string {
  const min = (ms: number) => Math.round(ms / 60_000);
  const tokens = `${r.tokens} of ${ctx.run.limits.tokenCap} tokens`;
  const suspended = r.suspendMs > 0 ? `, ${min(r.suspendMs)} min host suspend excluded` : "";
  if (r.trip === "token_cap") return `watchdog token_cap: ${tokens} used (cap reached)`;
  if (r.trip === "stall") return `watchdog stall: no output for ${ctx.run.limits.stallMinutes} min${suspended}; ${tokens} (cap not reached)`;
  return `watchdog timeout: ran ${min(r.elapsedMs)} min awake against a ${min(r.hardMs)} min wall-clock limit${suspended}; ${tokens} (cap not reached)`;
}

class SetupFailure extends Error {
  constructor(public readonly reason: string, detail: string) {
    super(`${reason}: ${oneLine(detail).slice(0, 200)}`);
  }
}

/** Branch/base/worktree for a chunk. Dry-run uses a `_dry-` worktree name so it never touches a real one. */
export async function planChunk(ctx: Ctx, chunk: Chunk, lastBranch: string | null): Promise<ChunkPlan> {
  const { run } = ctx;
  const stacked = run.prMode === "stack" && lastBranch !== null;
  mkdirSync(run.worktreeRoot, { recursive: true });
  return {
    chunk,
    branch: await pickBranch(run.repo, run.date, chunk.id),
    base: stacked ? lastBranch : (await trunkBase(run)).ref,
    prBase: stacked ? lastBranch : run.trunk,
    wt: freePath(realpathSync(run.worktreeRoot), `${ctx.dryRun ? "_dry-" : ""}${chunk.id}`),
  };
}

export async function fetchTrunk(ctx: Ctx): Promise<string | null> {
  const { run } = ctx;
  if (!(await trunkBase(run)).fetch) return null;
  const f = await git(run.repo, ["fetch", "--quiet", run.remote, run.trunk], { timeoutMs: 300_000 });
  return f.code === 0 ? null : f.stderr;
}

/** setupCommand in the worktree -> logs/<id>-setup.log. Returns an error detail, or null on success. */
export async function runSetupCommand(ctx: Ctx, chunkId: string, wt: string): Promise<string | null> {
  const { run } = ctx;
  if (!run.setupCommand.trim()) return null;
  const r = await spawnGroup(["bash", "-lc", run.setupCommand], {
    cwd: wt,
    timeoutMs: run.limits.testTimeoutMinutes * 60_000,
    onSuspend: (gap) => ctx.noteSuspend(gap, "setup", chunkId),
    logFile: join(ctx.logs, `${chunkId}-setup.log`),
  });
  return r.code === 0 && !r.timedOut ? null : `${r.timedOut ? "timed out" : `exit ${r.code}`}; see logs/${chunkId}-setup.log`;
}

/** Fetch, create branch + worktree, gt track: the shared-repository steps. Returns a failure, or null on success. */
async function createWorktree(ctx: Ctx, plan: ChunkPlan, setup: string): Promise<SetupFailure | null> {
  const { run } = ctx;
  const fetchErr = await fetchTrunk(ctx);
  if (fetchErr !== null) return new SetupFailure("fetch_failed", fetchErr);
  const baseSha = await gitOut(run.repo, ["rev-parse", "--verify", `${plan.base}^{commit}`]);
  const commonGitDir = await commonDir(run.repo);
  // This synchronous ownership write must precede add: a killed add may leave only its branch or registration.
  ctx.ledger.log("setup_intent", {
    chunk: plan.chunk.id, setup, dryRun: false, wt: plan.wt, root: dirname(plan.wt),
    branch: plan.branch, ref: `refs/heads/${plan.branch}`, base: plan.base, baseSha, commonGitDir,
  });
  // --no-track: no upstream write to the shared .git/config, which agents' `git push -u` may hold locked.
  const add = await git(run.repo, ["worktree", "add", "--no-track", "-b", plan.branch, plan.wt, baseSha]);
  if (add.code !== 0) return new SetupFailure("worktree_failed", add.stderr);
  if (run.forge === "graphite") {
    const t = await spawnGroup(["gt", "track", "--no-interactive", "--parent", plan.prBase, plan.branch], {
      cwd: plan.wt,
      timeoutMs: 120_000,
    });
    if (t.code !== 0) return new SetupFailure("gt_track_failed", t.stderr || t.stdout);
  }
  return null;
}

function readBlocked(wt: string): string | null {
  const file = join(wt, ".overnight-status");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").trimStart();
  if (!text.startsWith("BLOCKED:")) return null;
  return classifyBlocked(oneLine(text.split("\n")[0].slice("BLOCKED:".length)) || "no reason given");
}

/** Agent run, stall/fix resumes, and the independent gate for one set-up chunk. */
async function executeChunk(ctx: Ctx, plan: ChunkPlan, startSha: string): Promise<Outcome> {
  const { chunk, wt } = plan;
  const { run } = ctx;
  const slug = run.forge === "local" ? "" : parseRemote(await originUrl(run.repo, run.remote)).ownerRepo;
  let n = 0;
  let tokens = 0;
  let sessionId: string | null = null;
  const fail = (note: string): Outcome => ({ status: "failed", note });

  const invoke = async (mode: OmpMode): Promise<AgentRun> => {
    const r = await runOmp(ctx, { chunk: chunk.id, wt, n: ++n, mode, tokensUsed: tokens });
    tokens = r.tokens;
    sessionId = r.sessionId ?? sessionId;
    return r;
  };
  /** Resume the chunk's session; null when no session can be found. */
  const resume = async (message: string): Promise<AgentRun | null> => {
    const session = sessionId ?? newestSessionFile(sessionsDir(ctx, chunk.id));
    return session ? invoke({ kind: "resume", session, message }) : null;
  };
  const requeue = (r: AgentRun): Outcome => ({
    status: "pending",
    note: `requeued: quota error: ${oneLine(r.quotaError ?? "").slice(0, 150)}`,
    requeue: true,
  });
  const tripped = (r: AgentRun): Outcome => fail(tripNote(ctx, r));

  let r = await invoke({ kind: "initial", promptFile: join(ctx.prompts, `${chunk.id}.md`) });
  if (r.quotaError) return requeue(r);
  if (r.trip === "stall") {
    const again = await resume(STALL_RESUME_MESSAGE);
    if (!again) return fail("no_session_to_resume");
    r = again;
    if (r.quotaError) return requeue(r);
  }
  if (r.trip) return tripped(r);
  let blocked = readBlocked(wt);
  if (blocked) return { status: "blocked", note: blocked };

  const gateInput = { ctx, chunk, wt, branch: plan.branch, startSha, prBase: plan.prBase, slug };
  let gate = await runGate(gateInput);
  if (!gate.ok) {
    const q = await checkQuota(ctx, chunk.id);
    if (!q.ok && q.reason === "quota_wait") {
      return { status: "pending", note: `requeued: gate failed, then quota_wait: ${q.detail}`, requeue: true };
    }
    if (!q.ok) {
      return { status: "failed", note: `gate failed, then ${q.reason}: ${q.detail}`, stopReason: q.reason, stopDetail: q.detail };
    }
    const fixed = await resume(fixResumeMessage(gate.failures));
    if (!fixed) return fail("no_session_to_resume");
    if (fixed.quotaError) return requeue(fixed);
    if (fixed.trip) return tripped(fixed);
    blocked = readBlocked(wt);
    if (blocked) return { status: "blocked", note: blocked };
    gate = await runGate(gateInput);
    if (!gate.ok) return fail(`gate failed: ${gate.failures.map((f) => f.split("\n")[0]).join("; ")}`);
  }
  return { status: gate.flaky ? "flaky" : "passed", note: gate.note };
}

/** Full lifecycle of one chunk; always ends with a backlog status update and a `chunk_end` ledger line. */
export async function runChunk(ctx: Ctx, chunk: Chunk, lastBranch: string | null): Promise<Outcome & { branch: string }> {
  const setupId = beginSetup(ctx, chunk.id);
  // Planning picks a free branch and worktree path that `git worktree add` then claims: one locked step, so parallel
  // chunks never take the same names and the runner's fetch, ref and gt track updates never race each other.
  // setupCommand runs unlocked.
  const { plan, failure } = await ctx.repoLock(async () => {
    const plan = await planChunk(ctx, chunk, lastBranch);
    return { plan, failure: await createWorktree(ctx, plan, setupId) };
  });
  let startSha = "";
  const end = async (o: Outcome) => {
    const files = startSha ? (await git(plan.wt, ["diff", "--name-only", `${startSha}..HEAD`])).stdout.split("\n").filter(Boolean) : [];
    ctx.setStatus(chunk.id, o.status, o.note);
    ctx.running.delete(chunk.id);
    ctx.settingUp.delete(chunk.id);
    ctx.ledger.log("chunk_end", { chunk: chunk.id, status: o.status, note: o.note, changedFiles: files });
    return { ...o, branch: plan.branch };
  };

  let setup = failure;
  if (!setup) {
    const setupErr = await runSetupCommand(ctx, chunk.id, plan.wt);
    if (setupErr !== null) setup = new SetupFailure("setup_failed", setupErr);
  }
  if (setup) return end(["fetch_failed", "setup_failed"].includes(setup.reason)
    ? { status: "blocked", note: `env: ${setup.message}` }
    : { status: "failed", note: setup.message });
  startSha = await gitOut(plan.wt, ["rev-parse", "HEAD"]);
  writeFileSync(join(ctx.prompts, `${chunk.id}.md`), renderChunkPrompt(ctx.run, chunk, plan));
  mkdirSync(sessionsDir(ctx, chunk.id), { recursive: true });
  ctx.setStatus(chunk.id, "running", "");
  ctx.settingUp.delete(chunk.id);
  ctx.running.add(chunk.id);
  ctx.ledger.log("chunk_start", { chunk: chunk.id, setup: setupId, branch: plan.branch, base: plan.base, wt: plan.wt });
  return end(await executeChunk(ctx, plan, startSha));
}
