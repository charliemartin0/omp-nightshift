import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../src/git";
import { readLines } from "../src/proc";
import { REPO_LOCK_WRAPPER, repoLockPath, withRepoLock } from "../src/repolock";
import { setup } from "./helpers";

function fixture() {
  const { dir } = setup();
  const repo = join(dir, "repo with 'quote");
  mkdirSync(repo);
  for (const args of [["init", "-q", "-b", "main"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  return { repo, dir };
}

test("runner callbacks and agent wrappers share flock across processes and linked worktrees", async () => {
  const { repo, dir } = fixture();
  const wt = join(dir, "linked worktree");
  expect((await git(repo, ["worktree", "add", "--detach", wt, "HEAD"])).code).toBe(0);
  expect(await repoLockPath(repo)).toBe(await repoLockPath(wt));
  const barrier = join(dir, "barrier");
  mkdirSync(barrier);
  const script = join(dir, "runner-lock.ts");
  writeFileSync(script, `import { mkdirSync, appendFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { withRepoLock } from ${JSON.stringify(join(import.meta.dir, "../src/repolock"))};
import { readLines } from ${JSON.stringify(join(import.meta.dir, "../src/proc"))};
const [repo, barrier, label] = process.argv.slice(2);
await withRepoLock(repo, async () => {
  mkdirSync(join(barrier, "active"));
  appendFileSync(join(barrier, "order"), label + "-start\\n");
  console.log(label);
  await readLines(Bun.stdin.stream()).next();
  appendFileSync(join(barrier, "order"), label + "-end\\n");
  rmdirSync(join(barrier, "active"));
});
`);
  const critical = 'mkdir "$1/active" || exit 9; printf "%s-start\\n" "$2" >> "$1/order"; printf "%s\\n" "$2"; read -r release; printf "%s-end\\n" "$2" >> "$1/order"; rmdir "$1/active"';
  const children = Array.from({ length: 8 }, (_, index) => index % 2 === 0
    ? Bun.spawn([process.execPath, script, index % 4 === 0 ? repo : wt, barrier, `runner${index}`], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })
    : Bun.spawn(["sh", "-c", `${REPO_LOCK_WRAPPER}\novernight_repo "$@"`, "agent", "sh", "-c", critical, "critical", barrier, `agent${index}`], { cwd: wt, stdin: "pipe", stdout: "pipe", stderr: "inherit" }));
  const ready = new Map(children.map((child, index) => [index, readLines(child.stdout).next().then((line) => ({ index, line }))]));
  try {
    while (ready.size) {
      const { index, line } = await Promise.race(ready.values());
      expect(line.done).toBe(false);
      expect(line.value).toBe(`${index % 2 === 0 ? "runner" : "agent"}${index}`);
      children[index].stdin.write("release\n");
      children[index].stdin.end();
      expect(await children[index].exited).toBe(0);
      ready.delete(index);
    }
  } finally {
    for (const child of children) {
      child.stdin.end();
      child.kill();
    }
    await Promise.all(children.map((child) => child.exited));
  }
  const order = readFileSync(join(barrier, "order"), "utf8").trim().split("\n");
  expect(order).toHaveLength(16);
  for (let index = 0; index < order.length; index += 2) {
    expect(order[index]).toMatch(/-start$/);
    expect(order[index + 1]).toBe(order[index].replace(/-start$/, "-end"));
  }
}, 15_000);

test("runner callback holds an actual flock until it returns", async () => {
  const { repo } = fixture();
  const path = await repoLockPath(repo);
  await withRepoLock(repo, async () => {
    const contender = Bun.spawn(["flock", "-n", "--", path, "true"], { stdout: "ignore", stderr: "inherit" });
    expect(await contender.exited).toBe(1);
  });
  const contender = Bun.spawn(["flock", "-n", "--", path, "true"], { stdout: "ignore", stderr: "inherit" });
  expect(await contender.exited).toBe(0);
});

test("nested runner mutations do not deadlock and rejected callbacks release flock", async () => {
  const { repo } = fixture();
  await expect(withRepoLock(repo, async () => {
    await withRepoLock(repo, async () => {
      expect((await git(repo, ["branch", "nested", "HEAD"])).code).toBe(0);
    });
    throw new Error("callback failed");
  })).rejects.toThrow("callback failed");
  await withRepoLock(repo, async () => {
    expect((await git(repo, ["branch", "after", "HEAD"])).code).toBe(0);
  });
}, 5_000);

test("contended acquisition expires without running the mutation or leaving a queued callback", async () => {
  const { repo } = fixture();
  const path = await repoLockPath(repo);
  const holder = Bun.spawn(["flock", "-x", "--", path, "sh", "-c", "printf 'held\\n'; read -r release || true"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const lines = readLines(holder.stdout);
  expect((await lines.next()).value).toBe("held");
  let invoked = false;
  try {
    // Zero wait exercises the platform's real contention failure deterministically, without test sleeps.
    await expect(withRepoLock(repo, async () => { invoked = true; }, 0)).rejects.toThrow("repository flock timed out");
    expect(invoked).toBe(false);
  } finally {
    holder.stdin.write("release\n");
    holder.stdin.end();
    await holder.exited;
  }
  await withRepoLock(repo, async () => { expect(invoked).toBe(false); }, 0);
}, 5_000);
