import { expect, test } from "bun:test";
import { evaluateQuota } from "../src/quota";
import usage from "./fixtures/usage.json";

const floors = { anthropic: 0.25, "openai-codex": 0.5 };
const clone = () => structuredClone(usage) as any;
const rep = (u: any, p: string) => u.reports.find((r: any) => r.provider === p);
const lim = (u: any, p: string, w: string) => rep(u, p).limits.find((l: any) => l.scope.windowId === w);

test("default floors ok", () => expect(evaluateQuota(usage, floors)).toEqual({ ok: true }));

test("anthropic 7d below floor", () => {
  const u = clone();
  lim(u, "anthropic", "7d").amount.remainingFraction = 0.2;
  expect(evaluateQuota(u, floors)).toEqual({ ok: false, reason: "quota_floor", detail: "anthropic 7d 0.20 < 0.25" });
});

test("openai 7d below floor", () => {
  const u = clone();
  lim(u, "openai-codex", "7d").amount.remainingFraction = 0.4;
  const r = evaluateQuota(u, floors);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("quota_floor");
});

test("metadata.limitReached", () => {
  const u = clone();
  rep(u, "openai-codex").metadata.limitReached = true;
  const r = evaluateQuota(u, floors);
  expect(r.ok === false && r.reason).toBe("quota_limit_reached");
});

test("5h window exhausted", () => {
  const u = clone();
  lim(u, "anthropic", "5h").amount.remainingFraction = 0;
  const r = evaluateQuota(u, floors);
  expect(r.ok === false && r.reason).toBe("quota_limit_reached");
});

test("floor provider missing from reports", () => {
  const r = evaluateQuota(usage, { ...floors, google: 0.1 });
  expect(r.ok === false && r.reason).toBe("quota_unknown");
});

test("garbage usage is unknown", () => {
  const r = evaluateQuota(null, floors);
  expect(r.ok === false && r.reason).toBe("quota_unknown");
});

test("cursor at 0 is never consulted", () => {
  const u = clone();
  rep(u, "cursor").limits[0].amount.remainingFraction = 0;
  expect(evaluateQuota(u, floors)).toEqual({ ok: true });
});

test("multiple anthropic accounts: max 7d wins", () => {
  const u = clone();
  const second = structuredClone(rep(u, "anthropic"));
  lim({ reports: [second] }, "anthropic", "7d").amount.remainingFraction = 0.1;
  lim(u, "anthropic", "7d").amount.remainingFraction = 0.4;
  u.reports.push(second);
  expect(evaluateQuota(u, floors)).toEqual({ ok: true });
});
