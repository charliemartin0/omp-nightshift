import { expect, test } from "bun:test";
import { assertNoFreeModels, buildChainProviders, buildOverlay, isFreeModel, withoutFreeModels } from "../src/overlay";
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

const withFree = { ...chains, default: [...chains.default, "opencode-go/step-5-preview-free", "x/longcat-preview:free"], task: ["opencode-go/only-free"] };

test("free-tier models are stripped from every fallback chain and never reach the overlay", () => {
  expect(isFreeModel("opencode-go/step-5-preview-free")).toBe(true);
  expect(isFreeModel("x/y:free")).toBe(true);
  expect(isFreeModel("opencode-go/freedom-pro")).toBe(false);
  expect(isFreeModel("cursor/grok-4.7")).toBe(false);
  expect(withoutFreeModels(withFree).default).toEqual(chains.default);
  const y = buildOverlay(roles, withFree, 40);
  expect(y).not.toContain("free");
  expect(y).toContain('"default": [' + chains.default.map((e) => JSON.stringify(e)).join(", ") + "]");
});

test("a chain made only of free models is left empty rather than dropped", () => {
  expect(withoutFreeModels({ task: ["a/b-free"] })).toEqual({ task: [] });
  expect(buildOverlay(roles, { task: ["a/b-free"] }, 40)).toContain('"task": []');
});

test("free models do not contribute providers to the quota chain", () => {
  expect(buildChainProviders("@default", roles, { default: ["only-free-provider/model-free", "cursor/grok-4.7"] })).toEqual(["anthropic", "cursor"]);
  expect(buildChainProviders("only-free-provider/model-free", roles, {})).toEqual([]);
});

test("a run configured to use a free model directly is rejected", () => {
  expect(() => assertNoFreeModels({ plan: "@default", build: "@smol", report: "@smol" }, roles)).not.toThrow();
  expect(() => assertNoFreeModels({ plan: "x/y-free", build: "@smol", report: "@smol" }, roles)).toThrow(/free model/);
  expect(() => assertNoFreeModels({ plan: "@cheap", build: "@smol", report: "@smol" }, { ...roles, cheap: "x/y:free" })).toThrow(/models\.plan/);
});
