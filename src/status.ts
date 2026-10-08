import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseBacklog } from "./backlog";
import { git, gitOut } from "./git";
import { type LedgerEntry, readLedger, summarize } from "./ledger";
import { errMsg, spawnGroup } from "./proc";
import { type RunJson, validateRunJson } from "./runjson";

const subdirs = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name)) : [];

/** Newest run (by date, then mtime) whose run.json belongs to `repo`: in-repo or under ~/.omp/overnight. */
export function findLatestRun(repo: string): RunJson | null {
  const real = realpathSync(repo);
  const dirs = [
    ...subdirs(join(repo, ".omp/overnight")),
    ...subdirs(join(homedir(), ".omp/overnight")).flatMap((name) => subdirs(name)),
  ];
  let best: { run: RunJson; mtime: number } | null = null;
  for (const dir of dirs) {
    const file = join(dir, "run.json");
    if (!existsSync(file)) continue;
    try {
      const run = validateRunJson(JSON.parse(readFileSync(file, "utf8")));
      if (realpathSync(run.repo) !== real) continue;
      const mtime = statSync(file).mtimeMs;
      if (!best || run.date > best.run.date || (run.date === best.run.date && mtime > best.mtime)) best = { run, mtime };
    } catch {
      /* not a usable run dir */
    }
  }
  return best?.run ?? null;
}

export async function resolveRepo(arg?: string): Promise<string> {
  return gitOut(arg ?? process.cwd(), ["rev-parse", "--show-toplevel"]);
}

const newest = (files: string[]): string | null =>
  files.filter(existsSync).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;

async function unitState(unit: string): Promise<string> {
  const r = await spawnGroup(["systemctl", "--user", "is-active", unit], { timeoutMs: 15_000 });
  return r.stdout.trim() || r.stderr.trim() || "unknown";
}

/** Human-readable status of the latest run for `repo`. */
export async function statusText(repo: string): Promise<string> {
  const run = findLatestRun(repo);
  if (!run) return `no overnight run found for ${repo}`;
  const out: string[] = [`repo: ${run.repo}`, `run: ${run.runDir} (${run.date})`, `unit: ${run.unit}: ${await unitState(run.unit)}`];

  try {
    const chunks = parseBacklog(readFileSync(join(run.runDir, "backlog.md"), "utf8")).chunks;
    const w = Math.max(...chunks.map((c) => c.id.length));
    const sw = Math.max(...chunks.map((c) => c.status.length));
    out.push("", "chunks:", ...chunks.map((c) => `  ${c.id.padEnd(w)}  ${c.status.padEnd(sw)}  ${c.note}`.trimEnd()));
  } catch (e) {
    out.push("", `backlog unreadable: ${errMsg(e)}`);
  }

  const ledgerFile = newest([join(run.runDir, "ledger.jsonl"), join(run.runDir, "ledger.dry-run.jsonl")]);
  if (ledgerFile) {
    const tail: LedgerEntry[] = readLedger(ledgerFile).slice(-15);
    out.push("", `ledger (last ${tail.length}, ${ledgerFile}):`, ...tail.map((e) => `  ${summarize(e)}`));
  }

  const listed = await git(run.repo, ["worktree", "list", "--porcelain"]);
  const wts = listed.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)).filter((p) => p.startsWith(run.worktreeRoot));
  out.push("", "worktrees:", ...(wts.length ? wts.map((p) => `  ${p}`) : ["  (none)"]));

  const report = newest([join(run.runDir, "report.md"), join(run.runDir, "report.dry-run.md")]);
  if (report) out.push("", `report: ${report}`);
  return out.join("\n");
}

/** `systemctl --user stop <unit>`; never touches worktrees, branches or PRs. */
export async function stopRun(repo: string): Promise<string> {
  const run = findLatestRun(repo);
  if (!run) return `no overnight run found for ${repo}`;
  const r = await spawnGroup(["systemctl", "--user", "stop", run.unit], { timeoutMs: 120_000 });
  const msg = r.code === 0 ? `stopped ${run.unit}` : `systemctl stop ${run.unit}: ${r.stderr.trim() || `exit ${r.code}`}`;
  return `${msg}\n\n${await statusText(repo)}`;
}
