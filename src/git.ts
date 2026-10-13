import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { type SpawnResult, spawnGroup } from "./proc";
import { withRepoLock } from "./repolock";

/** Optional caller-owned deadline budget; existing callers keep the normal subprocess timeouts. */
export type TimeoutBudget = (timeoutMs: number) => number;

/** git -C <cwd> <args>; never prompts for credentials. */
export function git(cwd: string, args: string[], o: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<SpawnResult> {
  const timeoutMs = o.timeoutMs ?? 120_000;
  const started = Date.now();
  const invoke = () => {
    const remaining = timeoutMs > 0 ? timeoutMs - (Date.now() - started) : timeoutMs;
    if (timeoutMs > 0 && remaining <= 0) throw new Error("git command timeout exhausted while acquiring repository flock");
    return spawnGroup(["git", "-C", cwd, ...args], {
      timeoutMs: remaining,
      env: { GIT_TERMINAL_PROMPT: "0", ...o.env },
    });
  };
  // These mutate the shared common directory, including calls made by preflight and cleanup outside chunk setup.
  return args[0] === "fetch" || args[0] === "push" || args[0] === "pull" || args[0] === "branch" || args[0] === "update-ref"
    || (args[0] === "worktree" && args[1] !== "list")
    ? withRepoLock(cwd, invoke, timeoutMs > 0 ? timeoutMs : undefined)
    : invoke();
}

/** Trimmed stdout of a git command; throws with stderr on failure. */
export async function gitOut(cwd: string, args: string[], budget?: TimeoutBudget): Promise<string> {
  const r = await git(cwd, args, { timeoutMs: budget?.(120_000) });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

export async function commonDir(repo: string, budget?: TimeoutBudget): Promise<string> {
  return realpathSync(resolve(repo, await gitOut(repo, ["rev-parse", "--git-common-dir"], budget)));
}

/** Graphite trunk from .graphite_repo_config, else origin/HEAD, else "main". */
export async function resolveTrunk(repo: string): Promise<string> {
  try {
    const cfg = join(await commonDir(repo), ".graphite_repo_config");
    if (existsSync(cfg)) {
      const cfgJson: unknown = JSON.parse(readFileSync(cfg, "utf8"));
      const trunk = typeof cfgJson === "object" && cfgJson !== null && "trunk" in cfgJson ? cfgJson.trunk : undefined;
      if (typeof trunk === "string" && trunk) return trunk;
    }
  } catch {
    /* fall through */
  }
  const r = await git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const m = /^origin\/(.+)$/.exec(r.stdout.trim());
  return r.code === 0 && m ? m[1] : "main";
}

export interface Remote {
  scheme: "ssh" | "https" | "other";
  user: string;
  host: string;
  port?: string;
  /** "owner/name" (last two path segments, no .git) */
  ownerRepo: string;
}

export function parseRemote(url: string): Remote {
  const tail = (p: string) => p.replace(/\.git\/?$/, "").split("/").filter(Boolean).slice(-2).join("/");
  let m = /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(url);
  if (m) return { scheme: "https", user: "", host: m[1], ownerRepo: tail(m[2]) };
  m = /^ssh:\/\/(?:([^@/]+)@)?([^/:]+)(?::(\d+))?\/(.+)$/.exec(url);
  if (m) return { scheme: "ssh", user: m[1] ?? "git", host: m[2], port: m[3], ownerRepo: tail(m[4]) };
  m = /^(?:([^@/]+)@)?([^:/]+):(.+)$/.exec(url); // scp-like: git@host:owner/name.git
  if (m) return { scheme: "ssh", user: m[1] ?? "git", host: m[2], ownerRepo: tail(m[3]) };
  return { scheme: "other", user: "", host: "", ownerRepo: tail(url) };
}

export async function originUrl(repo: string, remote: string, budget?: TimeoutBudget): Promise<string> {
  return gitOut(repo, ["remote", "get-url", remote], budget);
}

/**
 * Base ref for new work. A `local`-forge repo with no such remote has nothing to fetch: use the local trunk branch.
 * Every other case uses `<remote>/<trunk>` (and a missing remote then fails loudly at fetch).
 */
export async function trunkBase(run: { repo: string; remote: string; trunk: string; forge: string }, budget?: TimeoutBudget): Promise<{ ref: string; fetch: boolean }> {
  if (run.forge === "local" && (await git(run.repo, ["remote", "get-url", run.remote], { timeoutMs: budget?.(120_000) })).code !== 0) return { ref: run.trunk, fetch: false };
  return { ref: `${run.remote}/${run.trunk}`, fetch: true };
}

/** `<root>/<name>`, suffixed -2, -3... while the path exists (retained worktrees are never reused or removed). */
export function freePath(root: string, name: string): string {
  for (let n = 1; ; n++) {
    const p = join(root, n === 1 ? name : `${name}-${n}`);
    try {
      lstatSync(p); // A dangling symlink still occupies the path.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return p;
      throw error;
    }
  }
}

/** `overnight/<date>-<id>`, suffixed -2, -3... while a local branch of that name exists. */
export async function pickBranch(repo: string, date: string, id: string): Promise<string> {
  const base = `overnight/${date}-${id}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const r = await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    if (r.code !== 0) return name;
  }
}

/** Remove only a Git-registered worktree; never hand-delete an unrecognised directory. */
export async function removeWorktree(repo: string, wt: string, budget?: TimeoutBudget): Promise<void> {
  const r = await git(repo, ["worktree", "remove", "--force", wt], { timeoutMs: budget?.(120_000) });
  if (r.code !== 0) throw new Error(`worktree remove: ${r.stderr.trim() || `exit ${r.code}`}`);
}
