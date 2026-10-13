import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Chunk } from "../src/backlog";
import type { Outcome } from "../src/chunk";
import type { Ctx } from "../src/ctx";
import { type DiskDeps, type DiskSample, parseDfAvailable, probeDisk } from "../src/disk";
import { runPreflight } from "../src/preflight";
import { loop } from "../src/runner";
import { DISK_DEFAULTS, GIB, validateRunJson } from "../src/runjson";
import { backlog, entries, exhausted, healthy, HOUR, setup } from "./helpers";

const dfOut = (freeBytes: number, mount = "/") =>
  `Filesystem     1024-blocks       Used  Available Capacity Mounted on\n/dev/sda1       104857600    1048576  ${freeBytes / 1024}      1% ${mount}\n`;

/** A `df`/`powershell.exe` double: results are keyed by path / script, so unexpected commands are loud. */
function fakeDeps(o: { df?: Record<string, string | null>; wsl?: boolean; ps?: { find?: string | null; free?: string | null }; mounts?: string[]; env?: Record<string, string | undefined>; realFs?: boolean }) {
  const calls: { argv: string[]; env: Record<string, string> }[] = [];
  const dir = (path: string) => {
    if (!o.realFs) return true;
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  };
  const deps: DiskDeps = {
    async run(argv, opts) {
      calls.push({ argv, env: { ...(opts.env ?? {}) } });
      if (argv[0] === "df") {
        const out = o.df?.[argv[argv.length - 1]];
        if (out === undefined) return { code: 1, stdout: "", stderr: "df: no such file or directory", timedOut: false };
        return out === null ? { code: 0, stdout: "", stderr: "", timedOut: true } : { code: 0, stdout: out, stderr: "", timedOut: false };
      }
      const script = argv[3] ?? "";
      const out = script.includes("FreeSpace") ? o.ps?.free : o.ps?.find;
      return out ? { code: 0, stdout: out, stderr: "", timedOut: false } : { code: 1, stdout: "", stderr: "powershell.exe: not found", timedOut: false };
    },
    isWsl: () => o.wsl ?? false,
    exists: (path) => (o.realFs ? existsSync(path) : true),
    isDir: dir,
    readdir: (path) => (o.realFs && path === "/mnt" ? readdirSync(path) : o.mounts ?? []),
    env: o.env ?? {},
  };
  return { deps, calls };
}

test("disk config defaults, merges and rejects malformed values", () => {
  const { ctx } = setup();
  const raw = { ...ctx.run } as Record<string, unknown>;
  delete raw.disk;
  expect(validateRunJson(raw).disk).toEqual(DISK_DEFAULTS);
  expect(validateRunJson({ ...raw, disk: {} }).disk).toEqual(DISK_DEFAULTS);
  expect(validateRunJson({ ...raw, disk: { minFreeGb: 0.5 } }).disk).toEqual({ ...DISK_DEFAULTS, minFreeGb: 0.5 });
  expect(validateRunJson({ ...raw, disk: { minFreeGb: 0, minHostFreeGb: 0, waitMinutes: 0 } }).disk).toEqual({ minFreeGb: 0, minHostFreeGb: 0, waitMinutes: 0 });
  for (const bad of [{ minFreeGb: -1 }, { minHostFreeGb: -0.5 }, { waitMinutes: -1 }, { minFreeGb: "20" }, { waitMinutes: null }, { minFreeGb: NaN }, { waitMinutes: Infinity }, { minFreeGb: 1, extra: 2 }, { minFreeGb: 1, waitMinutes: 1, other: true }]) {
    expect(() => validateRunJson({ ...raw, disk: bad })).toThrow("disk");
  }
  for (const bad of [null, 3, "x", []]) expect(() => validateRunJson({ ...raw, disk: bad })).toThrow("disk");
});

test("df parsing reads the POSIX available column and rejects anything else", () => {
  expect(parseDfAvailable(dfOut(30 * GIB))).toBe(30 * GIB);
  expect(parseDfAvailable(dfOut(3 * GIB, "/mnt/c/Users/some user"))).toBe(3 * GIB);
  expect(parseDfAvailable("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 50 25 50% /\n")).toBe(25 * 1024);
  for (const bad of ["", "Filesystem 1024-blocks Used Available Capacity Mounted on\n", "header\n/dev/sda1 100 50 25 50% /\n/dev/sdb1 100 50 25 50% /x\n", "header\n/dev/sda1 100 50 -25 129% /\n", "header\n/dev/sda1 100 50 25 fifty /\n", "not df output"]) {
    expect(() => parseDfAvailable(bad)).toThrow();
  }
});

test("probe measures repo and worktree filesystems, and equality passes", async () => {
  const { ctx } = setup();
  mkdirSync(ctx.run.worktreeRoot, { recursive: true });
  const exact = fakeDeps({ df: { [ctx.run.repo]: dfOut(20 * GIB), [ctx.run.worktreeRoot]: dfOut(20 * GIB + 1024) } });
  const ok = await probeDisk(ctx.run, exact.deps);
  expect(ok.ok).toBe(true);
  expect(ok.volumes).toEqual([
    { kind: "repo", freeBytes: 20 * GIB, minBytes: 20 * GIB },
    { kind: "worktree", freeBytes: 20 * GIB + 1024, minBytes: 20 * GIB },
  ]);
  expect(ok.detail).toContain("GiB free");
  expect(exact.calls.every((c) => c.argv[0] === "df" && c.argv[1] === "-Pk" && c.argv[2] === "--")).toBe(true);
  expect(exact.calls.map((c) => c.argv[3])).toEqual([ctx.run.repo, ctx.run.worktreeRoot]);
  expect(exact.calls.every((c) => c.env.LC_ALL === "C")).toBe(true);
  mkdirSync(join(ctx.run.worktreeRoot, "dir with spaces"), { recursive: true });
  const missing = await probeDisk({ ...ctx.run, worktreeRoot: join(ctx.run.worktreeRoot, "dir with spaces", "nested") }, exact.deps);
  expect(missing.ok).toBe(false);
});

test("probe measures the nearest existing directory and passes paths through verbatim", async () => {
  const { ctx } = setup();
  mkdirSync(join(ctx.run.worktreeRoot, "dir with spaces"), { recursive: true });
  const { deps, calls } = fakeDeps({ realFs: true, df: { [ctx.run.repo]: dfOut(21 * GIB), [join(ctx.run.worktreeRoot, "dir with spaces")]: dfOut(21 * GIB) } });
  const s = await probeDisk({ ...ctx.run, worktreeRoot: join(ctx.run.worktreeRoot, "dir with spaces", "nested") }, deps);
  expect(s.ok).toBe(true);
  expect(calls[1].argv[3]).toBe(join(ctx.run.worktreeRoot, "dir with spaces"));
});

test("probe fails closed on measurement errors and one byte below the threshold", async () => {
  const { ctx } = setup();
  mkdirSync(ctx.run.worktreeRoot, { recursive: true });
  const low = await probeDisk(ctx.run, fakeDeps({ df: { [ctx.run.repo]: dfOut(20 * GIB - 1024), [ctx.run.worktreeRoot]: dfOut(50 * GIB) } }).deps);
  expect(low.ok).toBe(false);
  expect(low.detail).toContain("low:");
  for (const df of [{ [ctx.run.repo]: "garbage", [ctx.run.worktreeRoot]: dfOut(50 * GIB) }, { [ctx.run.repo]: null, [ctx.run.worktreeRoot]: dfOut(50 * GIB) }, { [ctx.run.worktreeRoot]: dfOut(50 * GIB) }]) {
    const s = await probeDisk(ctx.run, fakeDeps({ df }).deps);
    expect(s.ok).toBe(false);
    expect(s.detail).toContain("error:");
  }
});

test("probe measures the WSL host drive from the registered distribution", async () => {
  const { ctx } = setup();
  mkdirSync(ctx.run.worktreeRoot, { recursive: true });
  const df = { [ctx.run.repo]: dfOut(50 * GIB), [ctx.run.worktreeRoot]: dfOut(50 * GIB), "/mnt/d": dfOut(50 * GIB) };
  const { deps, calls } = fakeDeps({ df, wsl: true, ps: { free: JSON.stringify({ drive: "D", freeBytes: 2 * GIB }) }, env: { WSL_DISTRO_NAME: "Ubuntu", LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" } });
  const s = await probeDisk(ctx.run, deps);
  expect(s.ok).toBe(false);
  expect(s.volumes.find((v) => v.kind === "host")).toEqual({ kind: "host", freeBytes: 2 * GIB, minBytes: 15 * GIB });
  expect(calls.filter((c) => c.argv[0] === "powershell.exe").every((c) => c.argv[1] === "-NoProfile" && c.argv[2] === "-Command")).toBe(true);
  expect(calls.some((c) => c.argv[0] === "df" && c.argv[3] === "/mnt/c")).toBe(false);
});

test("probe finds powershell inside a mounted Windows install when PATH has none", async () => {
  const { ctx } = setup();
  mkdirSync(ctx.run.worktreeRoot, { recursive: true });
  const exe = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  const calls: string[] = [];
  const deps: DiskDeps = {
    async run(argv) {
      calls.push(argv[0]);
      if (argv[0] === "df") return { code: 0, stdout: dfOut(50 * GIB), stderr: "", timedOut: false };
      if (argv[0] !== exe) return { code: 127, stdout: "", stderr: "powershell.exe: not found", timedOut: false };
      return { code: 0, stdout: JSON.stringify({ drive: "C", freeBytes: 50 * GIB }), stderr: "", timedOut: false };
    },
    isWsl: () => true,
    exists: (path) => path === exe || path === "/mnt" || path === ctx.run.repo,
    isDir: (path) => path !== exe && path !== "powershell.exe",
    readdir: () => ["c", "wsl"],
    env: {},
  };
  const s = await probeDisk({ ...ctx.run, worktreeRoot: ctx.run.repo }, deps);
  expect(s.ok).toBe(true);
  expect(s.volumes.find((v) => v.kind === "host")?.freeBytes).toBe(50 * GIB);
  expect(calls).toEqual(["df", "df", "powershell.exe", exe]);
});

test("probe falls back to %LOCALAPPDATA% and then /mnt, and fails closed when ambiguous", async () => {
  const { ctx } = setup();
  mkdirSync(ctx.run.worktreeRoot, { recursive: true });
  const base = { [ctx.run.repo]: dfOut(50 * GIB), [ctx.run.worktreeRoot]: dfOut(50 * GIB) };
  const local = fakeDeps({ df: { ...base, "/mnt/c": dfOut(50 * GIB, "/mnt/c") }, wsl: true, env: { LOCALAPPDATA: "c:\\Users\\someone\\AppData\\Local" } });
  const a = await probeDisk(ctx.run, local.deps);
  expect(a.volumes.some((v) => v.kind === "host")).toBe(true);
  expect(local.calls.some((c) => c.argv[0] === "df" && c.argv[3] === "/mnt/c")).toBe(true);

  const one = fakeDeps({ df: { ...base, "/mnt/e": dfOut(16 * GIB) }, wsl: true, mounts: ["e"], env: {} });
  expect((await probeDisk(ctx.run, one.deps)).ok).toBe(true);

  const many = fakeDeps({ df: base, wsl: true, mounts: ["c", "d"], env: {} });
  const b = await probeDisk(ctx.run, many.deps);
  expect(b.ok).toBe(false);
  expect(b.detail).toContain("host drive: unavailable");

  const noPs = fakeDeps({ df: { ...base, "/mnt/c": dfOut(50 * GIB) }, wsl: true, ps: { free: JSON.stringify({ drive: "C" }) }, mounts: ["c"], env: {} });
  expect((await probeDisk(ctx.run, noPs.deps)).volumes.find((v) => v.kind === "host")?.freeBytes).toBe(50 * GIB);

  const healthy = fakeDeps({ df: base });
  expect((await probeDisk(ctx.run, healthy.deps)).ok).toBe(true);
  expect(healthy.calls.every((c) => c.argv[0] === "df")).toBe(true);
});

test("preflight fails fast on low disk and never reaches the baseline worktree", async () => {
  const { ctx, dir } = setup();
  backlog(ctx, [{ id: "a", test: "true" }]);
  const low = await runPreflight(ctx.run, { ledger: null, logFile: join(ctx.logs, "p.log"), needs: [], recheck: true, readDisk: async () => ({ ok: false, detail: "repo 1.0 GiB free (min 20)", volumes: [] }) });
  expect(low.map((c) => c.name)).toEqual(["disk"]);
  expect(low[0].ok).toBe(false);
  expect(existsSync(join(dir, "wt", "_preflight"))).toBe(false);

  const entriesSeen: string[] = [];
  const ok = await runPreflight(ctx.run, {
    ledger: null,
    logFile: join(ctx.logs, "p.log"),
    needs: [],
    recheck: true,
    readDisk: async () => ({ ok: true, detail: "disk ok", volumes: [] }),
    onResult: (c) => entriesSeen.push(c.name),
  });
  expect(ok[0]).toEqual({ name: "disk", ok: true, detail: "disk ok" });
  expect(entriesSeen.length).toBeGreaterThan(1);
});

test("admission waits five minutes, logs disk_wait and resumes once space returns", async () => {
  const { ctx, state } = setup();
  backlog(ctx, [{ id: "a" }]);
  let calls = 0;
  ctx.readDisk = async () => (++calls < 3 ? { ok: false, detail: "repo 1.0 GiB free (min 20)", volumes: [] } : { ok: true, detail: "disk ok", volumes: [] });
  const started: string[] = [];
  const stop = await loop(ctx, [], async (_ctx, chunk) => {
    started.push(chunk.id);
    return { status: "passed", note: "ok", branch: chunk.id };
  });
  expect(stop.reason).toBe("finished");
  expect(started).toEqual(["a"]);
  expect(state.sleeps).toEqual([300_000, 300_000]);
  const waits = entries(ctx).filter((e) => e.event === "disk_wait");
  expect(waits.map((w) => [w.waitedMinutes, w.waitMinutes])).toEqual([[0, 60], [5, 60]]);
  expect(ctx.progressAt).toBe(state.t);
});

test("continuous low space stops with reason disk after the configured wait", async () => {
  const { ctx, state } = setup();
  backlog(ctx, [{ id: "a" }]);
  ctx.readDisk = async () => ({ ok: false, detail: "worktree 0.5 GiB free (min 20)", volumes: [] });
  const stop = await loop(ctx, [], async () => ({ status: "passed", note: "ok", branch: "a" }));
  expect(stop.reason).toBe("disk");
  expect(stop.detail).toContain("60 min");
  expect(state.sleeps).toEqual(Array(12).fill(300_000));
  expect(entries(ctx).filter((e) => e.event === "disk_wait").length).toBe(13);
});

test("a zero wait stops at once and a partial wait clamps the last sleep", async () => {
  const zero = setup();
  backlog(zero.ctx, [{ id: "a" }]);
  zero.ctx.run.disk.waitMinutes = 0;
  zero.ctx.readDisk = async () => ({ ok: false, detail: "low", volumes: [] });
  expect((await loop(zero.ctx, [], async () => ({ status: "passed", note: "ok", branch: "a" }))).reason).toBe("disk");
  expect(zero.state.sleeps).toEqual([]);

  const partial = setup();
  backlog(partial.ctx, [{ id: "a" }]);
  partial.ctx.run.disk.waitMinutes = 12;
  partial.ctx.readDisk = async () => ({ ok: false, detail: "low", volumes: [] });
  expect((await loop(partial.ctx, [], async () => ({ status: "passed", note: "ok", branch: "a" }))).reason).toBe("disk");
  expect(partial.state.sleeps).toEqual([300_000, 300_000, 120_000]);
});

test("recovery at the wait boundary admits, and an earlier deadline wins", async () => {
  const boundary = setup();
  backlog(boundary.ctx, [{ id: "a" }]);
  boundary.ctx.run.disk.waitMinutes = 5;
  let n = 0;
  boundary.ctx.readDisk = async () => (++n === 1 ? { ok: false, detail: "low", volumes: [] } : { ok: true, detail: "disk ok", volumes: [] });
  expect((await loop(boundary.ctx, [], async () => ({ status: "passed", note: "ok", branch: "a" }))).reason).toBe("finished");
  expect(boundary.state.sleeps).toEqual([300_000]);

  const deadline = setup();
  backlog(deadline.ctx, [{ id: "a" }]);
  deadline.ctx.capAtMs = deadline.state.t + 40 * 60_000;
  deadline.ctx.readDisk = async () => ({ ok: false, detail: "low", volumes: [] });
  const stop = await loop(deadline.ctx, [], async () => ({ status: "passed", note: "ok", branch: "a" }));
  expect(stop.reason).toBe("safety_cap");
  expect(deadline.state.sleeps).toEqual([300_000, 300_000, 300_000, 300_000]);
});

test("a dry run stops on low disk without waiting, and never stops after the backlog is done", async () => {
  const dry = setup();
  dry.ctx.dryRun = true;
  backlog(dry.ctx, [{ id: "a" }]);
  dry.ctx.readDisk = async () => ({ ok: false, detail: "low", volumes: [] });
  expect((await loop(dry.ctx, [])).reason).toBe("disk");
  expect(dry.state.sleeps).toEqual([]);

  const done = setup();
  backlog(done.ctx, [{ id: "a", status: "passed" }]);
  done.ctx.readDisk = async () => ({ ok: false, detail: "low", volumes: [] });
  expect((await loop(done.ctx, [], async () => ({ status: "passed", note: "ok", branch: "a" }))).reason).toBe("finished");
  expect(done.state.sleeps).toEqual([]);
});

test("running chunks are never interrupted, a hold polls, and recovery fills the free slot", async () => {
  const { ctx, state } = setup();
  ctx.run.concurrency = 2;
  backlog(ctx, [{ id: "a" }, { id: "b" }, { id: "c" }]);
  const open = new Map<string, (o: Outcome & { branch: string }) => void>();
  const started: string[] = [];
  const run = (_ctx: Ctx, chunk: Chunk) => new Promise<Outcome & { branch: string }>((resolve) => {
    started.push(chunk.id);
    open.set(chunk.id, resolve);
  });
  const finish = (id: string) => {
    const r = open.get(id);
    if (!r) throw new Error(`${id} is not running`);
    open.delete(id);
    r({ status: "passed", note: "ok", branch: id });
  };
  const ok: DiskSample = { ok: true, detail: "disk ok", volumes: [] };
  const lowSample: DiskSample = { ok: false, detail: "low", volumes: [] };
  const samples = [ok, ok, lowSample, lowSample, ok, ok];
  ctx.readDisk = async () => samples.shift() ?? ok;
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const done = loop(ctx, [], run);
  await flush();
  expect(started).toEqual(["a", "b"]);
  finish("a");
  for (let i = 0; i < 12 && !started.includes("c"); i++) await flush();
  expect(started).toEqual(["a", "b", "c"]);
  expect(open.has("b")).toBe(true); // the running chunk was never interrupted by the guard
  expect(state.sleeps).toEqual([300_000]); // one poll tick, then the recovered probe admits c
  finish("b");
  finish("c");
  expect((await done).reason).toBe("finished");
});

test("a disk poll tick re-measures even when dispatch is held", async () => {
  const { ctx, state } = setup();
  ctx.run.concurrency = 2;
  backlog(ctx, [{ id: "a" }, { id: "b" }, { id: "c" }]);
  const open = new Map<string, (o: Outcome & { branch: string }) => void>();
  const started: string[] = [];
  const run = (_ctx: Ctx, chunk: Chunk) => new Promise<Outcome & { branch: string }>((resolve) => {
    started.push(chunk.id);
    open.set(chunk.id, resolve);
  });
  const finish = (id: string) => {
    const r = open.get(id);
    if (!r) throw new Error(`${id} is not running`);
    open.delete(id);
    r({ status: "passed", note: "ok", branch: id });
  };
  const ok: DiskSample = { ok: true, detail: "disk ok", volumes: [] };
  const lowSample: DiskSample = { ok: false, detail: "low", volumes: [] };
  ctx.readDisk = async () => ok;
  // The quota goes stale as soon as the low episode is known, so every later fill() holds before the disk gate.
  let usageCalls = 0;
  ctx.readUsage = async () => {
    usageCalls += 1;
    return usageCalls > 3 ? exhausted(state.t + 5 * HOUR) : healthy();
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const done = loop(ctx, [], run);
  await flush();
  expect(started).toEqual(["a", "b"]);
  ctx.readDisk = async () => lowSample;
  finish("a");
  await flush();
  for (let i = 0; i < 4; i++) await flush();
  expect(state.sleeps.length).toBeGreaterThan(0);
  expect(state.sleeps.every((ms) => ms === 300_000)).toBe(true); // a held dispatch never re-arms a 0 ms timer
  finish("b");
  expect((await done).reason).toBe("disk");
  expect(started).toEqual(["a", "b"]);
});
