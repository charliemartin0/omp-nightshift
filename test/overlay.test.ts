import { expect, test } from "bun:test";
import { buildOverlay } from "../src/overlay";
import roles from "./fixtures/roles.json";
import chains from "./fixtures/chains.json";

test("real config: no cursor or opus", () => {
  const y = buildOverlay(roles, chains);
  expect(y).not.toMatch(/cursor\//);
  expect(y).not.toMatch(/opus/i);
  expect(y).toContain('"slow": "@default"');
  expect(y).toContain('"plan": "@default"');
  expect(y).toContain('notify: "off"');
});

test("smol chain keeps only openai entries", () => {
  expect(buildOverlay(roles, chains)).toContain('"smol": ["openai-codex/gpt-6-luna"]');
});

test("all base chain keys emitted even if absent", () => {
  const y = buildOverlay(roles, {});
  for (const k of ["default", "task", "slow", "plan", "smol", "commit"]) expect(y).toContain(`"${k}": []`);
});

test("default role opus or cursor throws", () => {
  expect(() => buildOverlay({ ...roles, default: "anthropic/claude-opus-5-5" }, chains)).toThrow(
    "overlay: default role is anthropic/claude-opus-5-5; no Opus/Cursor allowed",
  );
  expect(() => buildOverlay({ ...roles, default: "cursor/x" }, chains)).toThrow(/no Opus\/Cursor/);
});
