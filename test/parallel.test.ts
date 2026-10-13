import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Chunk, parseBacklog } from "../src/backlog";
import type { Outcome } from "../src/chunk";
import { type Ctx, makeCtx, realClock } from "../src/ctx";
import { git } from "../src/git";
import { loop } from "../src/runner";
import { validateRunJson } from "../src/runjson";
import { backlog, entries, exhausted, healthy, HOUR, setup, START } from "./helpers";

type Out = Outcome & { branch: string };

/** A `run` seam whose chunks stay running until the test finishes them. */
function controlled() {
  const open = new Map<string, (o: Outcome) => void>();
  const started: string[] = [];
  let peak = 0;
  const run = (ctx: Ctx, chunk: Chunk) => new Promise<Out>((resolve) => {
    started.push(chunk.id);
    open.set(chunk.id, (o) => {
      open.delete(chunk.id);
      ctx.setStatus(chunk.id, o.status, o.note);
      resolve({ ...o, branch: chunk.id });
    });
    peak = Math.max(peak, open.size);
  });
  const finish = (id: string, o: Outcome = { status: "passed", note: "ok" }) => {
    const done = open.get(id);
    if (!done) throw new Error(`${id} is not running`);
    done(o);
  };
  return { run, started, open, finish, peak: () => peak };
}

/**
 * With a fake clock, usage reader and chunks the loop only advances through promise callbacks, so one macrotask turn
 * lets it reach the point where it waits on a running chunk.
 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const statuses = (ctx: Ctx) => Object.fromEntries(parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks.map((c) => [c.id, c.status]));

function parallel(concurrency: number, chunks: (string | { id: string; status?: string; note?: string; needs?: string })[]) {
  const s = setup();
  s.ctx.run.concurrency = concurrency;
  backlog(s.ctx, chunks.map((c) => typeof c === "string" ? { id: c } : c));
  return s;
}

test("concurrency defaults to 1, accepts 1-3 and needs independent PR mode", () => {
  const { ctx } = setup();
  const raw: Record<string, unknown> = { ...ctx.run };
  delete raw.concurrency;
  expect(validateRunJson(raw).concurrency).toBe(1);
  for (const n of [1, 3]) expect(validateRunJson({ ...raw, concurrency: n }).concurrency).toBe(n);
  for (const bad of [0, 4, 1.5, "2"]) expect(() => validateRunJson({ ...raw, concurrency: bad })).toThrow("concurrency");
  expect(() => validateRunJson({ ...raw, concurrency: 2, prMode: "stack" })).toThrow("requires prMode independent");
  expect(validateRunJson({ ...raw, concurrency: 1, prMode: "stack" }).concurrency).toBe(1);
});

test("runs at most `concurrency` chunks at once and starts the next as one finishes", async () => {
  const { ctx } = parallel(2, ["a", "b", "c"]);
  const f = controlled();
  const done = loop(ctx, [], f.run);
  await flush();
  expect(f.started).toEqual(["a", "b"]);
  f.finish("b");
  await flush();
  expect(f.started).toEqual(["a", "b", "c"]);
  f.finish("a");
  f.finish("c");
  expect((await done).reason).toBe("finished");
  expect(f.peak()).toBe(2);
  expect(statuses(ctx)).toEqual({ a: "passed", b: "passed", c: "passed" });
});

test("a stop ends dispatch but the loop returns only after running chunks finish", async () => {
  const { ctx } = parallel(2, ["a", "b", "c"]);
  const f = controlled();
  let returned = false;
  const done = loop(ctx, [], f.run).finally(() => { returned = true; });
  await flush();
  f.finish("a", { status: "failed", note: "gate failed, then quota_floor: x", stopReason: "quota_floor", stopDetail: "x" });
  await flush();
  expect(returned).toBe(false);
  f.finish("b");
  expect(await done).toEqual({ reason: "quota_floor", detail: "x" });
  expect(f.started).toEqual(["a", "b"]);
  expect(statuses(ctx)).toEqual({ a: "failed", b: "passed", c: "pending" });
});

test("running chunks that could still reach maxPrs hold dispatch instead of overshooting", async () => {
  const { ctx } = parallel(3, ["a", "b", "c", "d"]);
  ctx.run.maxPrs = 2;
  const f = controlled();
  const done = loop(ctx, [], f.run);
  await flush();
  expect(f.started).toEqual(["a", "b"]);
  f.finish("a", { status: "failed", note: "tests failed" });
  await flush();
  expect(f.started).toEqual(["a", "b", "c"]);
  f.finish("b");
  f.finish("c");
  expect((await done).reason).toBe("max_prs");
  expect(f.started).toEqual(["a", "b", "c"]);
});

test("a quota wait holds dispatch without sleeping while chunks run; the idle runner then waits it out", async () => {
  const { ctx, state } = parallel(2, ["a", "b"]);
  const resetsAt = START + HOUR;
  let reads = 0;
  ctx.readUsage = async () => (reads++ === 0 || state.t > resetsAt ? healthy() : exhausted(resetsAt));
  const f = controlled();
  const done = loop(ctx, [], f.run);
  await flush();
  expect(f.started).toEqual(["a"]);
  expect(state.sleeps).toEqual([]);
  f.finish("a");
  await flush();
  expect(f.started).toEqual(["a", "b"]);
  expect(state.t).toBeGreaterThan(resetsAt);
  f.finish("b");
  expect((await done).reason).toBe("finished");
  expect(entries(ctx).filter((e) => e.event === "quota_wait")).toHaveLength(1);
});

test("a quota-requeued chunk reruns without ever running twice at once", async () => {
  const { ctx } = parallel(2, ["a", "b"]);
  const f = controlled();
  const done = loop(ctx, [], f.run);
  await flush();
  f.finish("a", { status: "pending", note: "requeued: quota error: 429", requeue: true });
  await flush();
  expect(f.started).toEqual(["a", "b", "a"]);
  f.finish("a");
  f.finish("b");
  expect((await done).reason).toBe("finished");
  expect(f.peak()).toBe(2);
  expect(statuses(ctx)).toEqual({ a: "passed", b: "passed" });
});

test("an error escaping a running chunk fails it at once and surfaces after the others finish", async () => {
  const { ctx } = parallel(2, ["a", "b", "c"]);
  const f = controlled();
  const run = async (c: Ctx, chunk: Chunk) => {
    if (chunk.id !== "a") return f.run(c, chunk);
    c.setStatus("a", "running", "");
    c.running.add("a");
    throw new Error("boom");
  };
  let settled = false;
  const done = loop(ctx, [], run).finally(() => { settled = true; });
  done.catch(() => undefined);
  await flush();
  expect(f.started).toEqual(["b"]);
  expect(settled).toBe(false);
  expect(parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks[0]).toMatchObject({ status: "failed", note: "runner_error: boom" });
  f.finish("b");
  await expect(done).rejects.toThrow("boom");
  expect(f.started).toEqual(["b"]);
  expect(statuses(ctx)).toEqual({ a: "failed", b: "passed", c: "pending" });
  expect(ctx.running.size).toBe(0);
});

test("environment blocks are rechecked only once nothing runs, then retried side by side", async () => {
  const { ctx } = parallel(2, [{ id: "a", status: "blocked", note: "env: browser missing", needs: "browser" }, "b", "c"]);
  const f = controlled();
  const runningAtRecheck: number[] = [];
  const done = loop(ctx, [], f.run, async () => { runningAtRecheck.push(f.open.size); return []; });
  await flush();
  f.finish("b", { status: "blocked", note: "env: docker socket denied" });
  await flush();
  expect(runningAtRecheck).toEqual([]);
  f.finish("c");
  await flush();
  expect(runningAtRecheck).toEqual([0]);
  expect(f.started).toEqual(["b", "c", "a", "b"]);
  f.finish("a");
  f.finish("b");
  expect((await done).reason).toBe("finished");
  expect(f.peak()).toBe(2);
  expect(entries(ctx).filter((e) => e.event === "env_retry").map((e) => e.retried)).toEqual([["a", "b"]]);
});

test("concurrent ledger appends from several processes never tear or interleave lines", async () => {
  const { dir } = setup();
  const file = join(dir, "ledger.jsonl");
  const script = join(dir, "append.ts");
  writeFileSync(script, `import { Ledger } from ${JSON.stringify(join(import.meta.dir, "../src/ledger"))};
console.log = () => {};
const [file, who] = process.argv.slice(2);
const ledger = new Ledger(file);
for (let i = 0; i < 100; i++) ledger.log("x", { who, i, pad: who.repeat(64 * 1024) });
`);
  const writers = ["a", "b", "c", "d"];
  const procs = writers.map((w) => Bun.spawn([process.execPath, script, file, w], { stdout: "ignore", stderr: "inherit" }));
  expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0]);
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(lines).toHaveLength(400);
  for (const w of writers) {
    const mine = lines.filter((e) => e.who === w);
    expect(mine.map((e) => e.i)).toEqual([...Array(100).keys()]);
    expect(mine.every((e) => e.pad.length === 64 * 1024)).toBe(true);
  }
});

/**
 * A repository whose `<date>-x` branch and `x` / `_dry-x` worktree paths already exist, so chunks `x` and `x-2` contend
 * for the same suffixed names, plus a fake `omp` that commits only once `agents` copies of it are alive at the same
 * time (and gives up after ~20 s), which proves the agents really overlapped.
 */
async function realRepo(dir: string, agents: number) {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  for (const args of [
    ["init", "-q", "-b", "main"], ["config", "user.name", "t"], ["config", "user.email", "t@example.invalid"],
    ["config", "commit.gpgsign", "false"], ["config", "core.hooksPath", "/dev/null"],
    ["commit", "-q", "--allow-empty", "-m", "init"], ["branch", "overnight/2026-07-01-x"],
  ]) expect((await git(repo, args)).code).toBe(0);
  for (const taken of ["x", "_dry-x"]) mkdirSync(join(dir, "wt", taken), { recursive: true });
  const bin = join(dir, "bin");
  const barrier = join(dir, "barrier");
  mkdirSync(bin);
  mkdirSync(barrier);
  writeFileSync(join(bin, "omp"), `#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in --cwd) wt="$2"; shift 2;; *) shift;; esac; done
touch ${JSON.stringify(barrier)}/"$(basename "$wt")"
for _ in $(seq 400); do [ "$(ls ${JSON.stringify(barrier)} | wc -l)" -ge ${agents} ] && break; sleep 0.05; done
[ "$(ls ${JSON.stringify(barrier)} | wc -l)" -ge ${agents} ] || exit 3
git -C "$wt" commit -q --allow-empty -m "chunk work"
`);
  chmodSync(join(bin, "omp"), 0o755);
  return { repo, bin };
}

test("parallel chunks claim distinct branches and worktrees and run their agents side by side", async () => {
  const { ctx, dir } = parallel(3, ["x", "x-2", "y"]);
  const { repo, bin } = await realRepo(dir, 3);
  Object.assign(ctx.run, { repo, worktreeRoot: join(dir, "wt") });
  Object.assign(ctx, { clock: realClock, capAtMs: Date.now() + 12 * HOUR, progressAt: Date.now() });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
  try {
    expect((await loop(ctx, [])).reason).toBe("finished");
  } finally {
    process.env.PATH = path;
  }
  expect(statuses(ctx)).toEqual({ x: "passed", "x-2": "passed", y: "passed" });
  const starts = entries(ctx).filter((e) => e.event === "chunk_start");
  expect(new Set(starts.map((e) => e.wt)).size).toBe(3);
  expect(new Set(starts.map((e) => e.branch)).size).toBe(3);
  expect(ctx.running.size).toBe(0);
});

test("parallel dry runs claim distinct worktrees", async () => {
  const { ctx: base, dir } = setup();
  const { repo } = await realRepo(dir, 3);
  const ctx = makeCtx(validateRunJson({ ...base.run, repo, worktreeRoot: join(dir, "wt"), concurrency: 3 }), true);
  Object.assign(ctx, { readUsage: base.readUsage, buildProviders: base.buildProviders });
  backlog(ctx, [{ id: "x" }, { id: "x-2" }, { id: "y" }]);
  const created: string[] = [];
  expect((await loop(ctx, created)).reason).toBe("finished");
  expect(entries(ctx).filter((e) => e.event === "chunk_end").map((e) => e.status)).toEqual(["dry_run", "dry_run", "dry_run"]);
  expect(new Set(created).size).toBe(3);
});
