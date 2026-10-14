import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseBacklog } from "../src/backlog";
import { checkDispatch, checkQuota, checkStop } from "../src/stops";
import { backlog, entries, HOUR, setup, START } from "./helpers";

function usage(sevenDay: number, short = sevenDay) {
  const reports = ["anthropic", "openai-codex"].map((provider) => ({
    provider,
    limits: [
      { scope: { windowId: "7d" }, amount: { remainingFraction: sevenDay }, window: { resetsAt: START + 7 * 24 * HOUR } },
      { scope: { windowId: "5h" }, amount: { remainingFraction: short }, window: { resetsAt: START + HOUR } },
    ],
  }));
  return { reports };
}

test("borderline usage admits one slot but holds additional concurrent slots", async () => {
  const { ctx, state } = setup();
  let reads = 0;
  ctx.readUsage = async () => { reads++; return usage(0.51); };
  expect(await checkDispatch(ctx, [], 0, 0)).toBeNull();
  expect(await checkDispatch(ctx, [], 0, 1)).toBe("hold");
  expect(await checkDispatch(ctx, [], 0, 2)).toBe("hold");
  expect(reads).toBe(3);
  expect(state.sleeps).toEqual([]);
});

test("healthy usage admits two and three slots without thresholds exceeding 100%", async () => {
  const { ctx } = setup();
  ctx.readUsage = async () => usage(0.9);
  for (const running of [0, 1, 2]) expect(await checkDispatch(ctx, [], 0, running)).toBeNull();
  const admissions = entries(ctx).filter((e) => e.event === "quota_admission");
  expect(admissions.map((e) => e.slots)).toEqual([1, 2, 3]);
  expect(admissions[0]).toMatchObject({ floors: ctx.run.floors, reservePct: 40, ok: true });
  expect(admissions[1]).toMatchObject({ floors: { anthropic: 0.625, "openai-codex": 0.75 }, reservePct: 70, ok: true });
  expect(admissions[2].floors["openai-codex"]).toBeCloseTo(1 - 0.5 / 3);
  expect(admissions[2].reservePct).toBeCloseTo(80);
});

test("floors independently constrain concurrent admission, and stricter-only floor failures hold", async () => {
  const { ctx } = setup();
  ctx.buildProviders = ["openai-codex"];
  ctx.run.floors = { "openai-codex": 0.6 };
  ctx.run.reservePct = 10;
  ctx.readUsage = async () => usage(0.7, 0.95);
  expect(await checkDispatch(ctx, [], 0, 0)).toBeNull();
  expect(await checkDispatch(ctx, [], 0, 1)).toBe("hold");
  expect(entries(ctx).filter((e) => e.event === "quota_admission").at(-1)).toMatchObject({
    slots: 2, floors: { "openai-codex": 0.8 }, ok: false, reason: "quota_wait",
  });
});

test("reserve independently constrains concurrent admission on short windows", async () => {
  const { ctx, state } = setup();
  ctx.run.floors = { anthropic: 0.1, "openai-codex": 0.1 };
  ctx.readUsage = async () => usage(0.95, 0.65);
  expect(await checkDispatch(ctx, [], 0, 0)).toBeNull();
  expect(await checkDispatch(ctx, [], 0, 1)).toBe("hold");
  expect(entries(ctx).filter((e) => e.event === "quota_admission").at(-1)).toMatchObject({
    slots: 2, reservePct: 70, ok: false, reason: "quota_wait",
  });
  expect(state.sleeps).toEqual([]);
});

test("each admission rechecks fresh usage but base and headroom share the same snapshot", async () => {
  const { ctx } = setup();
  const snapshots = [usage(0.95, 0.65), usage(0.95), usage(0.95, 0.65)];
  let reads = 0;
  ctx.readUsage = async () => snapshots[reads++];
  expect(await checkDispatch(ctx, [], 0, 1)).toBe("hold");
  expect(reads).toBe(1);
  expect(await checkDispatch(ctx, [], 0, 1)).toBeNull();
  expect(reads).toBe(2);
  expect(await checkDispatch(ctx, [], 0, 1)).toBe("hold");
  expect(reads).toBe(3);
});

test("ordinary floor failure holds dispatch (quota never stops) before additional-slot evaluation", async () => {
  const { ctx } = setup();
  ctx.readUsage = async () => usage(0.2);
  expect(await checkDispatch(ctx, [], 0, 1)).toBe("hold");
  expect(entries(ctx).filter((e) => e.event === "quota_admission")).toHaveLength(0);
});

test("ordinary short-window exhaustion still holds dispatch without sleeping", async () => {
  const { ctx, state } = setup();
  ctx.readUsage = async () => usage(0.95, 0);
  expect(await checkDispatch(ctx, [], 0, 1)).toBe("hold");
  expect(state.sleeps).toEqual([]);
  expect(entries(ctx).filter((e) => e.event === "quota_admission")).toHaveLength(0);
});

test("ordinary reserve failure holds dispatch (quota never stops)", async () => {
  const { ctx } = setup();
  ctx.run.floors = {};
  ctx.readUsage = async () => usage(0.3, 0.95);
  expect(await checkDispatch(ctx, [], 0, 1)).toBe("hold");
});

test("single-chunk quota and stop checks keep their ordinary thresholds", async () => {
  const { ctx } = setup();
  ctx.readUsage = async () => usage(0.51);
  expect(await checkQuota(ctx, "a")).toEqual({ ok: true });
  expect(await checkStop(ctx, [], 0)).toBeNull();
  expect(await checkDispatch(ctx, [], 0, 0)).toBeNull();
  expect(entries(ctx).find((e) => e.event === "quota" && e.chunk === "a")).toMatchObject({
    ok: true, floors: ctx.run.floors,
  });
});

test("additional-slot thresholds preserve fallback to a healthy chain provider", async () => {
  const { ctx } = setup();
  const snapshot = usage(0.95);
  snapshot.reports[0].limits[0].amount.remainingFraction = 0.2;
  ctx.readUsage = async () => snapshot;
  expect(await checkDispatch(ctx, [], 0, 1)).toBeNull();
  expect(await checkDispatch(ctx, [], 0, 2)).toBeNull();
});

test("missing chain providers remain usable while missing legacy floor reports remain unknown", async () => {
  const { ctx } = setup();
  ctx.readUsage = async () => ({ reports: [] });
  expect(await checkDispatch(ctx, [], 0, 2)).toBeNull();
  ctx.buildProviders = [];
  expect(await checkDispatch(ctx, [], 0, 2)).toMatchObject({ reason: "quota_unknown" });
});

test("legacy floor-only admission holds stricter failures rather than hard-stopping", async () => {
  const { ctx } = setup();
  ctx.buildProviders = [];
  ctx.readUsage = async () => usage(0.51);
  expect(await checkDispatch(ctx, [], 0, 0)).toBeNull();
  expect(await checkDispatch(ctx, [], 0, 1)).toBe("hold");
});

test("maxPrs still holds for in-flight PRs and stops for completed PRs without querying quota", async () => {
  const { ctx } = setup();
  ctx.run.maxPrs = 2;
  backlog(ctx, [{ id: "a", status: "passed" }, { id: "b", status: "flaky" }]);
  const chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
  let reads = 0;
  ctx.readUsage = async () => { reads++; return usage(0.95); };
  expect(await checkDispatch(ctx, chunks.slice(0, 1), 0, 1)).toBe("hold");
  expect(await checkDispatch(ctx, chunks, 0, 0)).toEqual({ reason: "max_prs", detail: "2 >= 2" });
  expect(reads).toBe(0);
});
