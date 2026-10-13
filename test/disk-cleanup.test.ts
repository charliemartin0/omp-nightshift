import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTerminalStatus, reclaimChunkOutput } from "../src/chunk";
import { cleanupBuildOutputs } from "../src/cleanup";
import { git } from "../src/git";
import { readLedger } from "../src/ledger";
import { entries, setup } from "./helpers";

// A generic commit identity, never the machine's own.
const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  base: string;
  repo: string;
  root: string;
  wt: string;
}

/** A real repository with one linked worktree registered at `<root>/chunk`. */
async function fixture(): Promise<Fixture> {
  const base = mkdtempSync(join(tmpdir(), "overnight-cleanup-"));
  dirs.push(base);
  const repo = join(base, "repo");
  mkdirSync(repo);
  expect((await git(repo, ["init", "-q", "-b", "main"])).code).toBe(0);
  writeFileSync(join(repo, "README.md"), "root\n");
  expect((await git(repo, ["add", "README.md"])).code).toBe(0);
  expect((await git(repo, [...IDENTITY, "commit", "-q", "-m", "base"])).code).toBe(0);
  const rootPath = join(base, "wt");
  mkdirSync(rootPath);
  const root = realpathSync(rootPath);
  const wt = join(root, "chunk");
  expect((await git(repo, ["worktree", "add", "-q", "-b", "overnight/2026-07-01-chunk", wt, "HEAD"])).code).toBe(0);
  return { base, repo, root, wt: realpathSync(wt) };
}

async function commitAll(wt: string, paths: string[], message: string): Promise<void> {
  expect((await git(wt, ["add", "--", ...paths])).code).toBe(0);
  expect((await git(wt, [...IDENTITY, "commit", "-q", "-m", message])).code).toBe(0);
}

test("removes nested output files with an exact reclaimed-byte count and leaves other files", async () => {
  const f = await fixture();
  mkdirSync(join(f.wt, "dist", "nested"), { recursive: true });
  writeFileSync(join(f.wt, "dist", "nested", "bundle.js"), "x".repeat(1234));
  mkdirSync(join(f.wt, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(f.wt, "node_modules", "pkg", "index.js"), "y".repeat(77));
  mkdirSync(join(f.wt, "src"), { recursive: true });
  writeFileSync(join(f.wt, "src", "keep.ts"), "keep");
  const result = await cleanupBuildOutputs(f.root, f.wt);
  expect(result).toEqual({ reclaimedBytes: 1234 + 77, removedFiles: 2, refused: [] });
  expect(existsSync(join(f.wt, "dist"))).toBe(false);
  expect(existsSync(join(f.wt, "node_modules"))).toBe(false);
  expect(readFileSync(join(f.wt, "src", "keep.ts"), "utf8")).toBe("keep");
});

test("preserves tracked files and tracked symlinks inside an allowed directory along with the directory", async () => {
  const f = await fixture();
  const nodeModules = join(f.wt, "node_modules");
  mkdirSync(nodeModules);
  writeFileSync(join(nodeModules, "lock.json"), "{}");
  symlinkSync("../README.md", join(nodeModules, "readme-link"));
  await commitAll(f.wt, ["node_modules/lock.json", "node_modules/readme-link"], "track generated metadata");
  writeFileSync(join(nodeModules, "scratch.bin"), "z".repeat(9));
  const result = await cleanupBuildOutputs(f.root, f.wt);
  expect(result).toEqual({ reclaimedBytes: 9, removedFiles: 1, refused: [] });
  expect(existsSync(nodeModules)).toBe(true);
  expect(readFileSync(join(nodeModules, "lock.json"), "utf8")).toBe("{}");
  expect(lstatSync(join(nodeModules, "readme-link")).isSymbolicLink()).toBe(true);
  expect(existsSync(join(nodeModules, "scratch.bin"))).toBe(false);
});

test("preserves non-allowlisted files, a sibling worktree and files outside the root", async () => {
  const f = await fixture();
  mkdirSync(join(f.wt, "dist"));
  writeFileSync(join(f.wt, "dist", "x.js"), "x");
  mkdirSync(join(f.wt, "docs"));
  writeFileSync(join(f.wt, "docs", "guide.md"), "guide");
  writeFileSync(join(f.base, "outside.txt"), "outside");
  const sibling = join(f.root, "sibling");
  expect((await git(f.repo, ["worktree", "add", "-q", "-b", "sibling-worktree", sibling, "HEAD"])).code).toBe(0);
  mkdirSync(join(sibling, "dist"));
  writeFileSync(join(sibling, "dist", "keep.js"), "keep");
  const result = await cleanupBuildOutputs(f.root, f.wt);
  expect(result).toEqual({ reclaimedBytes: 1, removedFiles: 1, refused: [] });
  expect(readFileSync(join(f.wt, "docs", "guide.md"), "utf8")).toBe("guide");
  expect(readFileSync(join(f.base, "outside.txt"), "utf8")).toBe("outside");
  expect(readFileSync(join(sibling, "dist", "keep.js"), "utf8")).toBe("keep");
});

test("refuses a prefix-confusable worktree path and preserves its contents", async () => {
  const f = await fixture();
  const evil = join(f.base, "wt-evil");
  mkdirSync(join(evil, "node_modules"), { recursive: true });
  writeFileSync(join(evil, "node_modules", "x.js"), "e");
  const result = await cleanupBuildOutputs(f.root, evil);
  expect(result).toEqual({ reclaimedBytes: 0, removedFiles: 0, refused: ["worktree is not beneath the worktree root"] });
  expect(readFileSync(join(evil, "node_modules", "x.js"), "utf8")).toBe("e");
});

test("refuses a symlinked worktree, a symlinked output directory and a symlinked file without touching targets", async () => {
  const f = await fixture();
  // symlinked worktree
  const realWt = join(f.root, "real-wt");
  mkdirSync(join(realWt, "node_modules"), { recursive: true });
  writeFileSync(join(realWt, "node_modules", "x.js"), "r");
  const linkWt = join(f.root, "link-wt");
  symlinkSync(realWt, linkWt);
  const linked = await cleanupBuildOutputs(f.root, linkWt);
  expect(linked.reclaimedBytes).toBe(0);
  expect(linked.refused).toEqual(["symlink in worktree path: link-wt"]);
  expect(readFileSync(join(realWt, "node_modules", "x.js"), "utf8")).toBe("r");
  // symlinked output directory
  const external = join(f.base, "external-out");
  mkdirSync(external);
  writeFileSync(join(external, "keep.js"), "k");
  symlinkSync(external, join(f.wt, "node_modules"));
  const linkedDir = await cleanupBuildOutputs(f.root, f.wt);
  expect(linkedDir.refused).toEqual(["node_modules: symlink"]);
  expect(readFileSync(join(external, "keep.js"), "utf8")).toBe("k");
  rmSync(join(f.wt, "node_modules"));
  // symlinked file inside a real output directory
  mkdirSync(join(f.wt, "dist"));
  writeFileSync(join(f.wt, "dist", "real.js"), "12345");
  symlinkSync("real.js", join(f.wt, "dist", "link.js"));
  const linkedFile = await cleanupBuildOutputs(f.root, f.wt);
  expect(linkedFile.refused).toEqual(["dist/link.js: symlink"]);
  expect(existsSync(join(f.wt, "dist", "real.js"))).toBe(false);
  expect(lstatSync(join(f.wt, "dist", "link.js")).isSymbolicLink()).toBe(true);
});

test("skips a nested repository boundary", async () => {
  const f = await fixture();
  mkdirSync(join(f.wt, "nested", ".git"), { recursive: true });
  writeFileSync(join(f.wt, "nested", ".git", "config"), "[core]\n");
  mkdirSync(join(f.wt, "nested", "node_modules"), { recursive: true });
  writeFileSync(join(f.wt, "nested", "node_modules", "x.js"), "n");
  mkdirSync(join(f.wt, "dist"));
  writeFileSync(join(f.wt, "dist", "y.js"), "y");
  const result = await cleanupBuildOutputs(f.root, f.wt);
  expect(result).toEqual({ reclaimedBytes: 1, removedFiles: 1, refused: [] });
  expect(readFileSync(join(f.wt, "nested", "node_modules", "x.js"), "utf8")).toBe("n");
  expect(existsSync(join(f.wt, "dist", "y.js"))).toBe(false);
});

test("refuses a non-worktree directory and treats a missing worktree as a zero-byte success", async () => {
  const f = await fixture();
  const plain = join(f.root, "plain");
  mkdirSync(join(plain, "node_modules"), { recursive: true });
  writeFileSync(join(plain, "node_modules", "x.js"), "p");
  const refused = await cleanupBuildOutputs(f.root, plain);
  expect(refused.reclaimedBytes).toBe(0);
  expect(refused.refused).toHaveLength(1);
  expect(readFileSync(join(plain, "node_modules", "x.js"), "utf8")).toBe("p");
  const missing = await cleanupBuildOutputs(f.root, join(f.root, "ghost"));
  expect(missing).toEqual({ reclaimedBytes: 0, removedFiles: 0, refused: [] });
});

test("reclaimChunkOutput logs exactly one disk_cleanup event (the helper runChunk's lifecycle calls)", async () => {
  const f = await fixture();
  mkdirSync(join(f.wt, "dist"));
  writeFileSync(join(f.wt, "dist", "a.js"), "aaaa");
  const { ctx } = setup();
  ctx.run.worktreeRoot = f.root;
  await reclaimChunkOutput(ctx, "chunk", f.wt);
  const events = entries(ctx).filter((entry) => entry.event === "disk_cleanup");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ chunk: "chunk", wt: f.wt, reclaimedBytes: 4, removedFiles: 1, refused: [] });
});

test("reclaimChunkOutput bounds the recorded refusals and still counts them all", async () => {
  const f = await fixture();
  mkdirSync(join(f.wt, "node_modules"), { recursive: true });
  for (let i = 0; i < 25; i++) symlinkSync(join(f.wt, "node_modules"), join(f.wt, "node_modules", `link-${i}`));
  const { ctx } = setup();
  ctx.run.worktreeRoot = f.root;
  await reclaimChunkOutput(ctx, "chunk", f.wt);
  const [event] = entries(ctx).filter((e) => e.event === "disk_cleanup");
  expect(event.refusedCount).toBe(25);
  expect((event.refused as string[]).length).toBe(20);
  expect(event.reclaimedBytes).toBe(0);
  expect(event.removedFiles).toBe(0);
  expect(existsSync(join(f.wt, "node_modules"))).toBe(true);
});

test("reclaimChunkOutput skips everything in dry-run, leaving outputs for the runner to remove", async () => {
  const f = await fixture();
  mkdirSync(join(f.wt, "dist"));
  writeFileSync(join(f.wt, "dist", "a.js"), "aaaa");
  const { ctx } = setup();
  ctx.run.worktreeRoot = f.root;
  ctx.dryRun = true;
  await reclaimChunkOutput(ctx, "chunk", f.wt);
  expect(readLedger(ctx.ledger.file).filter((entry) => entry.event === "disk_cleanup")).toHaveLength(0);
  expect(existsSync(join(f.wt, "dist", "a.js"))).toBe(true);
});

test("a throwing helper becomes a refused disk_cleanup entry instead of an error", async () => {
  const { ctx } = setup();
  Object.defineProperty(ctx.run, "worktreeRoot", {
    get() {
      throw new Error("root unavailable");
    },
  });
  await reclaimChunkOutput(ctx, "chunk", join(ctx.run.runDir, "wt", "chunk"));
  const events = entries(ctx).filter((entry) => entry.event === "disk_cleanup");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ chunk: "chunk", reclaimedBytes: 0, removedFiles: 0, refused: ["root unavailable"] });
});

// Calling the whole runChunk needs a live omp session and the gate, so the reclaim gate is unit-tested here: a
// requeued/pending attempt (or a signal-stopped one) is non-terminal and keeps its worktree outputs.
test("terminal-detection branch: requeue/pending and stopped never reclaim, so their outputs stay", () => {
  for (const status of ["passed", "flaky", "failed", "blocked", "skipped"] as const) expect(isTerminalStatus(status)).toBe(true);
  for (const status of ["pending", "running", "stopped"] as const) expect(isTerminalStatus(status)).toBe(false);
});
