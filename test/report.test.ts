import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBacklog } from "../src/backlog";
import { readLedger, type LedgerEntry } from "../src/ledger";
import { reportFacts, renderBody, writeReport } from "../src/report";
import { backlog, entries, setup } from "./helpers";

function fixture() {
  const { ctx } = setup();
  const flakyTests = [{ name: "PlansTab > shows live inventory", message: "Error: Test timed out in 5000ms." }];
  const ledger: LedgerEntry[] = [];
  const add = (time: string, event: string, fields: Record<string, unknown> = {}) => ledger.push({ ts: `2026-10-09T${time}:00.000Z`, event, ...fields });
  const gate = (chunk: string, number: number, flaky: boolean) => ({ chunk, ok: true, flaky, ...(flaky ? { flakyTests } : {}), checks: { pr: { ok: true, pr: { number, url: `https://example.test/pr/${number}`, isDraft: true, state: "OPEN" } } } });
  add("09:18", "run_start");
  add("09:20", "chunk_start", { chunk: "fe-shell" });
  add("09:23", "omp_exit", { chunk: "fe-shell", tokens: 40_000 });
  add("09:24", "gate", gate("fe-shell", 6971, false));
  add("09:24", "chunk_end", { chunk: "fe-shell", status: "passed" });
  add("10:18", "quota_wait", { provider: "anthropic", window: "5h" });
  add("10:28", "quota_wait", { provider: "anthropic", window: "5h" });
  add("13:11", "chunk_start", { chunk: "fe-plans" });
  add("13:19", "omp_exit", { chunk: "fe-plans", tokens: 120_000 });
  add("13:20", "gate", gate("fe-plans", 7006, true));
  add("13:20", "chunk_end", { chunk: "fe-plans", status: "flaky" });
  add("13:21", "stop", { reason: "finished" });
  add("14:00", "run_start");
  add("14:01", "preflight", { name: "browser", need: "browser", ok: false, detail: "no Chrome/Chromium found" });
  add("14:02", "chunk_end", { chunk: "fe-x", status: "blocked", preflight: true, note: "env: preflight browser: no Chrome/Chromium found" });
  add("14:03", "chunk_start", { chunk: "fe-plans" });
  add("14:04", "omp_exit", { chunk: "fe-plans", tokens: 100_000 });
  add("14:07", "omp_exit", { chunk: "fe-plans", tokens: 180_000 });
  add("14:08", "gate", gate("fe-plans", 7006, true));
  add("14:08", "chunk_end", { chunk: "fe-plans", status: "flaky" });
  add("14:10", "stop", { reason: "finished" });
  const review = join(ctx.run.runDir, "reviews", "fe-plans.md");
  mkdirSync(join(ctx.run.runDir, "reviews"), { recursive: true });
  writeFileSync(review, "- P2: Add a test for the timeout edge case.\n");
  add("14:11", "self_review", { chunk: "fe-plans", pr: 7006, ok: true, path: review });
  writeFileSync(ctx.ledger.file, ledger.map((e) => JSON.stringify(e)).join("\n") + "\n");
  backlog(ctx, [{ id: "fe-shell", status: "passed", note: "PR #6971" }, { id: "fe-plans", status: "flaky", note: "PR #7006" }, { id: "fe-x", status: "blocked", note: "env: preflight browser: no Chrome/Chromium found" }]);
  const path = join(ctx.run.runDir, "report.md");
  return { ctx, path };
}
const validBody = "## What went well\n- PR #6971\n\n## Even better if\n- Quota waits\n\n## Action needed\n- Fix browser\n";

test("two bad heading attempts fall back with blocked top, PR states, flaky names, stats and waits", async () => {
  const { ctx, path } = fixture();
  const calls: number[] = [];
  const result = await writeReport(ctx, async (_c, _p, attempt) => {
    calls.push(attempt);
    writeFileSync(path, validBody + "\n## PR links\nextra\n");
    return { code: 0, timedOut: false };
  });
  const md = readFileSync(path, "utf8");
  expect(calls).toEqual([1, 2]);
  expect(result.attempts).toBe(3);
  expect(md.startsWith("## Blocked")).toBe(true);
  for (const s of ["--retry-blocked", "PR #6971 https://example.test/pr/6971 (draft)", "PlansTab > shows live inventory", "Quota wait: anthropic 5h", "(2h53m)", "## Run stats", "| fe-plans | flaky | 14m | 300,000 |", "Total runtime: 4h13m over 2 launch(es)"]) expect(md).toContain(s);
  expect(md).toContain("## Self-review");
  expect(md).toContain("### fe-plans (PR #7006)");
  expect(entries(ctx).some((e) => e.event === "report_fallback")).toBe(true);
  expect(entries(ctx).findLast((e) => e.event === "report")?.attempts).toBe(3);
});
test("compact second attempt passes without fallback and still gets the factual tail", async () => {
  const { ctx, path } = fixture();
  const result = await writeReport(ctx, async (_c, prompt, attempt) => {
    if (attempt === 1) writeFileSync(path, "## PR links\ninvalid\n");
    else {
      expect(readFileSync(prompt, "utf8")).toContain("Rewrite these facts; do not read any file:");
      writeFileSync(path, validBody);
    }
    return { code: 0, timedOut: false };
  });
  const md = readFileSync(path, "utf8");
  expect(result.attempts).toBe(2);
  expect(md.startsWith("## Blocked")).toBe(true);
  expect(md).toContain("## Flaky tests");
  expect(md).toContain("| fe-x | blocked | 0m | 0 |");
  expect(md.trimEnd().endsWith("- P2: Add a test for the timeout edge case.")).toBe(true);
  expect(entries(ctx).some((e) => e.event === "report_fallback")).toBe(false);
});
test("pre-existing report is backed up before a first-attempt success", async () => {
  const { ctx, path } = fixture();
  writeFileSync(path, "OLD");
  writeFileSync(`${path}.bak`, "OLDER");
  const result = await writeReport(ctx, async () => { writeFileSync(path, validBody); return { code: 0, timedOut: false }; });
  expect(readFileSync(`${path}.bak`, "utf8")).toBe("OLD");
  expect(result.attempts).toBe(1);
});
test("dry reports are deterministic, backed up, and never invoke the generator", async () => {
  const { ctx } = fixture();
  ctx.dryRun = true;
  const path = join(ctx.run.runDir, "report.dry-run.md");
  writeFileSync(path, "OLD DRY");
  const result = await writeReport(ctx, async () => { throw new Error("must not generate"); });
  expect(result.attempts).toBe(0);
  expect(readFileSync(`${path}.bak`, "utf8")).toBe("OLD DRY");
  expect(readFileSync(path, "utf8")).toContain("## Run stats");
});
test("facts track latest attempt, current statuses, full-history token maxima and completed wait episodes", () => {
  const { ctx } = fixture();
  const chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
  const all = readLedger(ctx.ledger.file);
  const facts = reportFacts(ctx, all, chunks);
  expect(facts.waits).toHaveLength(1);
  expect(facts.chunks.find((c) => c.id === "fe-plans")?.tokens).toBe(300_000);
  expect(facts.blocked).toHaveLength(1);
  expect(facts.prs).toHaveLength(2);
  expect(renderBody(facts, true, "")).toContain("See ## Blocked above.");
});
