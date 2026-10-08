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

test("every chain provider under its floor -> quota_floor listing each", () => {
  const u = clone();
  lim(u, "anthropic", "7d").amount.remainingFraction = 0.2;
  lim(u, "openai-codex", "7d").amount.remainingFraction = 0.4;
  expect(ev(u, floors, ["anthropic", "openai-codex"])).toEqual({
    ok: false,
    reason: "quota_floor",
    detail: "build chain unusable: anthropic 7d 0.20 < 0.25, openai-codex 7d 0.40 < 0.50",
  });
});

test("anthropic under floor, openai 5h exhausted -> quota_wait on openai reset", () => {
  const u = clone();
  const reset = Date.parse("2026-10-08T17:12:00Z");
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

test("no chain: floors are hard stops; missing report is unknown", () => {
  const u = clone();
  lim(u, "anthropic", "7d").amount.remainingFraction = 0.2;
  expect(ev(u, floors, [])).toEqual({ ok: false, reason: "quota_floor", detail: "anthropic 7d 0.20 < 0.25" });
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

test("chain blocked only by 7d windows -> limit_reached (no wait)", () => {
  const u = clone();
  lim(u, "anthropic", "7d").amount.remainingFraction = 0.3;
  lim(u, "openai-codex", "7d").amount.remainingFraction = 0.3;
  // 7d at 0.3 <= reserve 0.4 blocks the chain and cannot recover on its own
  const r = ev(u, {}, ["anthropic", "openai-codex"]);
  expect(r.ok === false && r.reason).toBe("quota_limit_reached");
});

test("empty chain skips chain check", () => {
  const u = clone();
  lim(u, "anthropic", "5h").amount.remainingFraction = 0;
  expect(ev(u, floors, [])).toEqual({ ok: true });
});
