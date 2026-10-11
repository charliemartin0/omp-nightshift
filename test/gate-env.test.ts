import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBacklog } from "../src/backlog";
import { makeCtx } from "../src/ctx";
import { classifyEnvFailure, freeOwnPorts } from "../src/envfail";
import { runGate } from "../src/gate";
import { type Group, startGroup } from "../src/proc";
import { validateRunJson } from "../src/runjson";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

const PLAYWRIGHT = "Error: http://localhost:9999 is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true";

test("classifyEnvFailure recognises environmental signatures and ignores code failures", () => {
  expect(classifyEnvFailure(PLAYWRIGHT, 1)).toMatchObject({ kind: "port_in_use", ports: [9999], retryable: true });
  expect(classifyEnvFailure("Error: listen EADDRINUSE: address already in use :::4444\n  at Server.setupListenHandle", 1)).toMatchObject({ kind: "port_in_use", ports: [4444] });
  expect(classifyEnvFailure("Port 5173 is already in use", 1)).toMatchObject({ ports: [5173] });
  expect(classifyEnvFailure(`${PLAYWRIGHT}\nlisten EADDRINUSE 127.0.0.1:8888`, 1)?.ports).toEqual([8888, 9999]);
  expect(classifyEnvFailure("write failed: ENOSPC: no space left on device", 1)).toMatchObject({ kind: "disk_full", retryable: false });
  expect(classifyEnvFailure("vitest worker killed", 137)).toMatchObject({ kind: "out_of_memory", retryable: true });
  expect(classifyEnvFailure("FATAL ERROR: Reached heap limit - JavaScript heap out of memory", 1)?.kind).toBe("out_of_memory");
  expect(classifyEnvFailure(" FAIL apps/x.test.ts > saves\nAssertionError: expected 1 to be 2", 1)).toBeNull();
  expect(classifyEnvFailure("expected port 8080 to be set in config", 1)).toBeNull();
});

function gateEnv(testCommand: string) {
  const dir = mkdtempSync(join(tmpdir(), "gate-env-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const id = ["-c", "user.name=QA", "-c", "user.email=qa@example.invalid"];
  git("init", "--initial-branch=main");
  git(...id, "commit", "--allow-empty", "-m", "baseline");
  const startSha = git("rev-parse", "HEAD");
  git(...id, "commit", "--allow-empty", "-m", "change");
  const ctx = makeCtx(validateRunJson({
    version: 1, repo, repoName: "gate-env", date: "2026-07-01", goal: "QA", runDir: dir, worktreeRoot: join(dir, "wt"),
    unit: "omp-overnight-gate-env", remote: "origin", trunk: "main", forge: "local", prMode: "independent", maxPrs: 1,
    floors: {}, models: { plan: "@plan", build: "@default", report: "@smol" }, setupCommand: "", preflightTest: "true", limits: {},
  }), false);
  const sleeps: number[] = [];
  ctx.clock = { now: () => Date.now(), sleep: async (ms) => { sleeps.push(ms); } };
  const chunk = parseBacklog(`## fe-a\n- status: pending\n- scope: QA\n- done-when: QA\n- test: ${testCommand}\n- prod-code: no\n`).chunks[0];
  const run = () => runGate({ ctx, chunk, wt: repo, branch: "main", startSha, prBase: "main", slug: "local/qa" });
  const events = (name: string) => readFileSync(ctx.ledger.file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.event === name);
  return { dir, ctx, run, events, sleeps };
}

const alive = (pid: number) => { try { return !/^\d+ \(.*\) [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; } };

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  await s.stop(true);
  return port;
}
/** A real listener started from `cwd`, in its own process group like an agent's dev server. */
async function listen(port: number, cwd: string): Promise<Group> {
  mkdirSync(cwd, { recursive: true });
  const g = startGroup(["bun", "-e", `Bun.serve({ port: ${port}, fetch: () => new Response("x") }); setInterval(() => {}, 1000)`], { cwd });
  cleanups.push(() => { try { process.kill(-g.pid, "SIGKILL"); } catch { /* gone */ } });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${port}`); return g; } catch { await Bun.sleep(50); }
  }
  throw new Error("listener did not start");
}
/** exits 1 with the Playwright message while something listens on PORT */
const probe = (port: number) =>
  `if (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null; then echo 'Error: http://localhost:${port} is already used, make sure that nothing is running' >&2; exit 1; fi`;

test("a stale dev server from this run's worktrees is stopped and the gate re-runs without the agent", async () => {
  const port = await freePort();
  const env = gateEnv(probe(port));
  const own = await listen(port, join(env.dir, "wt", "earlier-chunk", "Frontend"));
  const bystander = await listen(await freePort(), join(env.dir, "unrelated")); // not on the failing port
  const result = await env.run();
  expect(result.ok).toBe(true);
  expect(result.env).toBeUndefined();
  expect(alive(own.pid)).toBe(false);
  expect(alive(bystander.pid)).toBe(true);
  const retry = env.events("gate_env_retry");
  expect(retry).toHaveLength(1);
  expect(retry[0]).toMatchObject({ chunk: "fe-a", signature: `port ${port} already in use` });
  expect(retry[0].freed).toHaveLength(1);
  expect(retry[0].foreign).toEqual([]);
  expect(env.sleeps).toContain(2_000);
  const logs = readdirSync(env.ctx.logs).filter((f) => f.startsWith("fe-a-test-")).sort();
  expect(logs).toEqual(["fe-a-test-1.log", "fe-a-test-2.log", "fe-a-test-3.log", "fe-a-test-env2-1.log", "fe-a-test-env2-2.log", "fe-a-test-env2-3.log"]);
});

test("a listener that belongs to something else is never killed; the gate reports an environment failure", async () => {
  const port = await freePort();
  const env = gateEnv(probe(port));
  const foreign = await listen(port, join(env.dir, "somebody-elses-worktree"));
  const result = await env.run();
  expect(result.ok).toBe(false);
  expect(result.env).toBe(`port ${port} already in use`);
  expect(alive(foreign.pid)).toBe(true);
  const retry = env.events("gate_env_retry");
  expect(retry).toHaveLength(1);
  expect(retry[0].freed).toEqual([]);
  expect(retry[0].foreign).toHaveLength(1);
  expect(result.failures.join("\n")).toContain("were left alone");
  expect(readdirSync(env.ctx.logs).filter((f) => f.includes("env2"))).toHaveLength(3); // retried exactly once
});

test("a real test failure is not retried and carries no env flag", async () => {
  const env = gateEnv("printf ' FAIL apps/x.test.ts > saves\\nAssertionError: expected 1 to be 2\\n'; exit 1");
  const result = await env.run();
  expect(result.ok).toBe(false);
  expect(result.env).toBeUndefined();
  expect(env.events("gate_env_retry")).toEqual([]);
  expect(readdirSync(env.ctx.logs).filter((f) => f.startsWith("fe-a-test-"))).toHaveLength(3);
});

test("mixed failures (one environmental, one a real failure) are not treated as environmental", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-mixed-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  // run 1: port message, run 2: real failure, run 3: port message again
  const counter = join(dir, "n");
  const env = gateEnv(`n=$(cat ${counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${counter}; if [ $((n % 3)) -eq 2 ]; then echo ' FAIL real failure' >&2; else echo 'Error: http://localhost:9999 is already used' >&2; fi; exit 1`);
  const result = await env.run();
  expect(result.ok).toBe(false);
  expect(result.env).toBeUndefined();
  expect(env.events("gate_env_retry")).toEqual([]);
});

test("freeOwnPorts only stops listeners whose cwd is inside the worktree root", async () => {
  const root = "/tmp/runroot/wt";
  const killed: number[] = [];
  const found = new Map([
    [1111, [{ pid: 4242, pgrp: 1, cwd: `${root}/chunk/Frontend` }]], // pgrp 1 is never swept
    [2222, [{ pid: 4343, pgrp: 4343, cwd: "/tmp/runroot/wt-other/chunk" }]], // prefix lookalike, not inside root
    [3333, [{ pid: 4444, pgrp: 4444, cwd: "" }]], // cwd unreadable
  ]);
  const rec = await freeOwnPorts([1111, 2222, 3333], root, async (port) => found.get(port) ?? []);
  expect(rec.freed).toEqual([]);
  expect(rec.foreign.map((f) => f.port)).toEqual([1111, 2222, 3333]);
  expect(killed).toEqual([]);
});
