import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBacklog } from "../src/backlog";
import { type Ctx, makeCtx } from "../src/ctx";
import { MAX_QUOTA_REQUEUES, loop } from "../src/runner";
import { QUOTA_RECHECK_MS, QUOTA_RESET_SLACK_MS, checkStop } from "../src/stops";
import { validateRunJson } from "../src/runjson";
import usage from "./fixtures/usage.json";

const START = Date.parse("2026-07-01T00:00:00Z");
const HOUR = 3_600_000;
const chain = ["anthropic", "openai-codex"];

function setup(opts: { stopAtMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wait-test-"));
  const run = validateRunJson({
    version: 1, repo: dir, repoName: "r", date: "2026-07-01", goal: "g", runDir: dir, worktreeRoot: join(dir, "wt"),
    unit: "omp-overnight-r", remote: "origin", trunk: "main", forge: "local", prMode: "independent", stopAt: "06:00",
    maxPrs: 10, floors: { anthropic: 0.25, "openai-codex": 0.5 }, reservePct: 40,
    models: { plan: "@plan", build: "@default", report: "@smol" }, setupCommand: "", preflightTest: "true", limits: {},
  });
  const ctx = makeCtx(run, false);
  const state = { t: START, sleeps: [] as number[], reads: 0 };
  ctx.clock = {
    now: () => state.t,
    sleep: async (ms) => {
      state.sleeps.push(ms);
      state.t += ms;
    },
  };
  ctx.stopAtMs = opts.stopAtMs ?? START + 12 * HOUR;
  ctx.buildProviders = chain;
  return { ctx, state, dir };
}

/** Healthy usage with both chain providers' 5h windows exhausted, resetting at `resetsAt`. */
function exhausted(resetsAt: number, sevenDay = 0.8) {
  const u = structuredClone(usage) as any;
  for (const r of u.reports) {
    for (const l of r.limits) {
      if (l.scope.windowId === "7d") l.amount.remainingFraction = sevenDay;
      if (l.scope.windowId === "5h") {
        l.amount.remainingFraction = 0;
        l.window.resetsAt = resetsAt;
      }
    }
  }
  return u;
}
const healthy = () => {
  const u = structuredClone(usage) as any;
  for (const r of u.reports) for (const l of r.limits) if (l.scope.windowId === "7d") l.amount.remainingFraction = 0.8;
  return u;
};
const queued = (state: { reads: number }, ctx: Ctx, seq: unknown[]) => {
  ctx.readUsage = async () => seq[Math.min(state.reads++, seq.length - 1)];
};
const ledgerLines = (ctx: Ctx) =>
  readFileSync(ctx.ledger.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("waits out a 5h window then proceeds", async () => {
  const { ctx, state } = setup();
  const resetsAt = START + 3 * HOUR;
  ctx.readUsage = async () => (state.t >= resetsAt ? healthy() : exhausted(resetsAt));
  expect(await checkStop(ctx, [], 0)).toBeNull();
  expect(state.t).toBeGreaterThanOrEqual(resetsAt);
  expect(state.t).toBeLessThanOrEqual(resetsAt + QUOTA_RESET_SLACK_MS + QUOTA_RECHECK_MS);
  expect(state.sleeps.length).toBeGreaterThan(0);
  expect(Math.max(...state.sleeps)).toBeLessThanOrEqual(QUOTA_RECHECK_MS);
  const waits = ledgerLines(ctx).filter((e) => e.event === "quota_wait");
  expect(waits).toHaveLength(1);
  expect(waits[0].window).toBe("5h");
  expect(waits[0].resetsAt).toBe(new Date(resetsAt).toISOString());
  expect(waits[0].message).toMatch(/BST|GMT/);
});

test("reset after stop time -> stop_time without sleeping", async () => {
  const { ctx, state } = setup({ stopAtMs: START + 2 * HOUR });
  queued(state, ctx, [exhausted(START + 5 * HOUR)]);
  const stop = await checkStop(ctx, [], 0);
  expect(stop?.reason).toBe("stop_time");
  expect(state.sleeps).toEqual([]);
});

test("7d floor breach stops without sleeping", async () => {
  const { ctx, state } = setup();
  queued(state, ctx, [exhausted(START + HOUR, 0.2)]);
  const stop = await checkStop(ctx, [], 0);
  expect(stop?.reason).toBe("quota_floor");
  expect(state.sleeps).toEqual([]);
});

test("runner re-queues quota deaths without counting failures", async () => {
  const { ctx, state, dir } = setup();
  const backlog = (id: string) =>
    `## ${id}\n- status: pending\n- scope: s\n- done-when: d\n- test: t\n- prod-code: no\n- note:\n`;
  writeFileSync(ctx.backlog, `# Overnight backlog\ngoal: g\nrepo: ${dir}\n\n${backlog("a")}\n${backlog("b")}`);
  const resetsAt = START + HOUR;
  // read before each chunk start: exhausted, healthy, exhausted, healthy, then healthy
  queued(state, ctx, [exhausted(resetsAt), healthy(), exhausted(resetsAt), healthy(), healthy()]);
  const calls: string[] = [];
  const fake = async (c: Ctx, chunk: { id: string }) => {
    calls.push(chunk.id);
    const requeue = chunk.id === "a" && calls.filter((x) => x === "a").length < MAX_QUOTA_REQUEUES;
    const status = requeue ? "pending" : "passed";
    c.setStatus(chunk.id, status, requeue ? "requeued" : "ok");
    return { status, note: "x", branch: `br-${calls.length}`, ...(requeue ? { requeue: true } : {}) } as any;
  };
  const stop = await loop(ctx, [], fake as any);
  expect(stop.reason).toBe("backlog_exhausted");
  expect(calls).toEqual(["a", "a", "a", "b"]);
  const statuses = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks.map((c) => c.status);
  expect(statuses).toEqual(["passed", "passed"]);
  expect(ledgerLines(ctx).filter((e) => e.event === "quota_wait").length).toBeGreaterThan(0);
});
