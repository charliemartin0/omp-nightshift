import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBacklog } from "../src/backlog";
import { makeCtx } from "../src/ctx";
import { affectedCommand, runGate } from "../src/gate";
import { validateRunJson } from "../src/runjson";

const BASE = "abc1234";
const RUN = {
  version: 1, repoName: "gate-qa", date: "2026-07-01", goal: "QA", unit: "omp-overnight-gate-qa",
  remote: "origin", trunk: "main", forge: "local", prMode: "independent", maxPrs: 1,
  floors: {}, models: { plan: "@plan", build: "@default", report: "@smol" }, setupCommand: "", preflightTest: "true", limits: {},
};

test("affected commands use each runner's native changed-files flag", () => {
  expect(affectedCommand("cd Frontend && yarn playwright test --project=admin", BASE, [])).toBe(`cd Frontend && yarn playwright test --project=admin --only-changed=${BASE}`);
  expect(affectedCommand("npx vitest run src/a", BASE, [])).toBe(`npx vitest run src/a --changed ${BASE}`);
  expect(affectedCommand("npx jest", BASE, [])).toBe(`npx jest --changedSince=${BASE}`);
  expect(affectedCommand("cd Backend && dotnet test Tests/T.csproj", BASE, ["Backend/Tests/Orders/OrderHandlerTests.cs", "Backend/Src/Order.cs", "Backend/Tests/Orders/OrderHandlerTests.cs"]))
    .toBe('cd Backend && dotnet test Tests/T.csproj --filter "FullyQualifiedName~OrderHandlerTests"');
});

test("affected commands fall back when they cannot be derived safely", () => {
  expect(affectedCommand("dotnet test X.sln", BASE, ["src/Order.cs"])).toBeNull(); // no changed test class
  expect(affectedCommand("dotnet test X.sln --filter Category=Unit", BASE, ["T/ATests.cs"])).toBeNull();
  expect(affectedCommand("npx playwright test --only-changed", BASE, [])).toBeNull();
  expect(affectedCommand("yarn build && npx vitest run", BASE, [])).toBeNull(); // compound command
  expect(affectedCommand("make test", BASE, [])).toBeNull();
});

test("an explicit affected-test wins and substitutes base and files", () => {
  expect(affectedCommand("make test", BASE, ["a b.ts", "c.ts"], "yarn test:e2e:affected --base {base} -- {files}")).toBe(`yarn test:e2e:affected --base ${BASE} -- 'a b.ts' 'c.ts'`);
});

test("gate config defaults to the full strategy with three runs and validates", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-cfg-"));
  try {
    const base = { ...RUN, repo: dir, runDir: dir, worktreeRoot: join(dir, "wt") };
    expect(validateRunJson(base).gate).toEqual({ strategy: "full", repeat: 3 });
    expect(validateRunJson({ ...base, gate: { strategy: "affected", repeat: 5 } }).gate).toEqual({ strategy: "affected", repeat: 5 });
    expect(() => validateRunJson({ ...base, gate: { strategy: "smart" } })).toThrow(/gate|strategy/);
    expect(() => validateRunJson({ ...base, gate: { repeat: 0 } })).toThrow(/gate.repeat/);
    expect(() => validateRunJson({ ...base, gate: { extra: 1 } })).toThrow(/unknown key/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function gateWith(strategy: "full" | "affected", repeat: number, testCmd: (dir: string) => string, affected: (dir: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), "gate-affected-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", repo, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  git("init", "--initial-branch=main");
  git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "--allow-empty", "-m", "baseline");
  const startSha = git("rev-parse", "HEAD");
  git("-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "--allow-empty", "-m", "change");
  const ctx = makeCtx(validateRunJson({ ...RUN, repo, runDir: dir, worktreeRoot: join(dir, "wt"), gate: { strategy, repeat } }), false);
  const md = `## fe-a\n- status: pending\n- scope: QA\n- done-when: QA\n- test: ${testCmd(dir)}\n- affected-test: ${affected(dir)}\n- prod-code: no\n`;
  const chunk = parseBacklog(md).chunks[0];
  const gate = await runGate({ ctx, chunk, wt: repo, branch: "main", startSha, prBase: "main", slug: "local/qa" });
  const ledger = readFileSync(ctx.ledger.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const count = (name: string) => { try { return readFileSync(join(dir, name), "utf8").length; } catch { return 0; } };
  return { gate, ledger, count, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("affected strategy runs the affected command N times and the full test once", async () => {
  const r = await gateWith("affected", 4, (d) => `printf x >> '${d}/full'`, (d) => `printf x >> '${d}/aff'`);
  try {
    expect(r.gate).toMatchObject({ ok: true, flaky: false });
    expect(r.count("aff")).toBe(4);
    expect(r.count("full")).toBe(1);
    expect(r.ledger.find((e) => e.event === "gate_strategy")).toMatchObject({ strategy: "affected" });
    expect(r.ledger.find((e) => e.event === "gate").checks.tests.detail).toBe("tests 5/5");
  } finally { r.cleanup(); }
});

test("an affected run that finds no tests passes", async () => {
  const r = await gateWith("affected", 2, () => "true", (d) => `printf x >> '${d}/aff'; echo 'Error: No tests found'; exit 1`);
  try {
    expect(r.gate).toMatchObject({ ok: true, flaky: false });
    expect(r.count("aff")).toBe(2);
  } finally { r.cleanup(); }
});

test("a full run that passes only on its retry is flaky; failing twice fails", async () => {
  const flaky = await gateWith("affected", 3, (d) => `if [ ! -f '${d}/f1' ]; then touch '${d}/f1'; echo ' FAIL Broad test'; echo boom; exit 1; fi`, () => "true");
  try {
    expect(flaky.gate).toMatchObject({ ok: true, flaky: true });
    expect(flaky.gate.note).toContain("flaky 4/5");
  } finally { flaky.cleanup(); }
  const failed = await gateWith("affected", 3, () => "exit 1", () => "true");
  try { expect(failed.gate.ok).toBe(false); } finally { failed.cleanup(); }
});

test("two failed affected runs fail the gate", async () => {
  const r = await gateWith("affected", 3, () => "true", (d) => `printf x >> '${d}/aff'; [ $(wc -c < '${d}/aff') -gt 2 ]`);
  try { expect(r.gate.ok).toBe(false); } finally { r.cleanup(); }
});

test("full strategy honours gate.repeat and ignores affected-test", async () => {
  const r = await gateWith("full", 2, (d) => `printf x >> '${d}/full'`, (d) => `printf x >> '${d}/aff'`);
  try {
    expect(r.gate).toMatchObject({ ok: true, flaky: false });
    expect(r.count("full")).toBe(2);
    expect(r.count("aff")).toBe(0);
  } finally { r.cleanup(); }
});