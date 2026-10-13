import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOmp } from "../src/agent";
import { tripNote } from "../src/chunk";
import { spawnGroup } from "../src/proc";
import { checkStop } from "../src/stops";
import { GapDetector, guardTimeout } from "../src/suspend";
import { Watchdog } from "../src/watchdog";
import { exhausted, entries, healthy, HOUR, setup, START } from "./helpers";

const FIVE_HOURS = 5 * HOUR;
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("GapDetector ignores on-schedule and merely late ticks, reports a long jump", () => {
  const g = new GapDetector(0, 30_000);
  expect(g.sample(30_000)).toBe(0);
  expect(g.sample(60_000 + 20_000)).toBe(0); // 20 s late: event-loop jitter
  expect(g.sample(110_000 + FIVE_HOURS)).toBe(FIVE_HOURS); // one tick later, 5 h gone
});

test("a 5 h suspend would trip the watchdog without shift and does not with it", () => {
  const mk = (stallMs = 10 * HOUR) => new Watchdog({ now: 0, stallMs, hardMs: 95 * 60_000, tokenCap: 3_000_000, tokensUsed: 473_000 });
  const plain = mk();
  plain.onLine("{}", 60_000);
  expect(plain.check(60_000 + FIVE_HOURS)).toBe("timeout"); // the 2026-10-10 failure

  const w = mk();
  w.onLine("{}", 60_000);
  w.shift(FIVE_HOURS);
  expect(w.check(60_000 + FIVE_HOURS)).toBeNull();
  expect(w.check(94 * 60_000 + FIVE_HOURS)).toBeNull();
  expect(w.check(95 * 60_000 + FIVE_HOURS)).toBe("timeout"); // the awake budget still applies
  const stalled = mk(600_000);
  stalled.onLine("{}", 60_000);
  stalled.shift(FIVE_HOURS);
  expect(stalled.check(60_000 + FIVE_HOURS + 600_000)).toBe("stall"); // and so does the stall timer
});

test("guardTimeout pushes its deadline out by a simulated suspend", async () => {
  let offset = 0;
  const now = () => Date.now() + offset;
  let fired = 0;
  const gaps: number[] = [];
  const cancel = guardTimeout({ timeoutMs: 400, tickMs: 10, thresholdMs: 100, now, onTimeout: () => fired++, onSuspend: (g) => gaps.push(g) });
  await sleepMs(60);
  offset += FIVE_HOURS; // host sleeps
  await sleepMs(150);
  expect(gaps).toHaveLength(1);
  expect(gaps[0]).toBeGreaterThan(FIVE_HOURS - 100);
  expect(fired).toBe(0); // a plain setTimeout / wall-clock check would have fired right after the jump
  await sleepMs(400);
  expect(fired).toBe(1);
  cancel();
});

test("spawnGroup timeouts still kill, and a quick command is not timed out", async () => {
  const slow = await spawnGroup(["sleep", "5"], { timeoutMs: 200 });
  expect(slow.timedOut).toBe(true);
  const quick = await spawnGroup(["true"], { timeoutMs: 5_000 });
  expect(quick).toMatchObject({ code: 0, timedOut: false });
});

test("noteSuspend moves the safety cap and no-progress timer and logs host_suspend", () => {
  const { ctx } = setup();
  const cap = ctx.capAtMs;
  const progress = ctx.progressAt;
  ctx.noteSuspend(FIVE_HOURS, "agent", "c1");
  expect(ctx.capAtMs).toBe(cap + FIVE_HOURS);
  expect(ctx.progressAt).toBe(progress + FIVE_HOURS);
  expect(ctx.suspendMs).toBe(FIVE_HOURS);
  expect(entries(ctx).find((e) => e.event === "host_suspend")).toMatchObject({ chunk: "c1", where: "agent", gapSec: FIVE_HOURS / 1000 });
});

test("a quota wait that oversleeps by hours records the suspend and carries on", async () => {
  const { ctx, state } = setup();
  const resetsAt = START + 3 * HOUR;
  let overslept = false;
  ctx.clock.sleep = async (ms) => {
    state.t += ms + (overslept ? 0 : FIVE_HOURS); // the first sleep spans a host suspend
    overslept = true;
  };
  ctx.readUsage = async () => (state.t >= resetsAt ? healthy() : exhausted(resetsAt));
  expect(await checkStop(ctx, [], 0)).toBeNull();
  expect(entries(ctx).filter((e) => e.event === "host_suspend")).toHaveLength(1);
  expect(ctx.suspendMs).toBeGreaterThanOrEqual(FIVE_HOURS);
});

/** A PATH shim `omp` that prints a session header and then runs for `seconds`. */
function withFakeOmp(seconds: number) {
  const bin = mkdtempSync(join(tmpdir(), "fake-omp-"));
  writeFileSync(join(bin, "omp"), `#!/bin/bash\necho '{"type":"session","id":"s-fake"}'\nsleep ${seconds}\n`);
  chmodSync(join(bin, "omp"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  restore.push(() => { process.env.PATH = saved; });
}
const restore: (() => void)[] = [];
afterEach(() => { for (const r of restore.splice(0)) r(); });

test("runOmp survives a simulated 5 h host suspend instead of tripping the wall-clock timeout", async () => {
  withFakeOmp(1.2);
  const { ctx, dir } = setup();
  mkdirSync(join(dir, "wt"), { recursive: true });
  let offset = 0;
  setTimeout(() => { offset += FIVE_HOURS; }, 150);
  const r = await runOmp(ctx, {
    chunk: "c", wt: dir, n: 1, tokensUsed: 473_000,
    mode: { kind: "initial", promptFile: join(dir, "p.md") },
    tuning: { tickMs: 25, gapThresholdMs: 100, hardMs: 2_500, now: () => Date.now() + offset },
  });
  expect(r.trip).toBeNull();
  expect(r.code).toBe(0);
  expect(r.suspendMs).toBeGreaterThan(FIVE_HOURS - 200);
  expect(r.elapsedMs).toBeLessThan(5_000);
  expect(entries(ctx).some((e) => e.event === "host_suspend" && e.chunk === "c")).toBe(true);
});

test("runOmp without any suspend still times out at its hard limit", async () => {
  withFakeOmp(30);
  const { ctx, dir } = setup();
  const r = await runOmp(ctx, {
    chunk: "c", wt: dir, n: 1, tokensUsed: 0,
    mode: { kind: "initial", promptFile: join(dir, "p.md") },
    tuning: { tickMs: 25, hardMs: 300 },
  });
  expect(r.trip).toBe("timeout");
  const wd = entries(ctx).find((e) => e.event === "watchdog");
  expect(wd).toMatchObject({ trip: "timeout", tokenCap: ctx.run.limits.tokenCap });
}, 30_000);

test("trip notes name the limit that fired and never blame the token cap for a timeout", () => {
  const { ctx } = setup();
  const base = { code: 0, tokens: 473_629, sessionId: null, quotaError: null, elapsedMs: 95 * 60_000, hardMs: 95 * 60_000 };
  const note = tripNote(ctx, { ...base, trip: "timeout", suspendMs: 5 * HOUR });
  expect(note).toContain("watchdog timeout");
  expect(note).toContain("473629 of 3000000 tokens (cap not reached)");
  expect(note).toContain("300 min host suspend excluded");
  expect(tripNote(ctx, { ...base, trip: "token_cap", tokens: 3_000_001, suspendMs: 0 })).toContain("cap reached");
  expect(tripNote(ctx, { ...base, trip: "stall", suspendMs: 0 })).toContain("no output for 10 min");
});
