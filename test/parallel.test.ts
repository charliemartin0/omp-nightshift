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
  s.ctx.readUsage = async () => {
    const usage = healthy();
    for (const report of usage.reports) for (const limit of report.limits) limit.amount.remainingFraction = 0.95;
    return usage;
  };
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

test("runs at most `concurrency` chunks and holds admission behind out-of-order completions", async () => {
  const { ctx } = parallel(2, ["a", "b", "c"]);
  const f = controlled();
  const done = loop(ctx, [], f.run);
  await flush();
  expect(f.started).toEqual(["a", "b"]);
  f.finish("b");
  await flush();
  expect(f.started).toEqual(["a", "b"]);
  f.finish("a");
  await flush();
  expect(f.started).toEqual(["a", "b", "c"]);
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

test("an escaping chunk error fails only that chunk and dispatch continues", async () => {
  for (const phase of ["setup", "running"] as const) {
    const { ctx } = parallel(2, ["a", "b", "c"]);
    const f = controlled();
    const run = async (c: Ctx, chunk: Chunk) => {
      if (chunk.id !== "a") return f.run(c, chunk);
      if (phase === "running") {
        c.setStatus("a", "running", "");
        c.running.add("a");
      } else c.settingUp.add("a");
      throw new Error(`${phase} boom`);
    };
    const done = loop(ctx, [], run);
    await flush();
    expect(f.started).toEqual(["b", "c"]);
    expect(parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks[0]).toMatchObject({ status: "failed", note: `chunk_error: ${phase} boom` });
    f.finish("b");
    f.finish("c");
    expect((await done).reason).toBe("finished");
    expect(statuses(ctx)).toEqual({ a: "failed", b: "passed", c: "passed" });
    expect(ctx.running.size).toBe(0);
    expect(ctx.settingUp.size).toBe(0);
    expect(entries(ctx).filter((e) => e.chunk === "a" && e.event === "chunk_end")).toMatchObject([{ status: "failed", note: `chunk_error: ${phase} boom` }]);
  }
});

test("consecutive failures count by dispatch order for every completion permutation", async () => {
  for (const order of [["a", "b", "c"], ["a", "c", "b"], ["b", "a", "c"], ["b", "c", "a"], ["c", "a", "b"], ["c", "b", "a"]]) {
    const { ctx } = parallel(3, ["a", "b", "c", "d"]);
    const f = controlled();
    const done = loop(ctx, [], f.run);
    await flush();
    expect(f.started).toEqual(["a", "b", "c"]);
    for (const id of order) {
      f.finish(id, id === "c" ? { status: "passed", note: "ok" } : { status: "failed", note: `${id} distinct failure` });
      await flush();
    }
    // A slot may have been backfilled before the second failure was known; such work is drained, not cancelled.
    if (f.open.has("d")) f.finish("d");
    expect((await done).reason).toBe("consecutive_failures");
    expect(statuses(ctx)).toMatchObject({ a: "failed", b: "failed", c: "passed" });
  }
});

test("identical failure totals are stable across completion permutations and interleaved passes", async () => {
  for (const order of [["a", "b", "c"], ["a", "c", "b"], ["b", "a", "c"], ["b", "c", "a"], ["c", "a", "b"], ["c", "b", "a"]]) {
    const { ctx } = parallel(3, ["a", "b", "c", "d", "e"]);
    const f = controlled();
    const done = loop(ctx, [], f.run);
    await flush();
    for (const id of order) {
      f.finish(id, id === "b" ? { status: "passed", note: "ok" } : { status: "failed", note: `test ${id} failed at line 42` });
      await flush();
    }
    f.finish("e", { status: "failed", note: "test e failed at line 64" });
    await flush();
    f.finish("d");
    const stop = await done;
    expect(stop.reason).toBe("safety_cap");
    expect(stop.detail).toContain("same failure 3x");
  }
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

test("dry setup exception after an earlier success does not suppress the next pending chunk", async () => {
  const { ctx: base, dir } = setup();
  const { repo } = await realRepo(dir, 1);
  const ctx = makeCtx(validateRunJson({ ...base.run, repo, concurrency: 1 }), true);
  ctx.readUsage = base.readUsage;
  backlog(ctx, [{ id: "a" }, { id: "b" }, { id: "c" }]);
  const claim = ctx.repoLock;
  let calls = 0;
  ctx.repoLock = async (fn) => {
    if (++calls === 2) throw new Error("repository lock unavailable");
    return claim(fn);
  };
  expect((await loop(ctx, [])).reason).toBe("finished");
  expect(entries(ctx).filter((e) => e.event === "chunk_end").map((e) => [e.chunk, e.status])).toEqual([
    ["a", "dry_run"], ["b", "failed"], ["c", "dry_run"],
  ]);
});
