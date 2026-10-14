import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Chunk } from "./backlog";
import type { Ctx } from "./ctx";
import { git } from "./git";
import { spawnGroup } from "./proc";
import { type EnvSignature, type Recovery, classifyEnvFailure, envSummary, freeOwnPorts } from "./envfail";
import { sweepLogger } from "./sweep";

/** Default number of gate runs (`gate.repeat` in run.json). */
export const TEST_RUNS = 3;

export interface FlakyTest { name: string; message: string }

/** Failed test names/messages from vitest, dotnet/xUnit and jest; bounded and deduplicated by name. */
export function parseFailedTests(log: string): FlakyTest[] {
  const lines = log.split("\n");
  const tests: FlakyTest[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length && tests.length < 10; i++) {
    const vitest = /^\s*FAIL\s+(.+)$/.exec(lines[i]);
    const dotnet = /^\s*Failed\s+(\S+)\s+\[/.exec(lines[i]);
    const jest = /^\s*●\s+(.+)$/.exec(lines[i]);
    const match = vitest ?? dotnet ?? jest;
    if (!match || (jest && jest[1].startsWith("Console"))) continue;
    const name = match[1].replace(/\s+/g, " ").trim();
    if (seen.has(name)) continue;
    let from = i + 1;
    if (dotnet) {
      const error = lines.findIndex((l, j) => j > i && /^\s*Error Message:/.test(l));
      from = error >= 0 ? error + 1 : lines.length;
    }
    const message = lines.slice(from).find((l) => l.trim())?.trim().slice(0, 300) ?? "";
    tests.push({ name, message });
    seen.add(name);
  }
  return tests.length ? tests : [{ name: "(unparsed)", message: lines.findLast((l) => l.trim())?.trim().slice(0, 300) ?? "" }];
}

/** Replace the gate-owned section without disturbing subsequent PR sections. */
export function withFlakySection(body: string, tests: FlakyTest[], failedRun: number, ran = `ran the chunk test ${TEST_RUNS} times`): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l === "## Flaky tests");
  if (start >= 0) {
    const next = lines.findIndex((l, i) => i > start && l.startsWith("## "));
    lines.splice(start, (next < 0 ? lines.length : next) - start);
  }
  return `${lines.join("\n").trimEnd()}\n\n## Flaky tests\n\nThe overnight gate ${ran}; run ${failedRun} failed.\n\n${tests.map((t) => `- \`${t.name}\`: ${t.message}`).join("\n")}\n`;
}

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
  /** set when the tests were the only failing check and every failed run was environmental (after the one clean retry) */
  env?: string;
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

/** Read only this invocation's appended log, retaining the full output beyond spawnGroup's capture cap. */
function readSince(file: string, offset: number): string {
  if (!existsSync(file)) return "";
  const size = Math.max(0, statSync(file).size - Math.max(0, offset));
  const fd = openSync(file, "r");
  try {
    const data = Buffer.alloc(size);
    let read = 0;
    while (read < data.length) {
      const n = readSync(fd, data, read, data.length - read, offset + read);
      if (n === 0) break;
      read += n;
    }
    return data.toString("utf8", 0, read);
  } finally { closeSync(fd); }
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

type TestsCheck = Check & { passes: number; runs: number; ran: string; flakyTests?: FlakyTest[]; failedRun?: number; env?: string; envRetry?: EnvRetry };
interface EnvRetry {
  signature: string;
  freed: Recovery["freed"];
  foreign: Recovery["foreign"];
}

const shq = (v: string): string => `'${v.replace(/'/g, "'\\''")}'`;

/**
 * The command that runs only the tests a chunk touched, for the `affected` gate strategy, or null when none can be
 * derived (the gate then falls back to the full strategy). An explicit `affected-test` wins; `{base}` and `{files}`
 * are substituted. Otherwise a single runner command (optionally behind `cd <dir> &&`) gets its native flag:
 * Playwright `--only-changed=<base>`, vitest `--changed <base>`, jest `--changedSince=<base>`, and dotnet test a
 * `--filter` over the changed test classes.
 */
export function affectedCommand(test: string, base: string, changed: string[], explicit = ""): string | null {
  if (explicit) return explicit.replaceAll("{base}", base).replaceAll("{files}", changed.map(shq).join(" "));
  const m = /^(\s*cd\s+(?:"[^"]+"|'[^']+'|[^\s;&|]+)\s*&&\s*)?([^;&|`$()<>]+)$/.exec(test);
  if (!m) return null;
  const prefix = m[1] ?? "";
  const body = m[2].trimEnd();
  if (/\bplaywright\b/.test(body)) return /--only-changed/.test(body) ? null : `${prefix}${body} --only-changed=${base}`;
  if (/\bvitest\b/.test(body)) return /--changed\b|--related\b/.test(body) ? null : `${prefix}${body} --changed ${base}`;
  if (/\bjest\b/.test(body)) return /--changedSince|--onlyChanged|-o\b/.test(body) ? null : `${prefix}${body} --changedSince=${base}`;
  if (/\bdotnet\s+test\b/.test(body)) {
    if (/--filter\b/.test(body)) return null;
    const classes = [...new Set(changed.flatMap((f) => /(?:^|\/)(\w*Tests?)\.cs$/.exec(f)?.[1] ?? []))];
    return classes.length ? `${prefix}${body} --filter "${classes.map((c) => `FullyQualifiedName~${c}`).join("|")}"` : null;
  }
  return null;
}

/** Runner output for "nothing matched the changed files": an affected run with no tests passes. */
export const NO_TESTS_RE = /No tests found|No test files found|No tests ran|No test is available/i;

interface PlannedRun { cmd: string; kind: "repeat" | "full" }

/** Which commands the gate runs: `repeat` x chunk test (full), or `repeat` x affected + 1 x chunk test (affected). */
export async function gatePlan(g: GateInput): Promise<{ runs: PlannedRun[]; ran: string; strategy: string }> {
  const { strategy, repeat } = g.ctx.run.gate;
  const full = (): { runs: PlannedRun[]; ran: string; strategy: string } => ({
    runs: Array.from({ length: repeat }, () => ({ cmd: g.chunk.test, kind: "repeat" as const })),
    ran: `ran the chunk test ${repeat} time${repeat === 1 ? "" : "s"}`,
    strategy: "full",
  });
  if (strategy === "full") return full();
  const diff = await git(g.wt, ["diff", "--name-only", `${g.startSha}...HEAD`]);
  const changed = diff.code === 0 ? diff.stdout.split("\n").filter(Boolean) : [];
  const cmd = affectedCommand(g.chunk.test, g.startSha, changed, g.chunk.affectedTest);
  g.ctx.ledger.log("gate_strategy", { chunk: g.chunk.id, strategy: cmd ? "affected" : "full", ...(cmd ? { affected: cmd } : { fallback: "no affected command could be derived" }), changedFiles: changed.length });
  if (!cmd) return full();
  return {
    runs: [...Array.from({ length: repeat }, () => ({ cmd, kind: "repeat" as const })), { cmd: g.chunk.test, kind: "full" }],
    ran: `ran the affected tests ${repeat} time${repeat === 1 ? "" : "s"} and the chunk test once`,
    strategy: "affected",
  };
}

/**
 * One attempt. Full strategy (default, `repeat` 3): all pass ok, exactly one failure flaky, else fail. Affected
 * strategy: the affected command `repeat` times for flake detection, then the full chunk test once; a failed full run
 * is retried once (pass on retry = flaky). Ok needs every run to pass; one failed affected run or a full run that
 * passes only on retry is flaky; anything more fails.
 */
async function runTestsOnce(g: GateInput, attempt: number): Promise<TestsCheck & { signatures: EnvSignature[] }> {
  const { ctx, chunk } = g;
  const plan = await gatePlan(g);
  let passes = 0;
  let runs = 0;
  let repeatFails = 0;
  let fullFails = 0;
  let lastFail = "";
  let failedLog = "";
  let failedOffset = 0;
  let failedRun = 0;
  const failedRuns: { signature: EnvSignature | null }[] = [];
  const runOne = async (cmd: string, kind: PlannedRun["kind"]): Promise<boolean> => {
    const k = ++runs;
    // the first attempt keeps the documented name; an env retry logs next to it so the evidence is not mixed
    const logFile = join(ctx.logs, `${chunk.id}-test-${attempt > 1 ? `env${attempt}-` : ""}${k}.log`);
    const offset = existsSync(logFile) ? statSync(logFile).size : 0;
    const r = await spawnGroup(["bash", "-lc", cmd], {
      cwd: g.wt,
      env: { CI: "1" },
      timeoutMs: ctx.run.limits.testTimeoutMinutes * 60_000,
      onSuspend: (gap) => ctx.noteSuspend(gap, "gate", chunk.id),
      sweep: "deep",
      onSweep: sweepLogger(ctx, `gate-test-${k}`, chunk.id),
      logFile,
    });
    const affectedEmpty = plan.strategy === "affected" && kind === "repeat" && !r.timedOut && r.code !== 0 && NO_TESTS_RE.test(readSince(logFile, offset));
    if ((r.code === 0 && !r.timedOut) || affectedEmpty) {
      passes++;
      return true;
    }
    failedLog = logFile;
    failedOffset = offset;
    failedRun = k;
    // drop spawnGroup's `$ argv` header: the test command's own text must never look like evidence
    failedRuns.push({ signature: r.timedOut ? null : classifyEnvFailure(readSince(logFile, offset).replace(/^\$ [^\n]*\n/, ""), r.code) });
    lastFail = `run ${k} ${r.timedOut ? "timed out" : `exit ${r.code}`}, log ${logFile}:\n${tail(logFile)}`;
    return false;
  };
  for (const run of plan.runs) {
    if (await runOne(run.cmd, run.kind)) continue;
    if (run.kind === "repeat") repeatFails++;
    else {
      fullFails++;
      if (await runOne(run.cmd, run.kind)) continue;
      fullFails++;
    }
  }
  const signatures = failedRuns.flatMap((f) => (f.signature ? [f.signature] : []));
  const base = { passes, runs, ran: plan.ran };
  const failures = repeatFails + fullFails;
  if (failures === 0) return { ok: true, ...base, detail: `tests ${passes}/${runs}`, signatures };
  const flaky = plan.strategy === "affected"
    ? (repeatFails === 1 && fullFails === 0 && plan.runs.length >= 3) || (repeatFails === 0 && fullFails === 1)
    : failures === 1 && runs >= 2;
  if (flaky) return { ok: true, ...base, detail: `flaky ${passes}/${runs}`, flakyTests: parseFailedTests(readSince(failedLog, failedOffset)), failedRun, signatures };
  // environmental only when EVERY failed run carries an environment signature
  const env = signatures.length === failedRuns.length && signatures.length > 0 ? signatures : [];
  return { ok: false, ...base, detail: `tests ${passes}/${runs} (${chunk.test})\n${lastFail}`, signatures: env, ...(env.length ? { env: envSummary(env) } : {}) };
}

/**
 * The planned test runs (see runTestsOnce). When all failed runs fail with an environmental signature (port in use, OOM, ...), the gate cleans up
 * (stops this run's own leftover listeners) and runs the whole attempt once more, spending no agent tokens. A second
 * environmental failure is reported as `env` so the chunk is blocked as an environment problem, not fix-resumed.
 */
async function checkTests(g: GateInput): Promise<TestsCheck> {
  const strip = ({ signatures: _drop, ...rest }: TestsCheck & { signatures: EnvSignature[] }): TestsCheck => rest;
  const first = await runTestsOnce(g, 1);
  if (first.ok || !first.env || !first.signatures.some((s) => s.retryable)) return strip(first);
  const ports = [...new Set(first.signatures.flatMap((s) => s.ports))];
  const rec = ports.length ? await freeOwnPorts(ports, g.ctx.run.worktreeRoot) : { freed: [], foreign: [] };
  await g.ctx.clock.sleep(2_000); // let the OS release the sockets
  const retry: EnvRetry = { signature: first.env, ...rec };
  g.ctx.ledger.log("gate_env_retry", { chunk: g.chunk.id, ...retry });
  const second = await runTestsOnce(g, 2);
  const note = `env retry after ${first.env}${rec.freed.length ? `; stopped ${rec.freed.length} stale listener(s)` : ""}${rec.foreign.length ? `; ${rec.foreign.length} listener(s) belong to something else and were left alone` : ""}`;
  return { ...strip(second), envRetry: retry, detail: `${second.detail}\n(${note})` };
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
  const flaky = tests.ok && tests.passes < tests.runs;
  const onlyTests = Object.entries(checks).every(([name, c]) => c.ok || name === "tests");
  const env = !tests.ok && onlyTests ? tests.env : undefined;
  const ok = failures.length === 0;
  let prBodyUpdated: boolean | undefined;
  if (ok && flaky && pr?.pr && tests.flakyTests && tests.failedRun) {
    prBodyUpdated = false;
    try {
      const viewed = await spawnGroup(["gh", "pr", "view", String(pr.pr.number), "--repo", g.slug, "--json", "body", "-q", ".body"], { cwd: g.wt, timeoutMs: 60_000 });
      if (viewed.code === 0 && !viewed.timedOut) {
        const file = join(g.ctx.logs, `${g.chunk.id}-pr-body.md`);
        writeFileSync(file, withFlakySection(viewed.stdout, tests.flakyTests, tests.failedRun, tests.ran));
        const edited = await spawnGroup(["gh", "pr", "edit", String(pr.pr.number), "--repo", g.slug, "--body-file", file], { cwd: g.wt, timeoutMs: 60_000 });
        prBodyUpdated = edited.code === 0 && !edited.timedOut;
      }
    } catch { /* PR body annotation is best-effort, not a gate failure. */ }
  }
  const head = (await git(g.wt, ["rev-parse", "--short=7", "HEAD"])).stdout.trim();
  const where = pr?.pr ? `PR #${pr.pr.number} ${pr.pr.url}` : `branch ${g.branch} @ ${head}`;
  const extras = [flaky ? `flaky ${tests.passes}/${tests.runs}` : "", pr?.redrafted ? "redrafted" : ""].filter(Boolean);
  const note = extras.length ? `${where} (${extras.join(", ")})` : where;
  g.ctx.ledger.log("gate", { chunk: g.chunk.id, ok, flaky, checks, ...(tests.flakyTests ? { flakyTests: tests.flakyTests } : {}), ...(prBodyUpdated !== undefined ? { prBodyUpdated } : {}) });
  return { ok, flaky, failures, ...(env ? { env } : {}), note };
}
