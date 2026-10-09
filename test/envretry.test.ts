import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseBacklog, type Status } from "../src/backlog";
import { classifyBlocked } from "../src/chunk";
import { loop } from "../src/runner";
import type { Check } from "../src/preflight";
import { backlog, entries, setup } from "./helpers";

async function scenario(outcomes: { status: Status; note: string }[], checks: Check[] = [], needs?: string, initial?: { status: string; note: string }) {
  const { ctx } = setup();
  backlog(ctx, [{ id: "a", needs, ...initial }]);
  const calls: string[] = [];
  const stop = await loop(ctx, [], async (c, chunk) => {
    calls.push(chunk.id);
    const out = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    c.setStatus(chunk.id, out.status, out.note);
    return { ...out, branch: "a" };
  }, async () => checks);
  return { calls, stop, chunks: parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks, retries: entries(ctx).filter((e) => e.event === "env_retry") };
}
test("env block is rechecked and retried once, then passes", async () => {
  const r = await scenario([{ status: "blocked", note: "env: chromium missing" }, { status: "passed", note: "ok" }]);
  expect(r.calls).toEqual(["a", "a"]);
  expect(r.chunks[0].status).toBe("passed");
  expect(r.retries).toHaveLength(1);
  expect(r.retries[0].retried).toEqual(["a"]);
});
test("env block a second time remains blocked and finishes", async () => {
  const r = await scenario([{ status: "blocked", note: "env: chromium missing" }]);
  expect(r.calls).toEqual(["a", "a"]);
  expect(r.chunks[0].status).toBe("blocked");
  expect(r.stop.reason).toBe("finished");
});
test("failed browser recheck leaves browser chunk blocked", async () => {
  const r = await scenario([{ status: "blocked", note: "env: chromium missing" }], [{ name: "browser", need: "browser", ok: false, detail: "missing" }], "browser");
  expect(r.calls).toEqual(["a"]);
  expect(r.retries[0].retried).toEqual([]);
});
test("failed and human-gate outcomes are never env retried", async () => {
  for (const out of [{ status: "failed", note: "test failed" }, { status: "blocked", note: "needs product decision" }] satisfies { status: Status; note: string }[]) {
    const r = await scenario([out]);
    expect(r.calls).toEqual(["a"]);
    expect(r.retries).toEqual([]);
  }
});
test("env blocks from an earlier launch retry; global recheck failures block all candidates", async () => {
  const initial = { status: "blocked", note: "env: chromium missing" };
  const r = await scenario([{ status: "passed", note: "ok" }], [], "browser", initial);
  expect(r.calls).toEqual(["a"]);
  expect(r.chunks[0].status).toBe("passed");
  const fail = await scenario([{ status: "passed", note: "ok" }], [{ name: "forge_auth", ok: false, detail: "offline" }], "browser", initial);
  expect(fail.calls).toEqual([]);
  expect(fail.retries[0].retried).toEqual([]);
});
test("classifies the evidence environment block without reclassifying product decisions", () => {
  const reason = "Playwright MCP cannot initialize because Chromium is missing at /opt/google/chrome/chrome; live UI smoke and required post-submit 1920x1080 PR screenshots cannot be produced.";
  expect(classifyBlocked(reason)).toBe(`env: ${reason}`);
  expect(classifyBlocked("env: docker socket denied")).toBe("env: docker socket denied");
  expect(classifyBlocked("ENV: docker socket denied")).toBe("env: docker socket denied");
  expect(classifyBlocked("ambiguous product decision")).toBe("ambiguous product decision");
});
