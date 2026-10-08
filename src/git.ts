import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { type SpawnResult, spawnGroup } from "./proc";

/** git -C <cwd> <args>; never prompts for credentials. */
export function git(cwd: string, args: string[], o: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<SpawnResult> {
  return spawnGroup(["git", "-C", cwd, ...args], {
    timeoutMs: o.timeoutMs ?? 120_000,
    env: { GIT_TERMINAL_PROMPT: "0", ...o.env },
  });
}

/** Trimmed stdout of a git command; throws with stderr on failure. */
export async function gitOut(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

export async function commonDir(repo: string): Promise<string> {
  return resolve(repo, await gitOut(repo, ["rev-parse", "--git-common-dir"]));
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

export async function originUrl(repo: string, remote: string): Promise<string> {
  return gitOut(repo, ["remote", "get-url", remote]);
}

/**
 * Base ref for new work. A `local`-forge repo with no such remote has nothing to fetch: use the local trunk branch.
 * Every other case uses `<remote>/<trunk>` (and a missing remote then fails loudly at fetch).
 */
export async function trunkBase(run: { repo: string; remote: string; trunk: string; forge: string }): Promise<{ ref: string; fetch: boolean }> {
  if (run.forge === "local" && (await git(run.repo, ["remote", "get-url", run.remote])).code !== 0) return { ref: run.trunk, fetch: false };
  return { ref: `${run.remote}/${run.trunk}`, fetch: true };
}

/** `<root>/<name>`, suffixed -2, -3... while the path exists (retained worktrees are never reused or removed). */
export function freePath(root: string, name: string): string {
  for (let n = 1; ; n++) {
    const p = join(root, n === 1 ? name : `${name}-${n}`);
    if (!existsSync(p)) return p;
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

/** Remove a runner-owned worktree; falls back to deleting the directory when git no longer knows it. */
export async function removeWorktree(repo: string, wt: string): Promise<void> {
  const r = await git(repo, ["worktree", "remove", "--force", wt]);
  if (r.code !== 0 && existsSync(wt)) {
    rmSync(wt, { recursive: true, force: true });
    await git(repo, ["worktree", "prune"]);
  }
}
