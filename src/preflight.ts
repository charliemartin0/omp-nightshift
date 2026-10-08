import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commonDir, git, originUrl, parseRemote, removeWorktree, trunkBase } from "./git";
import type { Ledger } from "./ledger";
import { errMsg, spawnGroup } from "./proc";
import type { RunJson } from "./runjson";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const PS = process.env.OMP_OVERNIGHT_POWER_DIR || "/sys/class/power_supply";
const readTrim = (p: string): string => {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
};

function power(): Check {
  const supplies = existsSync(PS) ? readdirSync(PS) : [];
  const types = supplies.map((s) => ({ s, type: readTrim(join(PS, s, "type")), online: readTrim(join(PS, s, "online")) }));
  const mains = types.find((t) => (t.type === "Mains" || t.type === "USB") && t.online === "1");
  if (mains) return { name: "power", ok: true, detail: `on external power (${mains.s})` };
  if (!types.some((t) => t.type === "Battery")) return { name: "power", ok: true, detail: "no battery present" };
  return { name: "power", ok: false, detail: "on battery: no Mains/USB supply is online" };
}

async function gitClean(run: RunJson): Promise<Check> {
  const r = await git(run.repo, ["status", "--porcelain"]);
  if (r.code !== 0) return { name: "git_clean", ok: false, detail: `git status failed: ${r.stderr.trim()}` };
  const lines = r.stdout.split("\n").filter(Boolean);
  if (lines.length === 0) return { name: "git_clean", ok: true, detail: "main checkout clean" };
  return { name: "git_clean", ok: false, detail: `${lines.length} uncommitted entries, e.g. ${lines.slice(0, 3).join(" | ")}` };
}

async function forgeAuth(run: RunJson): Promise<Check> {
  const name = "forge_auth";
  if (run.forge === "local") return { name, ok: true, detail: "skipped (forge local)" };
  const remote = parseRemote(await originUrl(run.repo, run.remote));
  if (remote.scheme === "ssh") {
    const port = remote.port ? ["-p", remote.port] : [];
    const r = await spawnGroup(
      ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...port, "-T", `${remote.user}@${remote.host}`],
      { cwd: run.repo, timeoutMs: 30_000 },
    );
    // GitHub exits 1 even on success; the greeting is the signal.
    if (!/successfully authenticated/i.test(`${r.stderr}\n${r.stdout}`)) {
      return { name, ok: false, detail: `ssh ${remote.user}@${remote.host}: ${r.stderr.trim().split("\n").pop() || `exit ${r.code}`}` };
    }
  } else if (remote.scheme === "https") {
    const r = await git(run.repo, ["ls-remote", "--exit-code", run.remote, "HEAD"], { timeoutMs: 60_000 });
    if (r.code !== 0) return { name, ok: false, detail: `git ls-remote ${run.remote}: ${r.stderr.trim() || `exit ${r.code}`}` };
  } else {
    return { name, ok: false, detail: `unsupported ${run.remote} URL for forge ${run.forge}` };
  }
  const gh = await spawnGroup(["gh", "auth", "status"], { cwd: run.repo, timeoutMs: 30_000 });
  if (gh.code !== 0) return { name, ok: false, detail: `gh auth status failed: ${gh.stderr.trim().split("\n")[0]}` };
  if (run.forge === "graphite") {
    const auth = join(homedir(), ".config/graphite/auth");
    if (!existsSync(auth)) return { name, ok: false, detail: `${auth} missing (run gt auth)` };
    const cfg = join(await commonDir(run.repo), ".graphite_repo_config");
    if (!existsSync(cfg)) return { name, ok: false, detail: `${cfg} missing (run gt init)` };
  }
  return { name, ok: true, detail: `${run.forge} auth ok` };
}

async function baselineTest(run: RunJson, logFile: string): Promise<Check> {
  const name = "baseline_test";
  const wt = join(run.worktreeRoot, "_preflight");
  mkdirSync(run.worktreeRoot, { recursive: true });
  const base = await trunkBase(run);
  if (base.fetch) {
    const fetch = await git(run.repo, ["fetch", "--quiet", run.remote, run.trunk], { timeoutMs: 300_000 });
    if (fetch.code !== 0) return { name, ok: false, detail: `fetch ${run.remote} ${run.trunk}: ${fetch.stderr.trim()}` };
  }
  if (existsSync(wt)) await removeWorktree(run.repo, wt); // left behind by a killed run
  const add = await git(run.repo, ["worktree", "add", "--detach", wt, base.ref]);
  if (add.code !== 0) return { name, ok: false, detail: `worktree add: ${add.stderr.trim()}` };
  try {
    const opts = { cwd: wt, env: { CI: "1" }, timeoutMs: run.limits.testTimeoutMinutes * 60_000, logFile };
    if (run.setupCommand.trim()) {
      const s = await spawnGroup(["bash", "-lc", run.setupCommand], opts);
      if (s.code !== 0 || s.timedOut) return { name, ok: false, detail: `setupCommand ${s.timedOut ? "timed out" : `exit ${s.code}`}; see ${logFile}` };
    }
    const t = await spawnGroup(["bash", "-lc", run.preflightTest], opts);
    if (t.code !== 0 || t.timedOut) return { name, ok: false, detail: `preflightTest ${t.timedOut ? "timed out" : `exit ${t.code}`}; see ${logFile}` };
    return { name, ok: true, detail: `${base.ref} passes: ${run.preflightTest}` };
  } finally {
    await removeWorktree(run.repo, wt);
  }
}

/** Runs all four checks (even after a failure, so every problem is reported at once). */
export async function runPreflight(
  run: RunJson,
  o: { ledger: Ledger | null; logFile: string; onResult?: (c: Check) => void },
): Promise<Check[]> {
  const steps: [string, () => Check | Promise<Check>][] = [
    ["power", power],
    ["git_clean", () => gitClean(run)],
    ["forge_auth", () => forgeAuth(run)],
    ["baseline_test", () => baselineTest(run, o.logFile)],
  ];
  const results: Check[] = [];
  for (const [name, step] of steps) {
    let check: Check;
    try {
      check = await step();
    } catch (e) {
      check = { name, ok: false, detail: errMsg(e) };
    }
    o.ledger?.log("preflight", { name: check.name, ok: check.ok, detail: check.detail });
    o.onResult?.(check);
    results.push(check);
  }
  return results;
}
