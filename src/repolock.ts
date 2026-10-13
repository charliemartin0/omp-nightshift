import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { readLines, spawnGroup, startGroup } from "./proc";

export const REPO_LOCK_FILE = "omp-nightshift.lock";
export const REPO_LOCK_WAIT_MS = 120_000;

/** For agent commands, from either the main checkout or any linked worktree. Never nest this wrapper. */
export const REPO_LOCK_WRAPPER = `overnight_repo() (
  common=$(git rev-parse --path-format=absolute --git-common-dir) || exit
  exec 9>"$common/${REPO_LOCK_FILE}" || exit
  flock -x -w ${REPO_LOCK_WAIT_MS / 1000} -E 75 9 || {
    printf '%s\\n' 'overnight repository lock unavailable (${REPO_LOCK_WAIT_MS / 1000}s maximum wait); stop and report the lock holder' >&2
    exit 75
  }
  exec "$@"
)`;

const paths = new Map<string, string>();
const held = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>();

export async function repoLockPath(repo: string, timeoutMs = REPO_LOCK_WAIT_MS): Promise<string> {
  const key = resolve(repo);
  const cached = paths.get(key);
  if (cached) return cached;
  // Do not share an in-flight lookup: a short-budget caller must not inherit another caller's longer timeout.
  const r = await spawnGroup(["git", "-C", key, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: Math.max(1, timeoutMs) });
  if (r.code !== 0) throw new Error(`git common directory: ${r.stderr.trim() || `exit ${r.code}`}`);
  const path = join(realpathSync(r.stdout.trim()), REPO_LOCK_FILE);
  paths.set(key, path);
  return path;
}

/** A short-lived child holds flock while the callback performs only shared repository steps. */
async function acquire<T>(path: string, fn: () => Promise<T>, waitMs: number): Promise<T> {
  const holder = startGroup(["flock", "-x", "-w", String(waitMs / 1000), "-E", "75", "--", path, "sh", "-c", "printf 'locked\\n'; cat >/dev/null"], { stdin: "pipe" });
  try {
    const ready = await readLines(holder.stdout).next();
    if (ready.done || ready.value !== "locked") {
      const detail = await new Response(holder.stderr).text();
      const code = await holder.exited;
      throw new Error(code === 75 ? `repository flock timed out after ${waitMs}ms` : `repository flock: ${detail.trim() || `exit ${code}`}`);
    }
    const lease = { active: true };
    const context = new Map(held.getStore());
    context.set(path, lease);
    try {
      return await held.run(context, fn);
    } finally {
      lease.active = false;
    }
  } finally {
    holder.stdin!.end();
    await holder.exited;
  }
}

/** Bounded acquisition, reentrant in this call chain only; children never inherit a lock-bypass flag. */
export async function withRepoLock<T>(repo: string, fn: () => Promise<T>, waitMs = REPO_LOCK_WAIT_MS): Promise<T> {
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error("repository flock wait must be finite and nonnegative");
  const started = Date.now();
  const path = await repoLockPath(repo, waitMs || REPO_LOCK_WAIT_MS); // Zero means a nonblocking flock, not a 1ms Git lookup.
  if (held.getStore()?.get(path)?.active) return fn();
  // flock also serialises callers in this process, so there is no unbounded in-process queue ahead of its timeout.
  return acquire(path, fn, Math.max(0, waitMs - (Date.now() - started)));
}
