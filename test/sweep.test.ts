import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOmp } from "../src/agent";
import { spawnGroup, startGroup } from "../src/proc";
import { groupMembers, sweepGroup } from "../src/sweep";
import { entries, setup } from "./helpers";

const stray: number[] = [];
afterEach(() => {
  for (const pid of stray.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
});
/** alive = exists and not a zombie (a box without a reaping init leaves zombies behind) */
function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^\d+ \(.*\) [ZX] /.test(stat);
  } catch {
    return false;
  }
}
async function gone(pid: number, ms = 3000): Promise<boolean> {
  for (const until = Date.now() + ms; Date.now() < until; await Bun.sleep(25)) if (!alive(pid)) return true;
  return !alive(pid);
}

test("a command that backgrounds a process leaves nothing behind", async () => {
  const r = await spawnGroup(["bash", "-c", "sleep 300 & echo $!"]);
  const pid = Number(r.stdout.trim());
  stray.push(pid);
  expect(pid).toBeGreaterThan(1);
  expect(r.swept).toBe(1);
  expect(await gone(pid)).toBe(true);
});

test("a clean command sweeps nothing and `sweep: false` keeps stragglers", async () => {
  expect((await spawnGroup(["true"])).swept).toBe(0);
  const kept = await spawnGroup(["bash", "-c", "sleep 300 & echo $!"], { sweep: false });
  const pid = Number(kept.stdout.trim());
  stray.push(pid);
  expect(kept.swept).toBe(0);
  expect(alive(pid)).toBe(true);
});

test("deep sweep also reaches job-control children that left the process group", async () => {
  const g = startGroup(["bash", "-c", "set -m; sleep 300 >/dev/null 2>&1 & echo $!"]);
  let out = "";
  for await (const c of g.stdout) out += new TextDecoder().decode(c);
  await g.exited;
  const pid = Number(out.trim());
  stray.push(pid);
  expect(groupMembers(g.pid).map((m) => m.pid)).toContain(pid); // same session, own process group
  expect((await g.sweep(false)).found).toBe(0); // the group is empty: the shallow probe misses it
  expect(alive(pid)).toBe(true);
  const deep = await g.sweep(true);
  expect(deep.found).toBe(1);
  expect(deep.comms).toContain("sleep");
  expect(await gone(pid)).toBe(true);
});

test("a process that ignores SIGTERM is SIGKILLed after the grace period", async () => {
  const g = startGroup(["bash", "-c", "(trap '' TERM; exec sleep 300 >/dev/null 2>&1) & echo $!; sleep 0.1"]);
  let out = "";
  for await (const c of g.stdout) out += new TextDecoder().decode(c);
  await g.exited;
  const pid = Number(out.trim());
  stray.push(pid);
  const t0 = Date.now();
  const r = await sweepGroup(g.pid, { graceMs: 300 });
  expect(r).toMatchObject({ found: 1, survivors: 0 });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  expect(await gone(pid)).toBe(true);
});

test("unrelated processes are never touched", async () => {
  const bystander = Bun.spawn(["sleep", "300"]);
  stray.push(bystander.pid);
  await spawnGroup(["bash", "-c", "sleep 300 &"]);
  expect(alive(bystander.pid)).toBe(true);
});

test("runOmp sweeps a dev server the agent left behind and records it in the ledger", async () => {
  const bin = mkdtempSync(join(tmpdir(), "fake-omp-"));
  const pidFile = join(bin, "orphan.pid");
  writeFileSync(join(bin, "omp"), `#!/bin/bash\necho '{"type":"session","id":"s-fake"}'\nsleep 300 >/dev/null 2>&1 &\necho $! > ${pidFile}\n`);
  chmodSync(join(bin, "omp"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const { ctx, dir } = setup();
    ctx.capAtMs = Date.now() + 3_600_000; // helpers pin the cap to a fixed 2026-07 date
    const r = await runOmp(ctx, { chunk: "c", wt: dir, n: 1, tokensUsed: 0, mode: { kind: "initial", promptFile: join(dir, "p.md") } });
    expect(r).toMatchObject({ code: 0, trip: null });
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    stray.push(pid);
    expect(await gone(pid)).toBe(true);
    const log = entries(ctx);
    expect(log.find((e) => e.event === "sweep")).toMatchObject({ chunk: "c", phase: "agent", found: 1 });
    expect(log.find((e) => e.event === "omp_exit")).toMatchObject({ swept: 1 });
  } finally {
    process.env.PATH = saved;
  }
});
