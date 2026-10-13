import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../src/git";
import { readLedger } from "../src/ledger";
import { backlog, healthy, setup } from "./helpers";

test("dry cleanup refusal preserves the worktree, cleans the others, and still records a report", async () => {
  const { ctx, dir } = setup();
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const power = join(dir, "power");
  for (const path of [repo, bin, power]) mkdirSync(path);
  for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.invalid"], ["config", "commit.gpgsign", "false"], ["config", "core.hooksPath", "/dev/null"], ["commit", "-q", "--allow-empty", "-m", "base"]]) {
    expect((await git(repo, args)).code).toBe(0);
  }
  ctx.run.repo = repo;
  const realGit = Bun.which("git");
  expect(realGit).not.toBeNull();
  const wrapper = join(bin, "git");
  writeFileSync(wrapper, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("worktree") && args.includes("remove") && args.at(-1).endsWith("/_dry-a")) {
  console.error("worktree cleanup refused"); process.exit(44);
}
const child = Bun.spawn([${JSON.stringify(realGit)}, ...args], { stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
`);
  chmodSync(wrapper, 0o755);
  const omp = join(bin, "omp");
  writeFileSync(omp, `#!${process.execPath}
if (process.argv[2] === "usage") console.log(${JSON.stringify(JSON.stringify(healthy()))});
else if (process.argv[2] === "config") console.log('{"value":{}}');
else process.exit(2);
`);
  chmodSync(omp, 0o755);
  backlog(ctx, [{ id: "a" }, { id: "b" }]);
  const config = join(dir, "run.json");
  writeFileSync(config, JSON.stringify(ctx.run));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "run", config, "--dry-run"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, OMP_OVERNIGHT_POWER_DIR: power },
    stdout: "pipe", stderr: "pipe",
  });
  const drained = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited).toBe(1);
  await drained;
  const ledger = readLedger(join(dir, "ledger.dry-run.jsonl"));
  expect(ledger.filter((entry) => entry.event === "cleanup_error")).toHaveLength(1);
  expect(ledger.find((entry) => entry.event === "stop")).toMatchObject({ reason: "runner_error" });
  expect(ledger.filter((entry) => entry.event === "report")).toHaveLength(1);
  expect(readFileSync(join(dir, "report.dry-run.md"), "utf8")).toContain("runner_error");
  expect(existsSync(join(ctx.run.worktreeRoot, "_dry-a"))).toBe(true);
  expect(existsSync(join(ctx.run.worktreeRoot, "_dry-b"))).toBe(false);
});
