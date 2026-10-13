import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { oneLine } from "./ctx";
import { git, gitOut } from "./git";

/** Build/tool output directory basenames the runner may reclaim at any depth inside a finished worktree. */
export const OUTPUT_DIRS: Record<string, true> = {
  node_modules: true, bin: true, obj: true, dist: true, "test-results": true,
  "playwright-report": true, ".turbo": true, coverage: true,
};

export interface CleanupResult {
  /** Logical (lstat) bytes of deleted regular files. */
  reclaimedBytes: number;
  removedFiles: number;
  /** Short human-readable reasons a path was left alone. */
  refused: string[];
}

const errText = (error: unknown): string => oneLine(error instanceof Error ? error.message : String(error)).slice(0, 160);
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

/** True when `child` is strictly contained in `parent` (component-wise, never a string-prefix match). */
function beneath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Reclaim untracked build output inside one finished worktree. All preconditions are checked before any traversal;
 * any failure refuses the whole cleanup (zero counts) instead of deleting a partial tree. Traversal never follows
 * symlinks, never crosses a nested repository boundary, protects every tracked path, and revalidates containment plus
 * file identity immediately before each unlink. A missing worktree is a zero-byte no-op, not an error.
 */
export async function cleanupBuildOutputs(worktreeRoot: string, wt: string): Promise<CleanupResult> {
  const refused: string[] = [];
  let reclaimedBytes = 0;
  let removedFiles = 0;
  const done = (): CleanupResult => ({ reclaimedBytes, removedFiles, refused });
  const refuse = (reason: string): CleanupResult => {
    refused.push(reason);
    return done();
  };

  // A missing worktree is nothing to clean.
  try {
    lstatSync(wt);
  } catch (error) {
    if (isMissing(error)) return done();
    return refuse(`worktree not inspectable: ${errText(error)}`);
  }

  let root: string;
  try {
    root = realpathSync(worktreeRoot);
    if (lstatSync(worktreeRoot).isSymbolicLink()) return refuse("symlink worktree root");
  } catch (error) {
    return refuse(`worktree root not inspectable: ${errText(error)}`);
  }
  if (!isAbsolute(wt) || resolve(wt) !== wt) return refuse("worktree path is not absolute and canonical");
  if (!beneath(root, wt)) return refuse("worktree is not beneath the worktree root");
  let cursor = root;
  for (const component of relative(root, wt).split(sep)) {
    cursor = join(cursor, component);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      return refuse(`worktree path not inspectable: ${errText(error)}`);
    }
    if (stat.isSymbolicLink()) return refuse(`symlink in worktree path: ${component}`);
    if (cursor !== wt && !stat.isDirectory()) return refuse(`non-directory in worktree path: ${component}`);
  }
  try {
    const top = await gitOut(wt, ["rev-parse", "--show-toplevel"]);
    if (realpathSync(top) !== realpathSync(wt)) return refuse("worktree is not a Git worktree toplevel");
    const listed = await gitOut(wt, ["worktree", "list", "--porcelain"]);
    const registered = listed.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
    if (!registered.includes(wt)) return refuse("worktree is not registered with Git");
  } catch (error) {
    return refuse(`cannot verify the worktree: ${errText(error)}`);
  }

  // Tracked paths (files and symlinks) stay verbatim, so a directory holding one can never become empty.
  let tracked: Set<string>;
  {
    const listing = await git(wt, ["ls-files", "-z", "--cached"]);
    if (listing.code !== 0) return refuse(`cannot enumerate tracked files: ${oneLine(listing.stderr) || `exit ${listing.code}`}`);
    tracked = new Set(listing.stdout.split("\0").filter(Boolean));
  }

  const pathLabel = (path: string): string => relative(wt, path) || path;

  /** Containment, ancestor no-symlink status and dev+ino identity still hold. */
  const stable = (path: string, dev: number, ino: number): boolean => {
    if (!beneath(wt, path)) return false;
    for (let at = path; at !== wt; at = dirname(at)) {
      let stat;
      try {
        stat = lstatSync(at);
      } catch {
        return false;
      }
      if (stat.isSymbolicLink()) return false;
      if (at === dirname(at)) break;
    }
    try {
      const now = lstatSync(path);
      return now.isFile() && now.dev === dev && now.ino === ino;
    } catch {
      return false;
    }
  };

  const removeFile = (path: string, dev: number, ino: number, size: number): void => {
    if (!stable(path, dev, ino)) {
      refused.push(`${pathLabel(path)}: changed during cleanup`);
      return;
    }
    try {
      if (!beneath(wt, realpathSync(path))) {
        refused.push(`${pathLabel(path)}: resolves outside the worktree`);
        return;
      }
      unlinkSync(path);
      reclaimedBytes += size;
      removedFiles += 1;
    } catch (error) {
      if (isMissing(error)) return;
      refused.push(`${pathLabel(path)}: unlink failed: ${errText(error)}`);
    }
  };

  /** Remove empty real directories bottom-up; a directory holding anything (tracked output, refused path) stays. */
  const prune = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === ".git") continue;
      const child = join(dir, name);
      let stat;
      try {
        stat = lstatSync(child);
      } catch {
        continue;
      }
      if (stat.isDirectory() && !stat.isSymbolicLink()) prune(child);
    }
    try {
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    } catch (error) {
      if (!isMissing(error)) refused.push(`${pathLabel(dir)}: rmdir failed: ${errText(error)}`);
    }
  };

  const walk = (dir: string, output: boolean): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      if (output) refused.push(`${pathLabel(dir)}: not readable: ${errText(error)}`);
      return;
    }
    for (const name of names) {
      if (name === ".git") continue;
      const child = join(dir, name);
      let stat;
      try {
        stat = lstatSync(child);
      } catch (error) {
        if (isMissing(error)) continue;
        if (output) refused.push(`${pathLabel(child)}: not inspectable: ${errText(error)}`);
        continue;
      }
      if (stat.isSymbolicLink()) {
        if (tracked.has(relative(wt, child))) continue; // tracked symlink: preserved verbatim
        if (output || OUTPUT_DIRS[name]) refused.push(`${pathLabel(child)}: symlink`);
        continue;
      }
      if (stat.isDirectory()) {
        if (existsSync(join(child, ".git"))) continue; // nested repository / submodule boundary
        if (OUTPUT_DIRS[name]) {
          walk(child, true);
          prune(child);
        } else {
          walk(child, output);
          if (output) prune(child);
        }
        continue;
      }
      if (!output) continue; // untracked non-output files are never touched
      if (tracked.has(relative(wt, child))) continue;
      if (stat.isFile()) {
        removeFile(child, stat.dev, stat.ino, stat.size);
      } else {
        refused.push(`${pathLabel(child)}: not a regular file`);
      }
    }
  };

  walk(wt, false);
  return done();
}
