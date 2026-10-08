import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBacklog } from "./backlog";
import type { Ctx } from "./ctx";
import { type LedgerEntry, readLedger } from "./ledger";
import { errMsg, spawnGroup } from "./proc";

const REPORT_TIMEOUT_MS = 10 * 60_000;
const BASE_HEADINGS = ["## What went well", "## Even better if"];
const ACTION_HEADING = "## Action needed";

export interface ReportResult {
  path: string;
  actionNeeded: boolean;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

function headingsOf(md: string): string[] {
  return md.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.trim());
}

export function renderReportPrompt(runDir: string, actionNeeded: boolean): string {
  const sections = [...BASE_HEADINGS, ...(actionNeeded ? [ACTION_HEADING] : [])].map((h) => `"${h}"`).join(", ");
  const action = actionNeeded
    ? ` Under "${ACTION_HEADING}", list each blocked chunk id, its reason, and what Charlie must do (if the run stopped for another reason, e.g. preflight_failed, state it and the fix).`
    : "";
  return `Read ${runDir}/ledger.jsonl and ${runDir}/backlog.md. Write ${runDir}/report.md in markdown with exactly these sections and nothing else: ${sections}.${action} Include PR links. Under 300 words. Do not modify any other file.\n`;
}

/** Deterministic report straight from the ledger (dry-run, or fallback when omp's report is unusable). */
function deterministicReport(ctx: Ctx, entries: LedgerEntry[], actionNeeded: boolean, failureNote: string): string {
  const ends = entries.filter((e) => e.event === "chunk_end");
  const stop = entries.findLast((e) => e.event === "stop");
  const line = (e: LedgerEntry) => `- ${e.chunk}: ${text(e.status)}${text(e.note) ? ` — ${text(e.note)}` : ""}`;
  const well = ends.filter((e) => ["passed", "flaky", "dry_run"].includes(text(e.status))).map(line);
  const better = ends.filter((e) => !["passed", "flaky", "dry_run"].includes(text(e.status))).map(line);
  try {
    for (const c of parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks) {
      if (c.status === "skipped") better.push(`- ${c.id}: skipped${c.note ? ` — ${c.note}` : ""}`);
    }
  } catch {
    /* backlog unreadable: the ledger part still stands */
  }
  if (stop) better.push(`- Run stopped: ${text(stop.reason)}${text(stop.detail) ? ` (${text(stop.detail)})` : ""}`);
  const action = [
    ...ends.filter((e) => e.status === "blocked").map((e) => `- ${e.chunk}: ${text(e.note)} — resolve this, then relaunch the overnight run`),
    ...entries
      .filter((e) => e.event === "preflight" && e.ok === false)
      .map((e) => `- preflight ${text(e.name)} failed: ${text(e.detail)} — fix it, then relaunch`),
    ...(failureNote ? [`- ${failureNote}`] : []),
  ];
  const sections = [
    `${BASE_HEADINGS[0]}\n${well.join("\n") || "- Nothing completed."}`,
    `${BASE_HEADINGS[1]}\n${better.join("\n") || "- Nothing to improve."}`,
    ...(actionNeeded ? [`${ACTION_HEADING}\n${action.join("\n") || "- See ledger.jsonl."}`] : []),
  ];
  return `${sections.join("\n\n")}\n`;
}

/** Writes the report (omp for real runs, deterministic for dry-run), then notifies when action is needed. */
export async function writeReport(ctx: Ctx): Promise<ReportResult> {
  const { run, ledger } = ctx;
  const all = readLedger(ledger.file);
  const entries = all.slice(Math.max(0, all.findLastIndex((e) => e.event === "run_start"))); // this run only
  const stop = entries.findLast((e) => e.event === "stop");
  const blocked = entries.filter((e) => e.event === "chunk_end" && e.status === "blocked");
  let actionNeeded = blocked.length > 0 || stop?.reason === "preflight_failed";
  const path = join(run.runDir, ctx.dryRun ? "report.dry-run.md" : "report.md");
  let failureNote = "";

  if (ctx.dryRun) {
    writeFileSync(path, deterministicReport(ctx, entries, actionNeeded, ""));
  } else {
    const promptFile = join(ctx.prompts, "report.md");
    writeFileSync(promptFile, renderReportPrompt(run.runDir, actionNeeded));
    rmSync(path, { force: true }); // a stale report must not pass validation
    try {
      const r = await spawnGroup(
        ["omp", "-p", "--model", run.models.report, "--config", ctx.overlay, "--no-session", "--no-title", "--cwd", run.runDir, `@${promptFile}`],
        { cwd: run.runDir, timeoutMs: REPORT_TIMEOUT_MS, logFile: join(ctx.logs, "report-omp.log") },
      );
      const want = [...BASE_HEADINGS, ...(actionNeeded ? [ACTION_HEADING] : [])];
      const got = existsSync(path) ? headingsOf(readFileSync(path, "utf8")) : [];
      if (r.code !== 0 || r.timedOut || got.length !== want.length || got.some((h, i) => h !== want[i])) {
        failureNote = `report generation failed; see ledger.jsonl (omp exit ${r.code}${r.timedOut ? ", timed out" : ""}, headings: ${got.join(" / ") || "none"})`;
      }
    } catch (e) {
      failureNote = `report generation failed; see ledger.jsonl (${errMsg(e)})`;
    }
    if (failureNote) {
      actionNeeded = true;
      writeFileSync(path, deterministicReport(ctx, entries, true, "report generation failed; see ledger.jsonl"));
      ledger.log("report_fallback", { detail: failureNote });
    }
  }

  if (actionNeeded) {
    const why = blocked.length ? blocked.map((e) => e.chunk).join(", ") : failureNote ? "report generation failed" : text(stop?.reason);
    const title = `Overnight: action needed (${run.repoName})`;
    const body = `${why} — ${path}`;
    if (ctx.dryRun) {
      ledger.log("would_notify", { title, body });
    } else {
      await spawnGroup(["notify-send", "--urgency=critical", "--app-name=omp-overnight", title, body], { timeoutMs: 15_000 }).catch(
        () => undefined,
      );
    }
  }
  ledger.log("report", { path, actionNeeded });
  return { path, actionNeeded };
}
