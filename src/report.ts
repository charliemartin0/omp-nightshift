import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Chunk, parseBacklog } from "./backlog";
import type { Ctx } from "./ctx";
import { formatDuration } from "./estimate";
import type { FlakyTest } from "./gate";
import { type LedgerEntry, readLedger } from "./ledger";
import { errMsg, spawnGroup } from "./proc";
import type { RunJson } from "./runjson";
import { bst } from "./stops";

const REPORT_TIMEOUT_MS = 10 * 60_000;
const BASE_HEADINGS = ["## What went well", "## Even better if"];
const ACTION_HEADING = "## Action needed";
export const relaunchCommand = (run: RunJson): string =>
  `bun ${join(import.meta.dir, "cli.ts")} launch ${join(run.runDir, "run.json")} --retry-blocked`;

export interface ReportResult { path: string; actionNeeded: boolean; attempts: number }
export interface ReportPr { chunk: string; number: number; url: string; state: string }
export interface QuotaWait { provider: string; window: string; fromMs: number; toMs: number }
export interface Facts {
  chunks: { id: string; status: string; note: string; runtimeMs: number; tokens: number }[];
  prs: ReportPr[];
  flaky: { chunk: string; tests: FlakyTest[] }[];
  blocked: { id: string; note: string }[];
  failed: { id: string; note: string }[];
  waits: QuotaWait[];
  runtimeMs: number;
  launches: number;
  stop: { reason: string; detail: string } | null;
  preflight: { name: string; detail: string }[];
  selfReviews: { chunk: string; pr: number | null; content: string }[];
}

const text = (v: unknown): string => typeof v === "string" ? v : "";
const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
function flakyTests(v: unknown): FlakyTest[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((t) => {
    const r = record(t);
    return r && typeof r.name === "string" && typeof r.message === "string" ? [{ name: r.name, message: r.message }] : [];
  });
}

/** All launches contribute runtime/tokens/waits; current backlog and latest gate determine the day-end outcomes. */
export function reportFacts(ctx: Ctx, entries: LedgerEntry[], chunks: Chunk[]): Facts {
  const current = entries.slice(Math.max(0, entries.findLastIndex((e) => e.event === "run_start")));
  const latestOk = new Map<string, LedgerEntry>();
  const latestGate = new Map<string, LedgerEntry>();
  const attempts = new Map<string, { fromMs: number; tokens: number }>();
  const stats = new Map<string, { runtimeMs: number; tokens: number }>();
  const waits: QuotaWait[] = [];
  let wait: Omit<QuotaWait, "toMs"> | null = null;
  let segmentStart: number | null = null;
  let lastAt = 0;
  let runtimeMs = 0;
  let launches = 0;
  const closeWait = (at: number) => {
    if (wait && at >= wait.fromMs) waits.push({ ...wait, toMs: at });
    wait = null;
  };
  for (const e of entries) {
    const at = Date.parse(e.ts);
    if (!Number.isFinite(at)) continue;
    if (e.event === "run_start") {
      if (segmentStart !== null) runtimeMs += Math.max(0, lastAt - segmentStart);
      segmentStart = at;
      launches++;
    } else if (e.event === "stop" && segmentStart !== null) {
      runtimeMs += Math.max(0, at - segmentStart);
      segmentStart = null;
    }
    lastAt = at;
    if (e.event === "quota_wait" && !wait) wait = { provider: text(e.provider), window: text(e.window), fromMs: at };
    if (["chunk_start", "run_start", "stop"].includes(e.event) || (e.event === "quota" && e.ok === true)) closeWait(at);
    if (!e.chunk) continue;
    if (e.event === "chunk_start") {
      attempts.set(e.chunk, { fromMs: at, tokens: 0 });
      latestOk.delete(e.chunk);
      latestGate.delete(e.chunk);
    } else if (e.event === "omp_exit") {
      const attempt = attempts.get(e.chunk);
      if (attempt && typeof e.tokens === "number") attempt.tokens = Math.max(attempt.tokens, e.tokens);
    } else if (e.event === "chunk_end") {
      const attempt = attempts.get(e.chunk);
      if (attempt) {
        const s = stats.get(e.chunk) ?? { runtimeMs: 0, tokens: 0 };
        s.runtimeMs += Math.max(0, at - attempt.fromMs);
        s.tokens += attempt.tokens;
        stats.set(e.chunk, s);
        attempts.delete(e.chunk);
      }
    } else if (e.event === "gate") {
      latestGate.set(e.chunk, e);
      if (e.ok === true) latestOk.set(e.chunk, e);
    }
  }
  if (segmentStart !== null) runtimeMs += Math.max(0, lastAt - segmentStart);
  const prs: ReportPr[] = [];
  for (const c of chunks) {
    if (!["passed", "flaky"].includes(c.status)) continue;
    const pr = record(record(record(latestOk.get(c.id)?.checks)?.pr)?.pr);
    if (pr && typeof pr.number === "number" && typeof pr.url === "string") {
      prs.push({ chunk: c.id, number: pr.number, url: pr.url, state: pr.isDraft === true ? "draft" : text(pr.state).toLowerCase() });
    }
  }
  const stop = current.findLast((e) => e.event === "stop");
  const selfReviews = current.filter((e) => e.event === "self_review" && e.ok === true).flatMap((e) => {
    if (!e.chunk || typeof e.path !== "string" || !existsSync(e.path)) return [];
    try { return [{ chunk: e.chunk, pr: typeof e.pr === "number" ? e.pr : null, content: readFileSync(e.path, "utf8").slice(0, 1500) }]; }
    catch { return []; }
  });
  return {
    chunks: chunks.map((c) => ({ id: c.id, status: c.status, note: c.note, ...(stats.get(c.id) ?? { runtimeMs: 0, tokens: 0 }) })),
    prs,
    flaky: chunks.flatMap((c) => {
      const gate = latestGate.get(c.id);
      return gate?.flaky === true ? [{ chunk: c.id, tests: flakyTests(gate.flakyTests) }] : [];
    }),
    blocked: chunks.filter((c) => c.status === "blocked").map((c) => ({ id: c.id, note: c.note })),
    failed: chunks.filter((c) => c.status === "failed").map((c) => ({ id: c.id, note: c.note })),
    waits, runtimeMs, launches,
    stop: stop ? { reason: text(stop.reason), detail: text(stop.detail) } : null,
    preflight: current.filter((e) => e.event === "preflight" && e.ok === false).map((e) => ({ name: text(e.name), detail: text(e.detail) })),
    selfReviews,
  };
}

/** Blocked chunks are always first, outside the model-written body. */
export function renderTop(facts: Facts, run: RunJson): string {
  if (!facts.blocked.length) return "";
  return `## Blocked\n${facts.blocked.map((c) => `- ${c.id}: ${c.note}`).join("\n")}\n\nRelaunch after fixing: \`${relaunchCommand(run)}\`\n\n`;
}

/** Deterministic body used for dry runs, the compact retry's facts, and fallback. */
export function renderBody(facts: Facts, actionNeeded: boolean, failureNote: string): string {
  const well = facts.chunks.filter((c) => ["passed", "flaky", "dry_run"].includes(c.status)).map((c) => {
    const pr = facts.prs.find((p) => p.chunk === c.id);
    return pr ? `- ${c.id}: PR #${pr.number} ${pr.url} (${pr.state}) — ${c.status}` : `- ${c.id}: ${c.note}`;
  });
  const better = [
    ...facts.failed.map((c) => `- ${c.id}: ${c.note}`),
    ...facts.waits.map((w) => `- Quota wait: ${w.provider} ${w.window} ${bst(w.fromMs)}–${bst(w.toMs)} (${formatDuration(w.toMs - w.fromMs)})`),
    ...(facts.stop ? [`- Run stopped: ${facts.stop.reason}${facts.stop.detail ? ` (${facts.stop.detail})` : ""}`] : []),
  ];
  const action = [
    ...facts.preflight.map((c) => `- preflight ${c.name} failed: ${c.detail} — fix it, then relaunch`),
    ...(failureNote ? [`- ${failureNote}`] : []),
    ...(facts.blocked.length ? ["- See ## Blocked above."] : []),
  ];
  return [
    `${BASE_HEADINGS[0]}\n${well.join("\n") || "- Nothing completed."}`,
    `${BASE_HEADINGS[1]}\n${better.join("\n") || "- Nothing to improve."}`,
    ...(actionNeeded ? [`${ACTION_HEADING}\n${action.join("\n") || "- See ledger.jsonl."}`] : []),
  ].join("\n\n") + "\n";
}

/** The factual tail is present even when both model attempts failed. */
export function renderTail(facts: Facts): string {
  const flaky = facts.flaky.flatMap((f) => f.tests.map((t) => {
    const pr = facts.prs.find((p) => p.chunk === f.chunk);
    return `- ${f.chunk}${pr ? ` (PR #${pr.number})` : ""}: \`${t.name}\` — ${t.message}`;
  }));
  const stats = `## Run stats\n- Total runtime: ${formatDuration(facts.runtimeMs)} over ${facts.launches} launch(es)\n\n| chunk | status | runtime | tokens |\n| --- | --- | --- | --- |\n${facts.chunks.map((c) => `| ${c.id} | ${c.status} | ${formatDuration(c.runtimeMs)} | ${c.tokens.toLocaleString("en-GB")} |`).join("\n")}`;
  const reviews = facts.selfReviews.map((r) => `### ${r.chunk}${r.pr !== null ? ` (PR #${r.pr})` : ""}\n\n${r.content.trim()}`).join("\n\n");
  return [...(flaky.length ? [`## Flaky tests\n${flaky.join("\n")}`] : []), stats, ...(reviews ? [`## Self-review\n\n${reviews}`] : [])].join("\n\n") + "\n";
}

function headingsOf(md: string): string[] {
  return md.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.trim());
}
function headingRules(actionNeeded: boolean): string {
  const sections = [...BASE_HEADINGS, ...(actionNeeded ? [ACTION_HEADING] : [])].join(", ");
  return `using only these \`## \` headings, in this order: ${sections}. Put PR links as bullets under ## What went well. Write no other #/## headings. Do not write Blocked, Flaky tests, Run stats or Self-review sections (the runner adds them). Under 300 words. Do not modify any other file.`;
}
export function renderReportPrompt(runDir: string, actionNeeded: boolean): string {
  return `Read ${runDir}/ledger.jsonl and ${runDir}/backlog.md. Write ${runDir}/report.md ${headingRules(actionNeeded)}\n`;
}
export function renderCompactReportPrompt(runDir: string, actionNeeded: boolean, facts: Facts): string {
  return `Write ${runDir}/report.md ${headingRules(actionNeeded)} Rewrite these facts; do not read any file:\n\n${renderBody(facts, actionNeeded, "")}`;
}

export interface GenerateResult { code: number; timedOut: boolean }
export type ReportGenerator = (ctx: Ctx, promptFile: string, attempt: number) => Promise<GenerateResult>;
export async function ompGenerate(ctx: Ctx, promptFile: string, _attempt: number): Promise<GenerateResult> {
  return spawnGroup(["omp", "-p", "--model", ctx.run.models.report, "--config", ctx.overlay, "--no-session", "--no-title", "--cwd", ctx.run.runDir, `@${promptFile}`],
    { cwd: ctx.run.runDir, timeoutMs: REPORT_TIMEOUT_MS, logFile: join(ctx.logs, "report-omp.log") });
}

/** Preserve the previous report, retry once with compact facts, then fall back deterministically; notify as before. */
export async function writeReport(ctx: Ctx, generate: ReportGenerator = ompGenerate): Promise<ReportResult> {
  const { run, ledger } = ctx;
  const facts = reportFacts(ctx, readLedger(ledger.file), parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks);
  let actionNeeded = facts.blocked.length > 0 || facts.stop?.reason === "preflight_failed";
  const path = join(run.runDir, ctx.dryRun ? "report.dry-run.md" : "report.md");
  const top = renderTop(facts, run);
  const tail = renderTail(facts);
  let failureNote = "";
  let attempts = 0;
  if (existsSync(path)) renameSync(path, `${path}.bak`);
  if (ctx.dryRun) writeFileSync(path, top + renderBody(facts, actionNeeded, "") + "\n" + tail);
  else {
    const promptFile = join(ctx.prompts, "report.md");
    for (const attempt of [1, 2]) {
      writeFileSync(promptFile, attempt === 1 ? renderReportPrompt(run.runDir, actionNeeded) : renderCompactReportPrompt(run.runDir, actionNeeded, facts));
      try {
        const r = await generate(ctx, promptFile, attempt);
        const body = existsSync(path) ? readFileSync(path, "utf8") : "";
        const got = headingsOf(body);
        const want = [...BASE_HEADINGS, ...(actionNeeded ? [ACTION_HEADING] : [])];
        if (r.code === 0 && !r.timedOut && got.length === want.length && got.every((h, i) => h === want[i])) {
          attempts = attempt;
          writeFileSync(path, top + body.trimEnd() + "\n\n" + tail);
          failureNote = "";
          break;
        }
        failureNote = `report generation failed; see ledger.jsonl (omp exit ${r.code}${r.timedOut ? ", timed out" : ""}, headings: ${got.join(" / ") || "none"})`;
      } catch (e) { failureNote = `report generation failed; see ledger.jsonl (${errMsg(e)})`; }
      rmSync(path, { force: true });
    }
    if (!attempts) {
      attempts = 3;
      actionNeeded = true;
      writeFileSync(path, top + renderBody(facts, true, failureNote) + "\n" + tail);
      ledger.log("report_fallback", { detail: failureNote });
    }
  }
  if (actionNeeded) {
    const why = facts.blocked.length ? facts.blocked.map((c) => c.id).join(", ") : failureNote ? "report generation failed" : facts.stop?.reason ?? "";
    const title = `Overnight: action needed (${run.repoName})`;
    const body = `${why} — ${path}`;
    if (ctx.dryRun) ledger.log("would_notify", { title, body });
    else await spawnGroup(["notify-send", "--urgency=critical", "--app-name=omp-overnight", title, body], { timeoutMs: 15_000 }).catch(() => undefined);
  }
  ledger.log("report", { path, actionNeeded, attempts });
  return { path, actionNeeded, attempts };
}
