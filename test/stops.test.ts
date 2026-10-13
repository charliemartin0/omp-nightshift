import { expect, test } from "bun:test";
import { parseBacklog } from "../src/backlog";
import { readFileSync } from "node:fs";
import { loop } from "../src/runner";
import { checkStop } from "../src/stops";
import { backlog, exhausted, HOUR, setup, START } from "./helpers";

test("safety cap within margin", async () => {
  const { ctx } = setup();
  ctx.capAtMs = START + 10 * 60_000;
  expect((await checkStop(ctx, [], 0))?.reason).toBe("safety_cap");
});
test("earlier stopAt override within margin", async () => {
  const { ctx } = setup();
  ctx.stopAtMs = START + 10 * 60_000;
  expect((await checkStop(ctx, [], 0))?.reason).toBe("stopAt");
});
test("stale exhausted quota after reset stops after 60 minutes without progress", async () => {
  const { ctx, state } = setup();
  ctx.readUsage = async () => exhausted(START - HOUR);
  const stop = await checkStop(ctx, [], 0);
  expect(stop?.reason).toBe("safety_cap");
  expect(stop?.detail).toContain("no progress");
  expect(state.t - START).toBe(HOUR);
  expect(state.sleeps).toHaveLength(6);
});
test("three identical normalised failures stop despite interleaved passes", async () => {
  const { ctx } = setup();
  backlog(ctx, ["a", "pass-one", "b", "pass-two", "c"].map((id) => ({ id })));
  const stop = await loop(ctx, [], async (c, chunk) => {
    const status = chunk.id.startsWith("pass") ? "passed" : "failed";
    const note = `setup_failed: exit 1; see logs/${chunk.id}-setup.log`;
    c.setStatus(chunk.id, status, note);
    return { status, note, branch: chunk.id };
  });
  expect(stop.reason).toBe("safety_cap");
  expect(stop.detail).toContain("same failure 3x");
});
test("run token cap", async () => {
  const { ctx } = setup();
  backlog(ctx, [{ id: "a" }, { id: "b" }]);
  const chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
  ctx.runTokens = ctx.run.limits.tokenCap * chunks.length + 1;
  expect((await checkStop(ctx, chunks, 0))?.reason).toBe("safety_cap");
});
test("empty pending backlog finishes normally", async () => {
  const { ctx } = setup();
  backlog(ctx, [{ id: "a", status: "passed" }]);
  expect((await loop(ctx, [])).reason).toBe("finished");
});
