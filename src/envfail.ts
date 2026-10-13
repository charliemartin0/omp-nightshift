// Environmental gate failures: the tests failed because of the machine, not the code (a port held by a stale dev
// server, a full disk, an OOM kill). Spending agent tokens on those is wasted at best; the 2026-10-11 map-poi-plans
// agent "fixed" a port clash with `reuseExistingServer: true`, which lets a gate silently test another worktree's
// server. The gate therefore cleans up and re-runs once without involving the agent.
import { readFileSync, readlinkSync } from "node:fs";
import { sep } from "node:path";
import { spawnGroup } from "./proc";
import { sweepGroup } from "./sweep";

export interface EnvSignature {
  kind: "port_in_use" | "disk_full" | "out_of_memory";
  /** ports named in the log (port_in_use) */
  ports: number[];
  /** one line for notes and the ledger */
  detail: string;
  /** a clean re-run can plausibly fix it */
  retryable: boolean;
}

const PORT_RES = [
  /EADDRINUSE[^\n]*?[:.](\d{2,5})\b/g,
  /address already in use[^\n]*?[:.](\d{2,5})\b/gi,
  /\bport[ :]+(\d{2,5})\b[^\n]*(?:already|in use|taken|busy)/gi,
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b[^\n]*(?:already|in use)/gi,
];

/** Evidence from one failed test run (its own log text and exit code); null when the failure looks like code. */
export function classifyEnvFailure(log: string, exitCode: number): EnvSignature | null {
  const ports = new Set<number>();
  for (const re of PORT_RES) for (const m of log.matchAll(re)) ports.add(Number(m[1]));
  if (ports.size) {
    const list = [...ports].sort((a, b) => a - b);
    return { kind: "port_in_use", ports: list, detail: `port ${list.join(", ")} already in use`, retryable: true };
  }
  if (/\bENOSPC\b|No space left on device/i.test(log)) return { kind: "disk_full", ports: [], detail: "no space left on device", retryable: false };
  if (exitCode === 137 || /JavaScript heap out of memory|Cannot allocate memory|\bENOMEM\b|std::bad_alloc/.test(log)) {
    return { kind: "out_of_memory", ports: [], detail: `out of memory (exit ${exitCode})`, retryable: true };
  }
  return null;
}

export interface Listener {
  pid: number;
  pgrp: number;
  cwd: string;
}
export interface Recovery {
  /** listener process groups stopped (they were this run's own leftovers) */
  freed: { port: number; pid: number; cwd: string }[];
  /** listeners left alone because they do not belong to this run's worktrees */
  foreign: { port: number; pid: number; cwd: string }[];
}

const pgrpOf = (pid: number): number => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
  } catch {
    return 0;
  }
};

/** Processes listening on a TCP port, via `ss`; pid/cwd are only visible for the same user. */
export async function listeners(port: number): Promise<Listener[]> {
  const r = await spawnGroup(["ss", "-H", "-ltnp", `sport = :${port}`], { timeoutMs: 15_000 });
  if (r.code !== 0) return [];
  const out: Listener[] = [];
  for (const m of r.stdout.matchAll(/pid=(\d+)/g)) {
    const pid = Number(m[1]);
    if (out.some((l) => l.pid === pid)) continue;
    let cwd = "";
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      /* gone, or not ours */
    }
    out.push({ pid, pgrp: pgrpOf(pid), cwd });
  }
  return out;
}

/**
 * Stop listeners on `ports` that were started from inside `worktreeRoot` (this run's own leftover dev servers).
 * A listener anywhere else (another run's worktree, a developer's own server) is never touched.
 */
export async function freeOwnPorts(ports: number[], worktreeRoot: string, find: (port: number) => Promise<Listener[]> = listeners): Promise<Recovery> {
  const rec: Recovery = { freed: [], foreign: [] };
  const root = worktreeRoot.endsWith(sep) ? worktreeRoot : worktreeRoot + sep;
  const self = pgrpOf(process.pid);
  for (const port of ports) {
    for (const l of await find(port)) {
      const ours = l.cwd !== "" && (l.cwd + sep).startsWith(root) && l.pgrp > 1 && l.pgrp !== self;
      if (!ours) {
        rec.foreign.push({ port, pid: l.pid, cwd: l.cwd });
        continue;
      }
      await sweepGroup(l.pgrp, { deep: true, graceMs: 2_000 });
      rec.freed.push({ port, pid: l.pid, cwd: l.cwd });
    }
  }
  return rec;
}

export const envSummary = (sigs: EnvSignature[]): string => [...new Set(sigs.map((s) => s.detail))].join("; ");
