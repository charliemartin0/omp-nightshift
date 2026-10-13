import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseBacklog } from "../src/backlog";
import { chunksBlockedBy, preflightRequirements, preflightTimeoutMs, runPreflight } from "../src/preflight";
import { backlog, setup } from "./helpers";

test("preflight blocks only pending chunks needing the failed tool", () => {
  const { ctx } = setup();
  backlog(ctx, [{ id: "a", needs: "docker" }, { id: "b", test: "dotnet test X" }, { id: "c" }, { id: "d", needs: "browser", status: "passed" }]);
  const chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
  const blocked = chunksBlockedBy(chunks, [
    { name: "docker", need: "docker", ok: false, detail: "socket denied\ntry permissions" },
    { name: "browser", need: "browser", ok: false, detail: "missing" },
    { name: "dotnet", need: "dotnet", ok: true, detail: "restored" },
  ]);
  expect(blocked).toEqual([{ id: "a", note: "env: preflight docker: socket denied try permissions" }]);
  expect(preflightRequirements(chunks)).toEqual({ needs: ["docker", "dotnet"], dotnetTarget: "X" });
});

test("dotnet targets respect quoted paths and ignore options", () => {
  const { ctx } = setup();
  backlog(ctx, [{ id: "a", test: 'dotnet test "test space.sln" --no-restore' }]);
  let chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
  expect(preflightRequirements(chunks).dotnetTarget).toBe("test space.sln");
  chunks = [{ ...chunks[0], test: "dotnet test --no-restore" }];
  expect(preflightRequirements(chunks).dotnetTarget).toBeUndefined();
});

test("dotnet requirements retain conventional cd working directories", () => {
  const { ctx } = setup();
  backlog(ctx, [{ id: "a", test: "cd Backend && dotnet test Tests/Tests.csproj" }]);
  let chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
  expect(preflightRequirements(chunks)).toEqual({ needs: ["dotnet"], dotnetCwd: "Backend", dotnetTarget: "Tests/Tests.csproj" });
  chunks = [{ ...chunks[0], test: 'cd "Backend Space" && dotnet test "Tests/Space Tests.csproj"' }];
  expect(preflightRequirements(chunks).dotnetCwd).toBe("Backend Space");
  expect(preflightRequirements(chunks).dotnetTarget).toBe("Tests/Space Tests.csproj");
});

test("dotnet preflight restores the relative target from the test's cd directory", async () => {
  const { ctx, dir } = setup();
  mkdirSync(join(dir, "Backend", "Tests"), { recursive: true });
  writeFileSync(join(dir, "Backend", "Tests", "Tests.csproj"), "<Project />\n");
  const git = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr || `git exit ${r.status}`);
  };
  git(["init", "-b", "main"]);
  git(["add", "Backend/Tests/Tests.csproj"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "fixture"]);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const dotnet = join(bin, "dotnet");
  writeFileSync(dotnet, '#!/bin/sh\nprintf "%s %s\\n" "$PWD" "$*"\n[ "$1" = restore ] && [ -f "$2" ]\n');
  chmodSync(dotnet, 0o755);
  backlog(ctx, [{ id: "a", test: "cd Backend && dotnet test Tests/Tests.csproj" }]);
  const chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${oldPath ?? ""}`;
    const logFile = join(ctx.logs, "preflight-cwd.log");
    const checks = await runPreflight(ctx.run, { ledger: null, logFile, recheck: true, ...preflightRequirements(chunks) });
    expect(checks.find((c) => c.name === "dotnet")?.ok).toBe(true);
    expect(readFileSync(logFile, "utf8")).toContain("_preflight/Backend restore Tests/Tests.csproj");
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

test("preflight timeout budget caps commands and retry delays; expired deadlines start no I/O", async () => {
  const { ctx, state } = setup();
  const deadlineAtMs = state.t + 5000;
  expect(preflightTimeoutMs({ deadlineAtMs, clock: ctx.clock }, 60_000)).toBe(5000);
  expect(preflightTimeoutMs({ deadlineAtMs, clock: ctx.clock }, 1000)).toBe(1000);
  expect(preflightTimeoutMs({}, 60_000)).toBe(60_000);
  state.t = deadlineAtMs;
  expect(() => preflightTimeoutMs({ deadlineAtMs, clock: ctx.clock }, 15_000)).toThrow("preflight deadline reached");
  const checks = await runPreflight(ctx.run, { ledger: null, logFile: join(ctx.logs, "never.log"), needs: ["docker"], recheck: true, deadlineAtMs, clock: ctx.clock });
  expect(checks.find((c) => c.name === "forge_auth")?.ok).toBe(true);
  expect(checks.filter((c) => c.name !== "forge_auth").every((c) => !c.ok && c.detail === "preflight deadline reached")).toBe(true);
  expect(state.sleeps).toEqual([]);
});
