import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Chunk } from "./backlog";
import type { Ctx } from "./ctx";
import { git } from "./git";
import { spawnGroup } from "./proc";

export const TEST_RUNS = 3;

export interface GateInput {
  ctx: Ctx;
  chunk: Chunk;
  wt: string;
  branch: string;
  startSha: string;
  /** expected PR base branch */
  prBase: string;
  /** "owner/name" parsed from the origin URL */
  slug: string;
}
export interface GateResult {
  ok: boolean;
  flaky: boolean;
  failures: string[];
  /** PR / branch description for the backlog note (only meaningful when ok) */
  note: string;
}
interface Check {
  ok: boolean;
  detail: string;
}
interface Pr {
  number: number;
  url: string;
  isDraft: boolean;
  state: string;
  baseRefName: string;
  headRefOid: string;
}

function parsePr(text: string): Pr | null {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== "object" || v === null) return null;
    const { number, url, isDraft, state, baseRefName, headRefOid }: Record<string, unknown> = Object.fromEntries(Object.entries(v));
    if (typeof number !== "number" || typeof url !== "string" || typeof isDraft !== "boolean") return null;
    if (typeof state !== "string" || typeof baseRefName !== "string" || typeof headRefOid !== "string") return null;
    return { number, url, isDraft, state, baseRefName, headRefOid };
  } catch {
    return null;
  }
}

function tail(file: string, maxChars = 2500): string {
  if (!existsSync(file)) return "";
  const lines = readFileSync(file, "utf8").trimEnd().split("\n").slice(-40).join("\n");
  return lines.length > maxChars ? lines.slice(-maxChars) : lines;
}

async function checkClean(g: GateInput): Promise<Check> {
  const r = await git(g.wt, ["status", "--porcelain"]);
  const dirty = r.stdout.split("\n").filter((l) => l && !/^\?\? \.overnight-status\/?$/.test(l));
  if (r.code === 0 && dirty.length === 0) return { ok: true, detail: "clean" };
  return { ok: false, detail: `working tree not clean: ${dirty.slice(0, 8).join(" | ") || r.stderr.trim()}` };
}

async function checkBranch(g: GateInput): Promise<Check> {
  const cur = (await git(g.wt, ["branch", "--show-current"])).stdout.trim();
  return cur === g.branch
    ? { ok: true, detail: cur }
    : { ok: false, detail: `not on branch ${g.branch} (currently ${cur || "detached HEAD"})` };
}

async function checkCommit(g: GateInput): Promise<Check> {
  const r = await git(g.wt, ["rev-list", "--count", `${g.startSha}..HEAD`]);
  const n = Number(r.stdout.trim());
  return r.code === 0 && n >= 1
    ? { ok: true, detail: `${n} new commit(s)` }
    : { ok: false, detail: `no new commit since ${g.startSha.slice(0, 7)}` };
}

/** Three runs of the chunk's test command: 3/3 pass, 2/3 pass flaky, else fail. */
async function checkTests(g: GateInput): Promise<Check & { passes: number }> {
  const { ctx, chunk } = g;
  let passes = 0;
  let lastFail = "";
  for (let k = 1; k <= TEST_RUNS; k++) {
    const logFile = join(ctx.logs, `${chunk.id}-test-${k}.log`);
    const r = await spawnGroup(["bash", "-lc", chunk.test], {
      cwd: g.wt,
      env: { CI: "1" },
      timeoutMs: ctx.run.limits.testTimeoutMinutes * 60_000,
      logFile,
    });
    if (r.code === 0 && !r.timedOut) passes++;
    else lastFail = `run ${k} ${r.timedOut ? "timed out" : `exit ${r.code}`}, log ${logFile}:\n${tail(logFile)}`;
  }
  if (passes === TEST_RUNS) return { ok: true, passes, detail: `tests ${passes}/${TEST_RUNS}` };
  if (passes === TEST_RUNS - 1) return { ok: true, passes, detail: `flaky ${passes}/${TEST_RUNS}` };
  return { ok: false, passes, detail: `tests ${passes}/${TEST_RUNS} (${chunk.test})\n${lastFail}` };
}

async function viewPr(g: GateInput): Promise<{ pr: Pr | null; error: string }> {
  const r = await spawnGroup(
    ["gh", "pr", "view", g.branch, "--repo", g.slug, "--json", "number,url,isDraft,state,baseRefName,headRefOid"],
    { cwd: g.wt, timeoutMs: 60_000 },
  );
  const pr = r.code === 0 ? parsePr(r.stdout) : null;
  return { pr, error: pr ? "" : r.stderr.trim() || r.stdout.trim() || `exit ${r.code}` };
}

/** Requires an OPEN PR on the expected base whose head is the local HEAD; re-drafts a published PR. */
async function checkPr(g: GateInput): Promise<Check & { pr?: Pr; redrafted?: boolean }> {
  let { pr, error } = await viewPr(g);
  if (!pr) return { ok: false, detail: `no readable PR for ${g.branch}: ${error}` };
  let redrafted = false;
  if (!pr.isDraft) {
    const u = await spawnGroup(["gh", "pr", "ready", "--undo", String(pr.number), "--repo", g.slug], { cwd: g.wt, timeoutMs: 60_000 });
    redrafted = u.code === 0;
    ({ pr, error } = await viewPr(g));
    if (!pr) return { ok: false, detail: `PR unreadable after re-draft: ${error}` };
    if (!pr.isDraft) return { ok: false, pr, detail: `PR #${pr.number} is not a draft and gh pr ready --undo failed: ${u.stderr.trim()}` };
  }
  const head = (await git(g.wt, ["rev-parse", "HEAD"])).stdout.trim();
  const problems: string[] = [];
  if (pr.state !== "OPEN") problems.push(`PR #${pr.number} state is ${pr.state}, expected OPEN`);
  if (pr.baseRefName !== g.prBase) problems.push(`PR #${pr.number} base is ${pr.baseRefName}, expected ${g.prBase}`);
  if (pr.headRefOid !== head) problems.push(`PR #${pr.number} head ${pr.headRefOid.slice(0, 7)} != local HEAD ${head.slice(0, 7)} (latest commit is not pushed)`);
  if (problems.length) return { ok: false, pr, redrafted, detail: problems.join("; ") };
  return { ok: true, pr, redrafted, detail: `PR #${pr.number} ${pr.url}` };
}

export async function runGate(g: GateInput): Promise<GateResult> {
  const forgePr = g.ctx.run.forge !== "local";
  const checks: Record<string, Check> = {
    clean: await checkClean(g),
    branch: await checkBranch(g),
    commit: await checkCommit(g),
  };
  const tests = await checkTests(g);
  checks.tests = tests;
  const pr = forgePr ? await checkPr(g) : null;
  if (pr) checks.pr = pr;

  const failures = Object.values(checks).filter((c) => !c.ok).map((c) => c.detail);
  const flaky = tests.ok && tests.passes < TEST_RUNS;
  const ok = failures.length === 0;
  const head = (await git(g.wt, ["rev-parse", "--short=7", "HEAD"])).stdout.trim();
  const where = pr?.pr ? `PR #${pr.pr.number} ${pr.pr.url}` : `branch ${g.branch} @ ${head}`;
  const extras = [flaky ? `flaky ${tests.passes}/${TEST_RUNS}` : "", pr?.redrafted ? "redrafted" : ""].filter(Boolean);
  const note = extras.length ? `${where} (${extras.join(", ")})` : where;
  g.ctx.ledger.log("gate", { chunk: g.chunk.id, ok, flaky, checks });
  return { ok, flaky, failures, note };
}
