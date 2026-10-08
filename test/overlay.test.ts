import { expect, test } from "bun:test";
import { buildChainProviders, buildOverlay } from "../src/overlay";
import { validateRunJson } from "../src/runjson";
import roles from "./fixtures/roles.json";
import chains from "./fixtures/chains.json";

test("real config keeps every chain entry and role", () => {
  const y = buildOverlay(roles, chains, 40);
  for (const [k, entries] of Object.entries(chains)) {
    expect(y).toContain(`"${k}": [${entries.map((e) => JSON.stringify(e)).join(", ")}]`);
  }
  expect(y).toContain('"plan": "anthropic/claude-opus-5-5"');
  expect(y).toContain("cursor/grok-4.7");
  expect(y).toContain('notify: "off"');
});

test("reservePct honoured, default 40", () => {
  const y = buildOverlay(roles, chains, 60);
  expect(y).toContain("usageReservePct: 60");
  expect(y).toContain("waitForUsageReset: false");
  const run = {
    version: 1, repo: "/tmp", repoName: "r", date: "2026-01-01", goal: "g", runDir: "/tmp/x", worktreeRoot: "/tmp/wt",
    unit: "omp-overnight-r", remote: "origin", trunk: "main", forge: "local", prMode: "independent", stopAt: "06:00",
    maxPrs: 3, floors: {}, models: { plan: "p", build: "b", report: "r" }, setupCommand: "", preflightTest: "true", limits: {},
  };
  expect(validateRunJson(run).reservePct).toBe(40);
  expect(validateRunJson({ ...run, reservePct: 30 }).reservePct).toBe(30);
});

test("empty chains stay valid yaml", () => {
  expect(buildOverlay(roles, {}, 40)).toContain("  fallbackChains: {}\n");
});

test("buildChainProviders follows role + chain order", () => {
  expect(buildChainProviders("@smol", roles, chains)).toEqual(["anthropic", "openai-codex", "cursor", "opencode-go"]);
  expect(buildChainProviders("openai-codex/x", roles, chains)).toEqual(["openai-codex"]);
});
