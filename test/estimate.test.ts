import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MEDIAN_MS, DEFAULT_P90_MS, estimate, estimateText, formatCap, formatDuration, historyFromLedgers, loadHistory, typeStats } from "../src/estimate";
import type { LedgerEntry } from "../src/ledger";
const MIN = 60_000;
const HOUR = 60 * MIN;
const entry = (at: number, event: string, fields: Record<string, unknown> = {}): LedgerEntry => ({ ts: new Date(at).toISOString(), event, ...fields });
function fixture() {
  const ledger: LedgerEntry[] = [];
  let at = 0;
  for (const [type, durations] of Object.entries({ fe: [4, 4, 5, 8, 9, 10, 38], be: [2, 3, 3, 4] })) {
    for (const [i, d] of durations.entries()) {
      const chunk = `${type}-${i}`;
      ledger.push(entry(at, "chunk_start", { chunk }));
      at += d * MIN;
      ledger.push(entry(at, "chunk_end", { chunk, status: "passed" }));
    }
  }
  ledger.push(entry(at, "quota_wait"));
  ledger.push(entry(at + 10 * MIN, "quota_wait"));
  ledger.push(entry(at + 120 * MIN, "quota", { ok: true }));
  return ledger;
}
test("type median and nearest-rank p90; pooled fallback and waits", () => {
  const h = historyFromLedgers([fixture()]);
  expect(h.chunks).toBe(11);
  expect(h.waitMs).toBe(120 * MIN);
  expect(typeStats(h, "fe")).toEqual({ median: 8 * MIN, p90: 38 * MIN, n: 7, source: "type" });
  expect(typeStats(h, "be")).toEqual({ median: 3 * MIN, p90: 4 * MIN, n: 4, source: "type" });
  expect(typeStats(h, "x")).toEqual({ median: 4 * MIN, p90: 10 * MIN, n: 11, source: "pooled" });
  const e = estimate(h, ["fe-a", "be-b", "x"], 0);
  expect(e.finishAtMs).toBeCloseTo((8 + 3 + 4 + 3 * 120 / 11) * MIN);
  expect(e.p90AtMs).toBeCloseTo((38 + 4 + 10 + 3 * 120 / 11) * MIN);
  expect(e.safetyCapMs).toBe(Math.ceil(2 * e.p90AtMs / HOUR) * HOUR);
});
test("defaults, minimum cap, even median and CLI text", () => {
  const empty = historyFromLedgers([]);
  expect(typeStats(empty, "fe")).toEqual({ median: DEFAULT_MEDIAN_MS, p90: DEFAULT_P90_MS, n: 0, source: "default" });
  expect(estimate(empty, [], 0).safetyCapMs).toBe(2 * HOUR);
  expect(estimate(empty, ["fe-a"], 0).finishAtMs).toBe(30 * MIN);
  expect(typeStats({ ...empty, durations: { a: [2, 4, 6, 8] } }, "a").median).toBe(5);
  expect(formatDuration(156 * MIN)).toBe("2h36m");
  expect(formatDuration(13 * MIN)).toBe("13m");
  expect(formatCap(2.1 * HOUR)).toBe("3h");
  expect(estimateText(empty, ["fe-a", "be-b"], 0)).toContain("chunks: 2 pending (be 1, fe 1)");
});
test("ignores non-outcomes and closes waits on run/start/stop/healthy quota", () => {
  const ledger = [entry(0, "chunk_start", { chunk: "a" }), entry(MIN, "chunk_end", { chunk: "a", status: "pending" }), entry(2 * MIN, "chunk_start", { chunk: "a" }), entry(3 * MIN, "chunk_end", { chunk: "a", status: "stopped" })];
  for (const event of ["run_start", "chunk_start", "stop", "quota"]) ledger.push(entry(4 * MIN, "quota_wait"), entry(5 * MIN, event, { ok: true }));
  const h = historyFromLedgers([ledger]);
  expect(h.chunks).toBe(0);
  expect(h.waitMs).toBe(4 * MIN);
});
test("quota-requeued and stopped attempts cannot be paired with a later setup block", () => {
  for (const status of ["pending", "dry_run", "stopped"]) {
    const h = historyFromLedgers([[
      entry(0, "chunk_start", { chunk: "fe-a" }),
      entry(MIN, "chunk_end", { chunk: "fe-a", status }),
      entry(2 * MIN, "quota_wait"),
      entry(122 * MIN, "quota", { ok: true }),
      entry(123 * MIN, "chunk_end", { chunk: "fe-a", status: "blocked" }),
    ]]);
    expect(h.durations).toEqual({});
    expect(h.chunks).toBe(0);
    expect(h.waitMs).toBe(120 * MIN);
  }
});
test("history walks exactly two levels, excludes dry-run, deduplicates realpaths", () => {
  const root = mkdtempSync(join(tmpdir(), "estimate-"));
  try {
    const run = join(root, "repo", "day");
    mkdirSync(run, { recursive: true });
    const file = join(run, "ledger.jsonl");
    writeFileSync(file, fixture().map((e) => JSON.stringify(e)).join("\n"));
    writeFileSync(join(run, "ledger.dry-run.jsonl"), "{}\n");
    const link = join(root, "alias.jsonl");
    symlinkSync(file, link);
    expect(loadHistory(root, [file, link]).ledgers).toBe(1);
    expect(loadHistory(root, [file, link]).chunks).toBe(11);
    expect(loadHistory(join(root, "missing"))).toEqual(historyFromLedgers([]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
