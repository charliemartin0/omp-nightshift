import { expect, test } from "bun:test";
import { evaluateQuota } from "../src/quota";
import usage from "./fixtures/usage.json";

const floors = { anthropic: 0.25, "openai-codex": 0.5 };
const chain = ["anthropic", "openai-codex", "cursor"];
const clone = () => structuredClone(usage) as any;
const rep = (u: any, p: string) => u.reports.find((r: any) => r.provider === p);
const lim = (u: any, p: string, w: string) => rep(u, p).limits.find((l: any) => l.scope.windowId === w);
const ev = (u: unknown, f = floors, c = chain) => evaluateQuota(u, f, c, 40);

test("healthy usage ok", () => expect(ev(usage)).toEqual({ ok: true }));

test("anthropic under its floor while openai-codex is usable -> ok", () => {
  const u = clone();
  lim(u, "anthropic", "7d").amount.remainingFraction = 0.2;
  expect(ev(u)).toEqual({ ok: true });
});

test("every chain provider under its floor -> quota_wait on the earliest 7d reset", () => {
  const u = clone();
  lim(u, "anthropic", "7d").amount.remainingFraction = 0.2;
  lim(u, "openai-codex", "7d").amount.remainingFraction = 0.4;
  expect(ev(u, floors, ["anthropic", "openai-codex"])).toEqual({
    ok: false,
    reason: "quota_wait",
    provider: "anthropic",
    window: "7d",
    resetsAt: lim(u, "anthropic", "7d").window.resetsAt,
    detail: `build chain unusable; anthropic 7d resets ${new Date(lim(u, "anthropic", "7d").window.resetsAt).toISOString()}`,
  });
});

test("anthropic under floor, openai 5h exhausted -> quota_wait on openai reset", () => {
  const u = clone();
  const reset = Date.parse("2026-10-08T15:12:00Z"); // before anthropic's own 7d reset (16:00Z), so openai recovers first
  lim(u, "anthropic", "7d").amount.remainingFraction = 0.2;
  lim(u, "openai-codex", "5h").amount.remainingFraction = 0;
  lim(u, "openai-codex", "5h").window.resetsAt = reset;
  expect(ev(u, floors, ["anthropic", "openai-codex"])).toMatchObject({
    ok: false, reason: "quota_wait", provider: "openai-codex", window: "5h", resetsAt: reset,
  });
});

test("providers outside the chain never stop the run", () => {
  const u = clone();
  lim(u, "anthropic", "7d").amount.remainingFraction = 0.2;
  expect(ev(u, floors, ["openai-codex"])).toEqual({ ok: true });
});

test("no chain: a floor breach waits for the 7d reset; a missing report is unknown", () => {
  const u = clone();
  lim(u, "anthropic", "7d").amount.remainingFraction = 0.2;
  expect(ev(u, floors, [])).toEqual({
    ok: false, reason: "quota_wait", provider: "anthropic", window: "7d",
    resetsAt: lim(u, "anthropic", "7d").window.resetsAt, detail: "anthropic 7d 0.20 < 0.25",
  });
  const r = ev(null, floors, []);
  expect(r.ok === false && r.reason).toBe("quota_unknown");
});
test("multiple anthropic accounts: max 7d wins", () => {
  const u = clone();
  const second = structuredClone(rep(u, "anthropic"));
  lim({ reports: [second] }, "anthropic", "7d").amount.remainingFraction = 0.1;
  lim(u, "anthropic", "7d").amount.remainingFraction = 0.4;
  u.reports.push(second);
  expect(ev(u)).toEqual({ ok: true });
});

test("whole chain short-window exhausted -> quota_wait on the earliest reset", () => {
  const u = clone();
  lim(u, "anthropic", "7d").amount.remainingFraction = 0.6; // fixture 0.37 is under the 0.4 reserve, which is unrecoverable
  lim(u, "anthropic", "5h").amount.remainingFraction = 0;
  lim(u, "openai-codex", "5h").amount.remainingFraction = 0;
  rep(u, "openai-codex").metadata.limitReached = true;
  rep(u, "cursor").limits[0].amount.remainingFraction = 0.06;
  const r = ev(u);
  expect(r).toMatchObject({
    ok: false,
    reason: "quota_wait",
    provider: "anthropic",
    window: "5h",
    resetsAt: lim(u, "anthropic", "5h").window.resetsAt,
  });
});

test("anthropic exhausted but openai healthy -> ok", () => {
  const u = clone();
  lim(u, "anthropic", "5h").amount.remainingFraction = 0;
  expect(ev(u)).toEqual({ ok: true });
});

test("provider absent from usage is usable", () => {
  const u = clone();
  u.reports = u.reports.filter((r: any) => r.provider !== "cursor");
  lim(u, "anthropic", "5h").amount.remainingFraction = 0;
  lim(u, "openai-codex", "5h").amount.remainingFraction = 0;
  expect(ev(u)).toEqual({ ok: true });
});

test("chain blocked only by 7d windows -> quota_wait on the earliest 7d reset, never a stop", () => {
  const u = clone();
  lim(u, "anthropic", "7d").amount.remainingFraction = 0.3;
  lim(u, "openai-codex", "7d").amount.remainingFraction = 0.3;
  // 7d at 0.3 <= reserve 0.4 blocks the chain until the weekly reset
  expect(ev(u, {}, ["anthropic", "openai-codex"])).toMatchObject({
    ok: false, reason: "quota_wait", provider: "anthropic", window: "7d", resetsAt: lim(u, "anthropic", "7d").window.resetsAt,
  });
});

test("blocked chain whose windows report no reset time -> quota_wait with resetsAt null", () => {
  const u = clone();
  for (const p of ["anthropic", "openai-codex"]) {
    rep(u, p).metadata.limitReached = true;
    for (const l of rep(u, p).limits) { l.amount.remainingFraction = 0; l.window.resetsAt = null; }
  }
  expect(ev(u, {}, ["anthropic", "openai-codex"])).toMatchObject({ ok: false, reason: "quota_wait", resetsAt: null, window: "unknown" });
});

test("evaluateQuota never returns a stop reason for an unusable chain", () => {
  const u = clone();
  for (const r of u.reports) for (const l of r.limits) l.amount.remainingFraction = 0;
  for (const r of u.reports) r.metadata = { ...(r.metadata ?? {}), limitReached: true };
  const r = ev(u);
  expect(r.ok === false && r.reason).toBe("quota_wait");
});

test("empty chain skips chain check", () => {
  const u = clone();
  lim(u, "anthropic", "5h").amount.remainingFraction = 0;
  expect(ev(u, floors, [])).toEqual({ ok: true });
});
