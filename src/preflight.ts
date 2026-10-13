import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type Chunk, type Need, chunkNeeds } from "./backlog";
import { type Clock, oneLine } from "./ctx";
import { DF_TIMEOUT_MS, type DiskSample, probeDisk } from "./disk";
import { type TimeoutBudget, commonDir, git, originUrl, parseRemote, removeWorktree, trunkBase } from "./git";
import type { Ledger } from "./ledger";
import { errMsg, readLines, sleep, spawnGroup, startGroup } from "./proc";
import type { RunJson } from "./runjson";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  need?: Need;
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

async function forgeAuth(run: RunJson, budget: TimeoutBudget): Promise<Check> {
  const name = "forge_auth";
  if (run.forge === "local") return { name, ok: true, detail: "skipped (forge local)" };
  const remote = parseRemote(await originUrl(run.repo, run.remote, budget));
  if (remote.scheme === "ssh") {
    const port = remote.port ? ["-p", remote.port] : [];
    const r = await spawnGroup(
      ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", ...port, "-T", `${remote.user}@${remote.host}`],
      { cwd: run.repo, timeoutMs: budget(30_000) },
    );
    // GitHub exits 1 even on success; the greeting is the signal.
    if (!/successfully authenticated/i.test(`${r.stderr}\n${r.stdout}`)) {
      return { name, ok: false, detail: `ssh ${remote.user}@${remote.host}: ${r.stderr.trim().split("\n").pop() || `exit ${r.code}`}` };
    }
  } else if (remote.scheme === "https") {
    const r = await git(run.repo, ["ls-remote", "--exit-code", run.remote, "HEAD"], { timeoutMs: budget(60_000) });
    if (r.code !== 0) return { name, ok: false, detail: `git ls-remote ${run.remote}: ${r.stderr.trim() || `exit ${r.code}`}` };
  } else {
    return { name, ok: false, detail: `unsupported ${run.remote} URL for forge ${run.forge}` };
  }
  const gh = await spawnGroup(["gh", "api", "user", "--jq", ".login"], { cwd: run.repo, timeoutMs: budget(30_000) });
  if (gh.code !== 0 || gh.timedOut) return { name, ok: false, detail: `gh api user failed: ${gh.stderr.trim().split("\n")[0] || `exit ${gh.code}`}` };
  if (run.forge === "graphite") {
    const auth = join(homedir(), ".config/graphite/auth");
    if (!existsSync(auth)) return { name, ok: false, detail: `${auth} missing (run gt auth)` };
    const cfg = join(await commonDir(run.repo, budget), ".graphite_repo_config");
    if (!existsSync(cfg)) return { name, ok: false, detail: `${cfg} missing (run gt init)` };
  }
  return { name, ok: true, detail: `${run.forge} auth ok` };
}

async function baselineTest(run: RunJson, logFile: string, afterPass: (wt: string) => Promise<void>, budget: TimeoutBudget): Promise<Check> {
  const name = "baseline_test";
  const wt = join(run.worktreeRoot, "_preflight");
  mkdirSync(run.worktreeRoot, { recursive: true });
  const base = await trunkBase(run, budget);
  if (base.fetch) {
    const fetch = await git(run.repo, ["fetch", "--quiet", run.remote, run.trunk], { timeoutMs: budget(300_000) });
    if (fetch.code !== 0) return { name, ok: false, detail: `fetch ${run.remote} ${run.trunk}: ${fetch.stderr.trim()}` };
  }
  if (existsSync(wt)) await removeWorktree(run.repo, wt, budget); // left behind by a killed run
  const add = await git(run.repo, ["worktree", "add", "--detach", wt, base.ref], { timeoutMs: budget(120_000) });
  if (add.code !== 0) return { name, ok: false, detail: `worktree add: ${add.stderr.trim()}` };
  try {
    const opts = { cwd: wt, env: { CI: "1" }, logFile };
    if (run.setupCommand.trim()) {
      const s = await spawnGroup(["bash", "-lc", run.setupCommand], { ...opts, timeoutMs: budget(run.limits.testTimeoutMinutes * 60_000) });
      if (s.code !== 0 || s.timedOut) return { name, ok: false, detail: `setupCommand ${s.timedOut ? "timed out" : `exit ${s.code}`}; see ${logFile}` };
    }
    const t = await spawnGroup(["bash", "-lc", run.preflightTest], { ...opts, timeoutMs: budget(run.limits.testTimeoutMinutes * 60_000) });
    if (t.code !== 0 || t.timedOut) return { name, ok: false, detail: `preflightTest ${t.timedOut ? "timed out" : `exit ${t.code}`}; see ${logFile}` };
    await afterPass(wt);
    return { name, ok: true, detail: `${base.ref} passes: ${run.preflightTest}` };
  } finally {
    // Cleanup still runs after the deadline, with only a short bounded command budget.
    await removeWorktree(run.repo, wt, (ms) => {
      try { return budget(ms); } catch { return 1000; }
    });
  }
}

export interface PreflightOptions {
  ledger: Ledger | null;
  logFile: string;
  needs: Need[];
  dotnetTarget?: string;
  dotnetCwd?: string;
  deadlineAtMs?: number;
  clock?: Clock;
  recheck?: boolean;
  onResult?: (c: Check) => void;
  /** Disk probe seam: defaults to the real measurement; tests inject deterministic samples. */
  readDisk?: () => Promise<DiskSample>;
}

/** Bound a single preflight subprocess/sleep by the caller's remaining deadline; never start at/past it. */
export function preflightTimeoutMs(o: Pick<PreflightOptions, "deadlineAtMs" | "clock">, normalMs: number): number {
  const remaining = o.deadlineAtMs === undefined ? Infinity : o.deadlineAtMs - (o.clock?.now() ?? Date.now());
  if (remaining <= 0) throw new Error("preflight deadline reached");
  return Math.min(normalMs, remaining);
}

async function docker(budget: TimeoutBudget): Promise<Check> {
  const r = await spawnGroup(["docker", "ps", "--format", "{{.ID}}"], { timeoutMs: budget(60_000) });
  return { name: "docker", need: "docker", ok: r.code === 0 && !r.timedOut, detail: r.code === 0 && !r.timedOut ? "docker daemon accessible" : r.stderr.trim().split("\n")[0] || (r.timedOut ? "timed out" : `exit ${r.code}`) };
}

async function browser(budget: TimeoutBudget): Promise<Check> {
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  const bin = existsSync("/opt/google/chrome/chrome") ? "/opt/google/chrome/chrome" : names.map((n) => Bun.which(n)).find(Boolean);
  if (!bin) return { name: "browser", need: "browser", ok: false, detail: `no Chrome/Chromium found (looked for /opt/google/chrome/chrome, ${names.join(", ")})` };
  const url = "data:text/html," + encodeURIComponent("<body><script>document.body.setAttribute('data-ovn','rendered')</script></body>");
  const r = await spawnGroup([bin, "--headless=new", "--no-sandbox", "--disable-gpu", "--dump-dom", url], { timeoutMs: budget(60_000) });
  const ok = !r.timedOut && r.stdout.includes('data-ovn="rendered"');
  return { name: "browser", need: "browser", ok, detail: ok ? `${bin} rendered data-ovn="rendered"` : r.stderr.trim().split("\n")[0] || (r.timedOut ? "timed out" : "page did not render") };
}

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;

async function playwrightMcp(budget: TimeoutBudget): Promise<Check> {
  const name = "playwright_mcp";
  const config = join(homedir(), ".omp/agent/mcp.json");
  const servers = existsSync(config) ? record(record(JSON.parse(readFileSync(config, "utf8")))?.mcpServers) : null;
  const entries = Object.entries(servers ?? {});
  const selected = entries.find(([key]) => key === "playwright") ?? entries.find(([, value]) => {
    const v = record(value);
    return `${v?.command} ${Array.isArray(v?.args) ? v.args.join(" ") : ""}`.includes("@playwright/mcp");
  });
  if (!selected) return { name, need: "browser", ok: true, detail: "skipped: no Playwright MCP configured" };
  const entry = record(selected[1]);
  if (!entry || typeof entry.command !== "string" || (entry.args !== undefined && (!Array.isArray(entry.args) || !entry.args.every((v) => typeof v === "string")))) {
    return { name, need: "browser", ok: false, detail: "invalid Playwright MCP command/args" };
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(record(entry.env) ?? {})) if (typeof v === "string") env[k] = v;
  const timeoutMs = budget(180_000);
  const g = startGroup([entry.command, ...((entry.args as string[] | undefined) ?? [])], { env, stdin: "pipe" });
  const stderr = new Response(g.stderr).text().catch(() => "");
  const send = (message: Record<string, unknown>) => g.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "omp-overnight-preflight", version: "1" } } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = (async (): Promise<Check> => {
      for await (const line of readLines(g.stdout)) {
        let message: Record<string, unknown> | null;
        try { message = record(JSON.parse(line)); } catch { continue; }
        if (message?.id === 1) {
          if (message.error) return { name, need: "browser", ok: false, detail: String(record(message.error)?.message ?? "initialize failed") };
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: { url: "about:blank" } } });
        } else if (message?.id === 2) {
          const result = record(message.result);
          const texts = Array.isArray(result?.content) ? result.content.map((c) => record(c)?.text).filter((v): v is string => typeof v === "string") : [];
          const ok = result !== null && result.isError !== true;
          return { name, need: "browser", ok, detail: ok ? "browser_navigate about:blank succeeded" : texts[0]?.split("\n")[0] || String(record(message.error)?.message ?? "browser_navigate failed") };
        }
      }
      return { name, need: "browser", ok: false, detail: (await stderr).trim().split("\n")[0] || "MCP exited before browser_navigate response" };
    })();
    return await Promise.race([response, new Promise<Check>((resolve) => {
      timer = setTimeout(() => resolve({ name, need: "browser", ok: false, detail: "timed out" }), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
    await g.kill();
  }
}

async function dotnetRestore(run: RunJson, wt: string, o: PreflightOptions, budget: TimeoutBudget): Promise<Check> {
  if (/\bdotnet\s+restore\b/.test(run.setupCommand)) return { name: "dotnet", need: "dotnet", ok: true, detail: "covered by setupCommand" };
  const r = await spawnGroup(["dotnet", "restore", ...(o.dotnetTarget ? [o.dotnetTarget] : [])], { cwd: resolve(wt, o.dotnetCwd ?? "."), timeoutMs: budget(20 * 60_000), logFile: o.logFile });
  const codes = [...new Set(`${r.stdout}\n${r.stderr}`.match(/\bNU\d{4}\b/g) ?? [])];
  return { name: "dotnet", need: "dotnet", ok: r.code === 0 && !r.timedOut, detail: r.code === 0 && !r.timedOut ? "dotnet restore passed" : `${r.timedOut ? "timed out" : `exit ${r.code}`}${codes.length ? ` (${codes.join(", ")})` : ""}; see ${o.logFile}` };
}

/** Real global/tool checks; only need-scoped failures get one delayed retry. */
export async function runPreflight(run: RunJson, o: PreflightOptions): Promise<Check[]> {
  const results: Check[] = [];
  const budget: TimeoutBudget = (ms) => preflightTimeoutMs(o, ms);
  const evaluate = async (name: string, step: () => Check | Promise<Check>, need?: Need): Promise<Check> => {
    const attempt = async (): Promise<Check> => {
      try { return await step(); } catch (e) { return { name, need, ok: false, detail: errMsg(e) }; }
    };
    let c = await attempt();
    const retryMs = Math.min(15_000, o.deadlineAtMs === undefined ? Infinity : o.deadlineAtMs - (o.clock?.now() ?? Date.now()));
    if (!c.ok && need && retryMs > 0) {
      await (o.clock?.sleep ?? sleep)(retryMs);
      c = await attempt();
      c.detail += " (after retry)";
    }
    return c;
  };
  const add = (c: Check) => {
    results.push(c);
    o.ledger?.log("preflight", { name: c.name, ok: c.ok, detail: c.detail, ...(c.need ? { need: c.need } : {}) });
    o.onResult?.(c);
  };
  if (!o.recheck) {
    add(await evaluate("power", power));
    add(await evaluate("git_clean", () => gitClean(run)));
  }
  // Free space comes first: a low disk must stop the run before any fetch, worktree or baseline test allocates.
  // Past the deadline every remaining check fails identically, so keep recording them (unchanged result shape).
  const disk = await evaluate("disk", async () => {
    budget(DF_TIMEOUT_MS);
    const s = await (o.readDisk ?? (() => probeDisk(run)))();
    return { name: "disk", ok: s.ok, detail: s.detail };
  });
  add(disk);
  const pastDeadline = o.deadlineAtMs !== undefined && (o.clock?.now() ?? Date.now()) >= o.deadlineAtMs;
  if (!disk.ok && !pastDeadline) return results;
  add(await evaluate("forge_auth", () => forgeAuth(run, budget)));
  if (o.needs.includes("docker")) add(await evaluate("docker", () => docker(budget), "docker"));
  if (o.needs.includes("browser")) {
    add(await evaluate("browser", () => browser(budget), "browser"));
    add(await evaluate("playwright_mcp", () => playwrightMcp(budget), "browser"));
  }
  let dotnet: Check | undefined;
  add(await evaluate("baseline_test", () => baselineTest(run, o.logFile, async (wt) => {
    if (o.needs.includes("dotnet")) dotnet = await evaluate("dotnet", () => dotnetRestore(run, wt, o, budget), "dotnet");
  }, budget)));
  if (dotnet) add(dotnet);
  return results;
}

/** Pending chunks whose tool needs intersect a failed need-scoped check (first matching check wins). */
export function chunksBlockedBy(chunks: Chunk[], checks: Check[]): { id: string; note: string }[] {
  return chunks.filter((c) => c.status === "pending").flatMap((c) => {
    const needs = chunkNeeds(c);
    const check = checks.find((x) => !x.ok && x.need && needs.includes(x.need));
    return check ? [{ id: c.id, note: `env: preflight ${check.name}: ${oneLine(check.detail).slice(0, 200)}` }] : [];
  });
}

/** Shared launch/run preflight requirements, considering only pending chunks. */
export interface PreflightRequirements { needs: Need[]; dotnetTarget?: string; dotnetCwd?: string }
export function preflightRequirements(chunks: Chunk[]): PreflightRequirements {
  const pending = chunks.filter((c) => c.status === "pending");
  const test = pending.find((c) => /\bdotnet\s+test\b/.test(c.test))?.test;
  const target = test?.match(/\bdotnet\s+test\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
  const value = target?.[1] ?? target?.[2] ?? target?.[3];
  const cd = test?.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*&&\s*dotnet\s+test\b/);
  const dotnetCwd = cd?.[1] ?? cd?.[2] ?? cd?.[3];
  return { needs: [...new Set(pending.flatMap(chunkNeeds))], dotnetTarget: value && !value.startsWith("-") ? value : undefined, ...(dotnetCwd ? { dotnetCwd } : {}) };
}
