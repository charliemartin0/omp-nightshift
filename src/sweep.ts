// Scope sweep: after every phase (agent session, setup, gate test run) stop whatever it left behind, such as
// Vite/webpack dev servers, headless browsers or a yarn tree, so a stale listener cannot fail the next phase
// ("http://localhost:9999 is already used", 2026-10-11) or serve another chunk's worktree.
//
// Every runner child starts under `setsid`, so its pid is both its process-group id and its session id. A sweep
// signals every process of that group, and in `deep` mode of that session too (catches `set -m` job-control
// children that moved to their own group). Processes that call setsid themselves (real daemons) are out of reach on
// purpose: transient systemd scopes would catch them but would also outlive the unit on a crash.
import { readFileSync, readdirSync } from "node:fs";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Member {
  pid: number;
  comm: string;
}
export interface SweepResult {
  /** processes found alive after the phase ended */
  found: number;
  /** their command names (bounded) */
  comms: string[];
  /** still alive after SIGKILL (should be 0) */
  survivors: number;
}
export const SWEEP_GRACE_MS = 3_000;
const NONE: SweepResult = { found: 0, comms: [], survivors: 0 };

/** Live (non-zombie) processes of process group or session `id`, excluding this process. Linux /proc. */
export function groupMembers(id: number, procDir = "/proc"): Member[] {
  const out: Member[] = [];
  let names: string[];
  try {
    names = readdirSync(procDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let stat: string;
    try {
      stat = readFileSync(`${procDir}/${name}/stat`, "utf8");
    } catch {
      continue; // exited while scanning
    }
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")"); // comm may itself contain spaces and parentheses
    if (open < 0 || close < open) continue;
    const [state, , pgrp, sid] = stat.slice(close + 2).split(" ");
    if (state === "Z" || state === "X") continue;
    if (Number(pgrp) === id || Number(sid) === id) out.push({ pid, comm: stat.slice(open + 1, close) });
  }
  return out;
}

function signal(pids: number[], sig: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

const groupAlive = (id: number): boolean => {
  try {
    process.kill(-id, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function waitGone(id: number, ms: number, procDir: string): Promise<Member[]> {
  const until = Date.now() + ms;
  let left = groupMembers(id, procDir);
  while (left.length && Date.now() < until) {
    await sleep(50);
    left = groupMembers(id, procDir);
  }
  return left;
}

/**
 * SIGTERM, wait up to `graceMs`, SIGKILL whatever is left of group/session `id`. Cheap when nothing is left: the
 * shallow form is a single `kill(-id, 0)` probe, `deep` also scans /proc for session members.
 */
export async function sweepGroup(id: number, o: { deep?: boolean; graceMs?: number; procDir?: string } = {}): Promise<SweepResult> {
  const procDir = o.procDir ?? "/proc";
  if (!o.deep && !groupAlive(id)) return NONE;
  const first = groupMembers(id, procDir);
  if (!first.length) return NONE;
  signal(first.map((m) => m.pid), "SIGTERM");
  try {
    process.kill(-id, "SIGTERM");
  } catch {
    /* group already empty */
  }
  let left = await waitGone(id, o.graceMs ?? SWEEP_GRACE_MS, procDir);
  if (left.length) {
    signal(left.map((m) => m.pid), "SIGKILL");
    try {
      process.kill(-id, "SIGKILL");
    } catch {
      /* group already empty */
    }
    left = await waitGone(id, 2_000, procDir);
  }
  return { found: first.length, comms: [...new Set(first.map((m) => m.comm))].slice(0, 8), survivors: left.length };
}

/** Ledger logger for `SpawnOpts.onSweep` / the agent phase; stays silent when the phase left nothing behind. */
export function sweepLogger(ctx: { ledger: { log(event: string, f?: Record<string, unknown>): void } }, phase: string, chunk?: string) {
  return (r: SweepResult): void => {
    if (r.found > 0) ctx.ledger.log("sweep", { ...(chunk ? { chunk } : {}), phase, found: r.found, comms: r.comms, survivors: r.survivors });
  };
}
