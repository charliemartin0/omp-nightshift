import { expect, test } from "bun:test";
import { parseFailedTests, runGate, withFlakySection } from "../src/gate";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx } from "../src/ctx";
import { validateRunJson } from "../src/runjson";
import { parseBacklog } from "../src/backlog";
const vitest = await Bun.file(new URL("./fixtures/vitest-flaky.log", import.meta.url)).text();
const dotnet = await Bun.file(new URL("./fixtures/dotnet-flaky.log", import.meta.url)).text();

test("vitest evidence names two flaky tests and their messages", () => {
  const tests = parseFailedTests(vitest);
  expect(tests).toHaveLength(2);
  expect(tests[0].name.startsWith("platform-admin apps/platform-admin/src/screens/PlanWizardScreen.test.tsx > PlanWizardScreen > saves a brand")).toBe(true);
  expect(tests[0].message).toBe("Error: Test timed out in 5000ms.");
  expect(tests[1].name).toContain("PlansTab > shows live inventory");
});
test("dotnet evidence extracts Error Message after Failed test", () => {
  const tests = parseFailedTests(dotnet);
  expect(tests).toHaveLength(1);
  expect(tests[0].name).toBe("Acme.Platform.IntegrationTests.Handlers.Orders.OrdersHealthTransitionRecorderTests.RecordSnapshots_persists_transition_on_state_change_and_skips_duplicates");
  expect(tests[0].message.startsWith("Acme.Platform.Domain.Exceptions.DomainArgumentException : Modified date cannot be earlier")).toBe(true);
});
test("jest ignores Console, deduplicates, caps names and messages, and falls back", () => {
  expect(parseFailedTests(" ● Console\nnoise\n ● Checkout > saves\n\n error\n ● Checkout > saves\nother")).toEqual([{ name: "Checkout > saves", message: "error" }]);
  const tests = parseFailedTests(Array.from({ length: 15 }, (_, i) => ` FAIL test ${i}\n${"x".repeat(400)}`).join("\n"));
  expect(tests).toHaveLength(10);
  expect(tests[0].message).toHaveLength(300);
  expect(parseFailedTests("unknown log\nlast line\n\n")).toEqual([{ name: "(unparsed)", message: "last line" }]);
});
test("flaky section replaces its predecessor and keeps following notes", () => {
  const body = "## Summary\nHello\n\n## Flaky tests\nold content\n\n## Notes\nkeep me\n";
  const out = withFlakySection(body, [{ name: "Plan saves", message: "timeout" }], 3);
  expect(out).not.toContain("old content");
  expect(out).toContain("## Notes\nkeep me");
  expect(out).toContain("run 3 failed.");
  expect(out).toContain("- `Plan saves`: timeout");
  expect(out.match(/## Flaky tests/g)).toHaveLength(1);
  expect(withFlakySection(out, [{ name: "Plan saves", message: "timeout" }], 3)).toBe(out);
});

test("a flaky gate attributes only its current failure when logs contain an earlier attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-attempt-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    git("init", "--initial-branch=main");
    git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "--allow-empty", "-m", "baseline");
    const startSha = git("rev-parse", "HEAD");
    git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "--allow-empty", "-m", "change");
    const ctx = makeCtx(validateRunJson({
      version: 1, repo, repoName: "gate-qa", date: "2026-07-01", goal: "QA",
      runDir: dir, worktreeRoot: join(dir, "wt"), unit: "omp-overnight-gate-qa",
      remote: "origin", trunk: "main", forge: "local", prMode: "independent", maxPrs: 1,
      floors: {}, models: { plan: "@plan", build: "@default", report: "@smol" },
      setupCommand: "", preflightTest: "true", limits: {},
    }), false);
    writeFileSync(join(ctx.logs, "fe-a-test-1.log"), " FAIL Old test\nold failure\n");
    const command = `if [ ! -f '${dir}/ran' ]; then touch '${dir}/ran'; printf ' FAIL Current test\\ncurrent failure\\n'; exit 1; fi`;
    const chunk = parseBacklog(`## fe-a\n- status: pending\n- scope: QA\n- done-when: QA\n- test: ${command}\n- prod-code: no\n`).chunks[0];
    const gate = await runGate({ ctx, chunk, wt: repo, branch: "main", startSha, prBase: "main", slug: "local/qa" });
    expect(gate.flaky).toBe(true);
    const entry = readFileSync(ctx.ledger.file, "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((entry) => entry.event === "gate");
    expect(entry.flakyTests).toEqual([{ name: "Current test", message: "current failure" }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
