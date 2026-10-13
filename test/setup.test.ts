import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBacklog } from "../src/backlog";
import { planChunk, runChunk } from "../src/chunk";
import { makeCtx } from "../src/ctx";
import type { Ctx } from "../src/ctx";
import { commonDir, git, gitOut, removeWorktree } from "../src/git";
import { readLines } from "../src/proc";
import { beginSetup, markInterrupted, recoverSetup } from "../src/setup";
import { backlog, entries, setup } from "./helpers";

interface Fixture {
  ctx: Ctx;
  dir: string;
  repo: string;
  baseSha: string;
}

async function fixture(ids = ["a"]): Promise<Fixture> {
  const { ctx, dir } = setup();
  const repo = join(dir, "repo");
  mkdirSync(repo);
  for (const args of [
    ["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"],
    ["config", "commit.gpgsign", "false"], ["config", "core.hooksPath", "/dev/null"],
    ["commit", "-q", "--allow-empty", "-m", "fixture"],
  ]) expect((await git(repo, args)).code).toBe(0);
  ctx.run.repo = repo;
  mkdirSync(ctx.run.worktreeRoot);
  backlog(ctx, ids.map((id) => ({ id })));
  return { ctx, dir, repo, baseSha: await gitOut(repo, ["rev-parse", "HEAD"]) };
}

async function owned(f: Fixture, chunk: string, create = true) {
  const setup = beginSetup(f.ctx, chunk);
  const wt = join(realpathSync(f.ctx.run.worktreeRoot), chunk);
  const branch = `overnight/${f.ctx.run.date}-${chunk}`;
  const intent = { chunk, setup, dryRun: false, wt, root: realpathSync(f.ctx.run.worktreeRoot), branch, ref: `refs/heads/${branch}`, base: "main", baseSha: f.baseSha, commonGitDir: await commonDir(f.repo) };
  f.ctx.ledger.log("setup_intent", intent);
  if (create) expect((await git(f.repo, ["worktree", "add", "--no-track", "-b", branch, wt, f.baseSha])).code).toBe(0);
  return intent;
}

const statuses = (ctx: Ctx) => Object.fromEntries(parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks.map((chunk) => [chunk.id, { status: chunk.status, note: chunk.note }]));

test("signal records setup and agent execution distinctly, including before lock acquisition", async () => {
  const f = await fixture(["a", "b"]);
  f.ctx.repoLock = async () => Promise.withResolvers<never>().promise;
  const chunk = parseBacklog(readFileSync(f.ctx.backlog, "utf8")).chunks[0];
  void runChunk(f.ctx, chunk, null);
  expect(f.ctx.settingUp.has("a")).toBe(true);
  expect(entries(f.ctx)[0]).toMatchObject({ event: "setup_begin", chunk: "a" });
  f.ctx.setStatus("b", "running", "");
  f.ctx.running.add("b");
  markInterrupted(f.ctx);
  expect(statuses(f.ctx)).toEqual({
    a: { status: "stopped", note: "stopped by signal during setup" },
    b: { status: "stopped", note: "stopped by signal during agent execution" },
  });
  expect(entries(f.ctx).filter((entry) => entry.event === "chunk_end").map((entry) => [entry.chunk, entry.phase])).toEqual([["a", "setup"], ["b", "running"]]);
  expect(entries(f.ctx).at(-1)).toMatchObject({ event: "stop", reason: "signal", settingUp: ["a"], running: ["b"] });
  expect(f.ctx.settingUp.size).toBe(0);
  expect(f.ctx.running.size).toBe(0);
  const relaunched = makeCtx(f.ctx.run, false);
  await recoverSetup(relaunched);
  expect(statuses(relaunched).a.status).toBe("pending");
  expect(statuses(relaunched).b.status).toBe("stopped");
});

test("next launch removes only pristine interrupted ownership and is idempotent", async () => {
  const f = await fixture(["a", "b"]);
  const intent = await owned(f, "a");
  f.ctx.setStatus("b", "passed", "complete");
  const completed = await owned(f, "b");
  f.ctx.ledger.log("chunk_end", { chunk: "b", status: "passed" });
  f.ctx.settingUp.delete("b");
  const unrelated = join(f.ctx.run.worktreeRoot, "unrelated");
  expect((await git(f.repo, ["worktree", "add", "-b", "user/unrelated", unrelated, f.baseSha])).code).toBe(0);
  markInterrupted(f.ctx);
  const relaunched = makeCtx(f.ctx.run, false);
  await recoverSetup(relaunched);
  expect(existsSync(intent.wt)).toBe(false);
  expect((await git(f.repo, ["show-ref", "--verify", "--quiet", intent.ref])).code).not.toBe(0);
  expect(existsSync(completed.wt)).toBe(true);
  expect((await git(f.repo, ["show-ref", "--verify", "--quiet", completed.ref])).code).toBe(0);
  expect(existsSync(unrelated)).toBe(true);
  expect((await git(f.repo, ["show-ref", "--verify", "--quiet", "refs/heads/user/unrelated"])).code).toBe(0);
  expect(statuses(relaunched)).toMatchObject({ a: { status: "pending" }, b: { status: "passed" } });
  const ledger = readFileSync(relaunched.ledger.file, "utf8");
  await recoverSetup(relaunched);
  expect(readFileSync(relaunched.ledger.file, "utf8")).toBe(ledger);
  const next = await planChunk(relaunched, parseBacklog(readFileSync(relaunched.backlog, "utf8")).chunks[0], null);
  expect(next.wt).toBe(intent.wt);
  expect(next.branch).toBe(intent.branch);
});

test("partial add branch-only and no-resource interruptions are safely released", async () => {
  const f = await fixture(["a", "b"]);
  const partial = await owned(f, "a", false);
  await owned(f, "b", false);
  expect((await git(f.repo, ["branch", partial.branch, f.baseSha])).code).toBe(0);
  markInterrupted(f.ctx);
  await recoverSetup(makeCtx(f.ctx.run, false));
  expect((await git(f.repo, ["show-ref", "--verify", "--quiet", partial.ref])).code).not.toBe(0);
  expect(statuses(f.ctx)).toMatchObject({ a: { status: "pending" }, b: { status: "pending" } });
  expect(entries(f.ctx).filter((entry) => entry.event === "setup_recovered").map((entry) => entry.resolution)).toEqual(["removed", "absent"]);
});

test("advanced, dirty, agent-started, failed and blocked worktrees are retained", async () => {
  const f = await fixture(["advanced", "dirty", "agent", "failed", "blocked"]);
  const intents = [];
  for (const chunk of ["advanced", "dirty", "agent", "failed", "blocked"]) intents.push(await owned(f, chunk));
  expect((await git(intents[0].wt, ["commit", "-q", "--allow-empty", "-m", "advanced work"])).code).toBe(0);
  writeFileSync(join(intents[1].wt, "untracked"), "preserve me");
  f.ctx.ledger.log("chunk_start", { chunk: "agent", setup: intents[2].setup });
  f.ctx.settingUp.delete("agent");
  f.ctx.running.add("agent");
  f.ctx.setStatus("agent", "running", "");
  for (const chunk of ["failed", "blocked"] as const) {
    f.ctx.setStatus(chunk, chunk, "explicit outcome");
    f.ctx.ledger.log("chunk_end", { chunk, status: chunk });
    f.ctx.settingUp.delete(chunk);
  }
  markInterrupted(f.ctx);
  await recoverSetup(makeCtx(f.ctx.run, false));
  for (const intent of intents) {
    expect(existsSync(intent.wt)).toBe(true);
    expect((await git(f.repo, ["show-ref", "--verify", "--quiet", intent.ref])).code).toBe(0);
  }
  expect(statuses(f.ctx)).toMatchObject({ advanced: { status: "stopped" }, dirty: { status: "stopped" }, agent: { status: "stopped" }, failed: { status: "failed" }, blocked: { status: "blocked" } });
  expect(entries(f.ctx).filter((entry) => entry.event === "setup_recovered").map((entry) => entry.chunk)).toEqual(["advanced", "dirty"]);
});

test("ownership recovery rejects outside paths, symlinks, unregistered directories and forged refs", async () => {
  const f = await fixture(["outside", "symlink", "directory", "ref", "symbolic", "other"]);
  const outside = await owned(f, "outside", false);
  const external = join(f.dir, "external");
  expect((await git(f.repo, ["worktree", "add", "-b", outside.branch, external, f.baseSha])).code).toBe(0);
  f.ctx.ledger.log("setup_intent", { ...outside, wt: external });
  const linked = await owned(f, "symlink", false);
  expect((await git(f.repo, ["branch", linked.branch, f.baseSha])).code).toBe(0);
  symlinkSync(external, linked.wt, "dir");
  const directory = await owned(f, "directory", false);
  expect((await git(f.repo, ["branch", directory.branch, f.baseSha])).code).toBe(0);
  mkdirSync(directory.wt);
  writeFileSync(join(directory.wt, "valuable"), "unrelated");
  const ref = await owned(f, "ref");
  f.ctx.ledger.log("setup_intent", { ...ref, ref: "refs/heads/main" });
  const symbolic = await owned(f, "symbolic", false);
  expect((await git(f.repo, ["symbolic-ref", symbolic.ref, "refs/heads/main"])).code).toBe(0);
  const other = await owned(f, "other", false);
  const unrelated = join(f.dir, "unrelated-worktree");
  expect((await git(f.repo, ["worktree", "add", "-b", other.branch, unrelated, f.baseSha])).code).toBe(0);
  markInterrupted(f.ctx);
  await recoverSetup(makeCtx(f.ctx.run, false));
  for (const intent of [outside, linked, directory, ref, symbolic, other]) expect((await git(f.repo, ["show-ref", "--verify", "--quiet", intent.ref])).code).toBe(0);
  expect(existsSync(external)).toBe(true);
  expect(existsSync(unrelated)).toBe(true);
  expect(readFileSync(join(directory.wt, "valuable"), "utf8")).toBe("unrelated");
  expect(realpathSync(linked.wt)).toBe(external);
  expect(entries(f.ctx).filter((entry) => entry.event === "setup_recovered").every((entry) => entry.resolution === "retained")).toBe(true);
  await expect(removeWorktree(f.repo, directory.wt)).rejects.toThrow("worktree remove");
  expect(readFileSync(join(directory.wt, "valuable"), "utf8")).toBe("unrelated");
});

test("dry-run recovery neither reads real ownership nor changes real resources/status", async () => {
  const f = await fixture();
  const intent = await owned(f, "a");
  markInterrupted(f.ctx);
  const dry = makeCtx(f.ctx.run, true);
  const before = readFileSync(f.ctx.ledger.file, "utf8");
  await recoverSetup(dry);
  expect(existsSync(intent.wt)).toBe(true);
  expect(statuses(f.ctx).a.status).toBe("stopped");
  expect(readFileSync(f.ctx.ledger.file, "utf8")).toBe(before);
  // A dry-run intent inserted into the real ledger is not deletion authority either.
  f.ctx.ledger.log("setup_begin", { chunk: "a", setup: "dry", dryRun: true });
  f.ctx.ledger.log("setup_intent", { ...intent, setup: "dry", dryRun: true });
  f.ctx.ledger.log("chunk_start", { chunk: "a", setup: intent.setup });
  await recoverSetup(makeCtx(f.ctx.run, false));
  expect(existsSync(intent.wt)).toBe(true);
});

test("planning never claims a dangling symlink path", async () => {
  const f = await fixture();
  symlinkSync(join(f.dir, "missing-target"), join(f.ctx.run.worktreeRoot, "a"), "dir");
  const plan = await f.ctx.repoLock(() => planChunk(f.ctx, parseBacklog(readFileSync(f.ctx.backlog, "utf8")).chunks[0], null));
  expect(plan.wt).toBe(join(f.ctx.run.worktreeRoot, "a-2"));
});

test("real signal during setup is recoverable before the next launch claims a worktree", async () => {
  const f = await fixture();
  const fifo = join(f.dir, "setup-fifo");
  expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
  f.ctx.run.setupCommand = 'kill -USR1 "$SETUP_NOTIFY_PID"; exec cat "$SETUP_FIFO"';
  const runFile = join(f.dir, "run.json");
  writeFileSync(runFile, JSON.stringify(f.ctx.run));
  const script = join(f.dir, "interrupted.ts");
  const source = (name: string) => JSON.stringify(join(import.meta.dir, `../src/${name}`));
  writeFileSync(script, `import { readFileSync } from "node:fs";
import { parseBacklog } from ${source("backlog")};
import { runChunk } from ${source("chunk")};
import { makeCtx } from ${source("ctx")};
import { loadRunJson } from ${source("runjson")};
import { shutdown } from ${source("proc")};
import { markInterrupted } from ${source("setup")};
const ctx = makeCtx(loadRunJson(process.argv[2]), false);
process.env.SETUP_NOTIFY_PID = String(process.pid);
process.on("SIGUSR1", () => console.log("setup-ready"));
process.on("SIGTERM", async () => { await shutdown(); markInterrupted(ctx); process.exit(0); });
await runChunk(ctx, parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks[0], null);
`);
  const child = Bun.spawn([process.execPath, script, runFile], { env: { ...process.env, SETUP_FIFO: fifo }, stdout: "pipe", stderr: "inherit" });
  try {
    let ready = false;
    const lines = readLines(child.stdout);
    for (;;) {
      const line = await lines.next();
      if (line.done) break;
      if (line.value === "setup-ready") { ready = true; break; }
    }
    const drained = (async () => { for await (const _line of lines) { /* keep stdout open until exit */ } })();
    expect(ready).toBe(true);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    await drained;
  } finally {
    child.kill();
    await child.exited;
  }
  const intent = entries(f.ctx).find((entry) => entry.event === "setup_intent");
  expect(intent).toBeDefined();
  expect(existsSync(intent.wt)).toBe(true);
  expect(statuses(f.ctx).a).toEqual({ status: "stopped", note: "stopped by signal during setup" });
  const next = makeCtx(f.ctx.run, false);
  await recoverSetup(next);
  expect(existsSync(intent.wt)).toBe(false);
  expect(statuses(next).a.status).toBe("pending");
  const plan = await next.repoLock(() => planChunk(next, parseBacklog(readFileSync(next.backlog, "utf8")).chunks[0], null));
  expect(plan.branch).toBe(intent.branch);
  expect(plan.wt).toBe(intent.wt);
}, 20_000);

test("a changed run repository cannot reclaim a branch-only intent from another common Git directory", async () => {
  const f = await fixture();
  const intent = await owned(f, "a", false);
  expect((await git(f.repo, ["branch", intent.branch, f.baseSha])).code).toBe(0);
  markInterrupted(f.ctx);
  const other = join(f.dir, "other-repo");
  expect((await git(f.dir, ["clone", "--quiet", "--no-hardlinks", f.repo, other])).code).toBe(0);
  expect(await gitOut(other, ["rev-parse", "HEAD"])).toBe(f.baseSha);
  expect((await git(other, ["branch", intent.branch, f.baseSha])).code).toBe(0);
  f.ctx.run.repo = other; // Same worktree root and ledger, but a different repository in the relaunched run.json.
  const relaunched = makeCtx(f.ctx.run, false);
  await recoverSetup(relaunched);
  expect((await git(other, ["show-ref", "--verify", "--quiet", intent.ref])).code).toBe(0);
  expect((await git(f.repo, ["show-ref", "--verify", "--quiet", intent.ref])).code).toBe(0);
  expect(statuses(relaunched).a.status).toBe("stopped");
  expect(entries(relaunched).at(-1)).toMatchObject({
    event: "setup_recovered", resolution: "retained", reason: "ownership belongs to a different common Git directory",
  });
});

test("interrupted setup preserves ignored files rather than deleting a superficially clean worktree", async () => {
  const f = await fixture();
  writeFileSync(join(f.repo, ".gitignore"), ".env\n");
  expect((await git(f.repo, ["add", ".gitignore"])).code).toBe(0);
  expect((await git(f.repo, ["commit", "-q", "-m", "ignore local config"])).code).toBe(0);
  f.baseSha = await gitOut(f.repo, ["rev-parse", "HEAD"]);
  const intent = await owned(f, "a");
  writeFileSync(join(intent.wt, ".env"), "LOCAL_TEST_VALUE=preserve\n");
  expect(await gitOut(intent.wt, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  markInterrupted(f.ctx);
  await recoverSetup(makeCtx(f.ctx.run, false));
  expect(readFileSync(join(intent.wt, ".env"), "utf8")).toBe("LOCAL_TEST_VALUE=preserve\n");
  expect(await gitOut(f.repo, ["rev-parse", intent.ref])).toBe(f.baseSha);
  expect(statuses(f.ctx).a.status).toBe("stopped");
  expect(entries(f.ctx).at(-1)).toMatchObject({ event: "setup_recovered", resolution: "retained" });
});
