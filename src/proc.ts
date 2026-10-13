// Process-group spawning. Every long-running child runs under `setsid`, so it leads its own
// process group and timeouts/signals reach grandchildren via process.kill(-pid, ...).
import { type BoundedLog, type LogLimits, openBoundedLog } from "./logcap";
import type { FileSink } from "bun";

export const GRACE_MS = 15_000;
const OUTPUT_CAP = 4_000_000;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait for `p`, but at most `ms` (the timer is cleared, so it never holds the event loop). */
export async function settle(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p, new Promise<void>((r) => (timer = setTimeout(r, ms)))]);
  clearTimeout(timer);
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

let shuttingDown = false;
const active = new Map<number, Promise<number>>(); // pid -> raw exit promise

export interface Group {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  stdin: FileSink | null;
  /** Exit code. After shutdown() this never resolves, parking the caller until the signal handler exits. */
  exited: Promise<number>;
  /** SIGTERM the group, wait up to GRACE_MS for the leader, then SIGKILL the group. */
  kill(): Promise<void>;
}

function signalGroup(pid: number, sig: NodeJS.Signals, leaderAlive: () => boolean): void {
  try {
    process.kill(-pid, sig);
  } catch {
    if (leaderAlive()) {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  }
}

async function terminate(pid: number, raw: Promise<number>, alive: () => boolean): Promise<void> {
  signalGroup(pid, "SIGTERM", alive);
  await settle(raw, GRACE_MS);
  signalGroup(pid, "SIGKILL", alive); // reach stragglers; ESRCH if the group is already empty
  await raw;
}

export function startGroup(argv: string[], o: { cwd?: string; env?: Record<string, string>; stdin?: "pipe" } = {}): Group {
  if (shuttingDown) throw new Error("runner is shutting down");
  const proc = Bun.spawn(["setsid", ...argv], {
    cwd: o.cwd,
    env: { ...process.env, ...o.env },
    stdin: o.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const pid = proc.pid;
  let alive = true;
  const raw = proc.exited.then((code) => {
    alive = false;
    active.delete(pid);
    return code;
  });
  active.set(pid, raw);
  return {
    pid,
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stderr: proc.stderr as ReadableStream<Uint8Array>,
    stdin: o.stdin === "pipe" ? proc.stdin as FileSink : null,
    exited: raw.then((code) => (shuttingDown ? new Promise<number>(() => {}) : code)),
    kill: () => terminate(pid, raw, () => alive),
  };
}

/** Kill every active group (SIGTERM, 15 s, SIGKILL) and refuse to start new ones. */
export async function shutdown(): Promise<void> {
  shuttingDown = true;
  await Promise.all([...active].map(([pid, raw]) => terminate(pid, raw, () => active.has(pid))));
}

export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  buf += dec.decode();
  if (buf) yield buf;
}

export interface SpawnOpts {
  cwd?: string;
  env?: Record<string, string>;
  /** Kill the group (SIGTERM, 15 s, SIGKILL) after this long. */
  timeoutMs?: number;
  /** Append stdout+stderr here (header line `$ argv`). */
  logFile?: string;
  /** Caps for the bounded log writer (`logFile` only); defaults to the logcap module defaults. */
  logLimits?: LogLimits;
}
export interface SpawnResult {
  code: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Byte offset where this invocation's log content begins (`logFile` only), else null. */
  logStartOffset: number | null;
}

async function drain(stream: ReadableStream<Uint8Array>, sink: { text: string }, log: BoundedLog | null): Promise<void> {
  const dec = new TextDecoder();
  for await (const chunk of stream) {
    const s = dec.decode(chunk, { stream: true });
    sink.text += s;
    if (sink.text.length > OUTPUT_CAP) sink.text = sink.text.slice(-OUTPUT_CAP / 2);
    if (log !== null) log.write(s);
  }
}

/** Run to completion inside its own process group, capturing (and optionally logging) output. */
export async function spawnGroup(argv: string[], o: SpawnOpts = {}): Promise<SpawnResult> {
  // Open the log first: a refused log path (symlink, unwritable) must not leave an unawaited child behind.
  const log = o.logFile ? openBoundedLog(o.logFile, o.logLimits) : null;
  let g: Group;
  try {
    g = startGroup(argv, o);
  } catch (error) {
    log?.close();
    throw error;
  }
  log?.write(`$ ${argv.join(" ")}\n`);
  let timedOut = false;
  const timer = o.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        void g.kill();
      }, o.timeoutMs)
    : undefined;
  const out = { text: "" };
  const err = { text: "" };
  const drained = Promise.all([drain(g.stdout, out, log), drain(g.stderr, err, log)]);
  const code = await g.exited;
  // A daemonised grandchild outside the group could hold the pipes open; do not wait on it forever.
  await settle(drained, 3000);
  clearTimeout(timer);
  const logStartOffset = log ? log.startOffset : null;
  log?.close();
  return { code, timedOut, stdout: out.text, stderr: err.text, logStartOffset };
}
