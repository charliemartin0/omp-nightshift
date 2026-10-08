import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentRun, type OmpMode, newestSessionFile, runOmp, sessionsDir } from "./agent";
import type { Chunk, Status } from "./backlog";
import { type Ctx, oneLine } from "./ctx";
import { runGate } from "./gate";
import { freePath, git, gitOut, originUrl, parseRemote, pickBranch, trunkBase } from "./git";
import { STALL_RESUME_MESSAGE, fixResumeMessage, renderChunkPrompt } from "./prompt";
import { spawnGroup } from "./proc";
import { checkQuota } from "./stops";

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
}

class SetupFailure extends Error {
  constructor(reason: string, detail: string) {
    super(`${reason}: ${oneLine(detail).slice(0, 200)}`);
  }
}

/** Branch/base/worktree for a chunk. Dry-run uses a `_dry-` worktree name so it never touches a real one. */
export async function planChunk(ctx: Ctx, chunk: Chunk, lastBranch: string | null): Promise<ChunkPlan> {
  const { run } = ctx;
  const stacked = run.prMode === "stack" && lastBranch !== null;
  return {
    chunk,
    branch: await pickBranch(run.repo, run.date, chunk.id),
    base: stacked ? lastBranch : (await trunkBase(run)).ref,
    prBase: stacked ? lastBranch : run.trunk,
    wt: freePath(run.worktreeRoot, `${ctx.dryRun ? "_dry-" : ""}${chunk.id}`),
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
    logFile: join(ctx.logs, `${chunkId}-setup.log`),
  });
  return r.code === 0 && !r.timedOut ? null : `${r.timedOut ? "timed out" : `exit ${r.code}`}; see logs/${chunkId}-setup.log`;
}

/** Fetch, create branch + worktree, gt track, setupCommand. Returns startSha. Throws SetupFailure. */
async function setupChunk(ctx: Ctx, plan: ChunkPlan): Promise<string> {
  const { run } = ctx;
  const fetchErr = await fetchTrunk(ctx);
  if (fetchErr !== null) throw new SetupFailure("fetch_failed", fetchErr);
  const add = await git(run.repo, ["worktree", "add", "-b", plan.branch, plan.wt, plan.base]);
  if (add.code !== 0) throw new SetupFailure("worktree_failed", add.stderr);
  if (run.forge === "graphite") {
    const t = await spawnGroup(["gt", "track", "--no-interactive", "--parent", plan.prBase, plan.branch], {
      cwd: plan.wt,
      timeoutMs: 120_000,
    });
    if (t.code !== 0) throw new SetupFailure("gt_track_failed", t.stderr || t.stdout);
  }
  const setupErr = await runSetupCommand(ctx, plan.chunk.id, plan.wt);
  if (setupErr !== null) throw new SetupFailure("setup_failed", setupErr);
  return gitOut(plan.wt, ["rev-parse", "HEAD"]);
}

function readBlocked(wt: string): string | null {
  const file = join(wt, ".overnight-status");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8").trimStart();
  if (!text.startsWith("BLOCKED:")) return null;
  return oneLine(text.split("\n")[0].slice("BLOCKED:".length)) || "no reason given";
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
  const tripped = (r: AgentRun): Outcome => fail(`watchdog ${r.trip} after ${r.tokens} tokens`);

  let r = await invoke({ kind: "initial", promptFile: join(ctx.prompts, `${chunk.id}.md`) });
  if (r.trip === "stall") {
    const again = await resume(STALL_RESUME_MESSAGE);
    if (!again) return fail("no_session_to_resume");
    r = again;
  }
  if (r.trip) return tripped(r);
  let blocked = readBlocked(wt);
  if (blocked) return { status: "blocked", note: blocked };

  const gateInput = { ctx, chunk, wt, branch: plan.branch, startSha, prBase: plan.prBase, slug };
  let gate = await runGate(gateInput);
  if (!gate.ok) {
    const q = await checkQuota(ctx);
    if (!q.ok) {
      return { status: "failed", note: `gate failed, then ${q.reason}: ${q.detail}`, stopReason: q.reason, stopDetail: q.detail };
    }
    const fixed = await resume(fixResumeMessage(gate.failures));
    if (!fixed) return fail("no_session_to_resume");
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
  const plan = await planChunk(ctx, chunk, lastBranch);
  let startSha = "";
  const end = async (o: Outcome) => {
    const files = startSha ? (await git(plan.wt, ["diff", "--name-only", `${startSha}..HEAD`])).stdout.split("\n").filter(Boolean) : [];
    ctx.setStatus(chunk.id, o.status, o.note);
    ctx.running = null;
    ctx.ledger.log("chunk_end", { chunk: chunk.id, status: o.status, note: o.note, changedFiles: files });
    return { ...o, branch: plan.branch };
  };

  try {
    startSha = await setupChunk(ctx, plan);
  } catch (e) {
    if (e instanceof SetupFailure) return end({ status: "failed", note: e.message });
    throw e;
  }
  writeFileSync(join(ctx.prompts, `${chunk.id}.md`), renderChunkPrompt(ctx.run, chunk, plan));
  mkdirSync(sessionsDir(ctx, chunk.id), { recursive: true });
  ctx.setStatus(chunk.id, "running", "");
  ctx.running = chunk.id;
  ctx.ledger.log("chunk_start", { chunk: chunk.id, branch: plan.branch, base: plan.base, wt: plan.wt });
  return end(await executeChunk(ctx, plan, startSha));
}
