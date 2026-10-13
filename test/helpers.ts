import { afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Ctx, makeCtx } from "../src/ctx";
import { validateRunJson } from "../src/runjson";
import usage from "./fixtures/usage.json";

export const START = Date.parse("2026-07-01T00:00:00Z");
export const HOUR = 3_600_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
export function setup() {
  const dir = mkdtempSync(join(tmpdir(), "overnight-test-"));
  dirs.push(dir);
  const run = validateRunJson({
    version: 1, repo: dir, repoName: "r", date: "2026-07-01", goal: "g", runDir: dir, worktreeRoot: join(dir, "wt"),
    unit: "omp-overnight-r", remote: "origin", trunk: "main", forge: "local", prMode: "independent",
    maxPrs: 10, floors: { anthropic: 0.25, "openai-codex": 0.5 }, reservePct: 40,
    models: { plan: "@plan", build: "@default", report: "@smol" }, setupCommand: "", preflightTest: "true", limits: {},
  });
  const ctx = makeCtx(run, false);
  const state = { t: START, sleeps: [] as number[] };
  ctx.clock = { now: () => state.t, sleep: async (ms) => { state.sleeps.push(ms); state.t += ms; } };
  ctx.capAtMs = START + 12 * HOUR;
  ctx.progressAt = START;
  ctx.buildProviders = ["anthropic", "openai-codex"];
  ctx.readUsage = async () => healthy();
  return { ctx, state, dir };
}
export function healthy() {
  const u = structuredClone(usage);
  for (const r of u.reports) for (const l of r.limits) l.amount.remainingFraction = 0.8;
  return u;
}
export function exhausted(resetsAt: number) {
  const u = healthy();
  for (const r of u.reports) for (const l of r.limits) if (l.scope.windowId === "5h") {
    l.amount.remainingFraction = 0;
    l.window.resetsAt = resetsAt;
  }
  return u;
}
export function backlog(ctx: Ctx, chunks: { id: string; status?: string; note?: string; needs?: string; test?: string }[]) {
  writeFileSync(ctx.backlog, `# Overnight backlog\ngoal: g\nrepo: ${ctx.run.repo}\n\n` + chunks.map((c) =>
    `## ${c.id}\n- status: ${c.status ?? "pending"}\n- scope: s\n- done-when: d\n- test: ${c.test ?? "true"}\n- prod-code: no\n${c.needs ? `- needs: ${c.needs}\n` : ""}- note: ${c.note ?? ""}\n`
  ).join("\n"));
}
export const entries = (ctx: Ctx) =>
  readFileSync(ctx.ledger.file, "utf8").split("\n").filter(Boolean).map((s) => JSON.parse(s));
