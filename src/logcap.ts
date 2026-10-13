// Bounded, append-only log writer for the ledger-adjacent `logs` directory.
//
// Every writer in one directory shares a single module-level coordinator, so all byte accounting and cap mutation is
// synchronous and cannot interleave between the stdout/stderr writers of one process. Files are never renamed: head
// truncation rewrites the same inode through a separate positional (`r+`) descriptor, then ftruncates.
import {
  closeSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const FILE_BYTES = 200 * 1024 * 1024;
export const DIRECTORY_BYTES = 1024 * 1024 * 1024;

/** Written at the head of any truncated file, then the retained tail. */
export const LOG_CAP_MARKER = "[disk log cap: earlier output truncated]\n";

const MARKER_BYTES = Buffer.byteLength(LOG_CAP_MARKER);
const COPY_CHUNK = 64 * 1024;

/** Only these extensions, directly inside the directory, are counted. */
const COUNTED_SUFFIXES = [".log", ".jsonl"];
/** The run ledger lives in runDir, not here; never count or touch it even if the paths ever coincide. */
const EXCLUDED_NAMES = new Set(["ledger.jsonl", "ledger.dry-run.jsonl"]);

export interface LogLimits {
  fileBytes: number;
  directoryBytes: number;
}

export interface BoundedLog {
  write(data: string | Uint8Array): void;
  /** Idempotent; writes after close are silently ignored. */
  close(): void;
  /** Byte offset where this writer's current invocation content begins, adjusted for head truncation. */
  readonly startOffset: number;
}

export const DEFAULT_LOG_LIMITS: LogLimits = { fileBytes: FILE_BYTES, directoryBytes: DIRECTORY_BYTES };

interface WriterState {
  file: string;
  fd: number;
  closed: boolean;
  startOffset: number;
}

interface Coordinator {
  dir: string;
  limits: LogLimits;
  /** Known sizes (bytes) of the counted files, shared by every writer on this directory. */
  sizes: Map<string, number>;
  writers: Set<WriterState>;
}

const coordinators = new Map<string, Coordinator>();

/** Reject a symlinked (or otherwise non-directory) logs directory; create it if missing; return its real path. */
function ensureDir(dir: string): string {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    st = null;
  }
  if (st) {
    if (st.isSymbolicLink()) throw new Error(`logs directory is a symlink: ${dir}`);
    if (!st.isDirectory()) throw new Error(`logs path is not a directory: ${dir}`);
  } else {
    mkdirSync(dir, { recursive: true });
  }
  return realpathSync(dir);
}

/** Reject a symlinked / non-regular log file. */
function checkLogFile(file: string): void {
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) throw new Error(`log file is a symlink: ${file}`);
  if (!st.isFile()) throw new Error(`log path is not a regular file: ${file}`);
}

/** Direct (non-recursive) regular `.log`/`.jsonl` files only; symlinks and directories are never followed. */
function inventory(c: Coordinator): void {
  const seen = new Set<string>();
  let entries;
  try {
    entries = readdirSync(c.dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!COUNTED_SUFFIXES.some((s) => e.name.endsWith(s)) || EXCLUDED_NAMES.has(e.name)) continue;
    const p = join(c.dir, e.name);
    seen.add(p);
    try {
      c.sizes.set(p, statSync(p).size);
    } catch {
      c.sizes.delete(p);
    }
  }
  for (const p of [...c.sizes.keys()]) {
    if (!seen.has(p) && !hasWriter(c, p)) c.sizes.delete(p);
  }
}

function getCoordinator(dir: string, limits: LogLimits): Coordinator {
  let c = coordinators.get(dir);
  if (!c) {
    c = { dir, limits, sizes: new Map(), writers: new Set() };
    coordinators.set(dir, c);
    inventory(c);
  }
  return c;
}

function hasWriter(c: Coordinator, file: string): boolean {
  for (const w of c.writers) if (w.file === file) return true;
  return false;
}

function total(c: Coordinator): number {
  let n = 0;
  for (const size of c.sizes.values()) n += size;
  return n;
}

/** Fresh size, refreshing (or dropping) the tracked entry. */
function sizeOf(c: Coordinator, file: string): number {
  try {
    const size = statSync(file).size;
    c.sizes.set(file, size);
    return size;
  } catch {
    c.sizes.delete(file);
    return 0;
  }
}

function readAll(fd: number, buf: Buffer, position: number, length: number): number {
  let off = 0;
  while (off < length) {
    const n = readSync(fd, buf, off, length - off, position + off);
    if (n <= 0) break;
    off += n;
  }
  return off;
}

function writeAll(fd: number, buf: Buffer, position: number | null, length: number): number {
  let off = 0;
  while (off < length) {
    const n = writeSync(fd, buf, off, length - off, position === null ? null : position + off);
    if (n <= 0) break;
    off += n;
  }
  return off;
}

/**
 * Rewrite `file` so it holds at most `keepTotal` bytes: the cap marker, then the retained tail. Uses a separate `r+`
 * descriptor with bounded 64KiB copies and a final ftruncate; the inode never changes. Returns the number of bytes
 * dropped from the front (the prefix offset every active writer's startOffset is rebased against).
 */
function compactFile(c: Coordinator, file: string, keepTotal: number): number {
  const size = sizeOf(c, file);
  const target = Math.max(MARKER_BYTES, Math.floor(keepTotal));
  if (size <= target) return 0;
  let src = Math.max(0, size - (target - MARKER_BYTES));
  const fd = openSync(file, "r+");
  try {
    // Prefer a newline boundary inside the first copied window, dropping a partial leading line.
    const head = Buffer.alloc(Math.min(COPY_CHUNK, size - src));
    const got = readAll(fd, head, src, head.length);
    const nl = head.subarray(0, got).indexOf(0x0a);
    if (nl >= 0) src += nl + 1;

    const marker = Buffer.from(LOG_CAP_MARKER, "utf8");
    writeAll(fd, marker, 0, marker.length);

    const buf = Buffer.alloc(COPY_CHUNK);
    let readPos = src;
    let writePos = MARKER_BYTES;
    while (readPos < size) {
      const want = Math.min(COPY_CHUNK, size - readPos);
      const n = readAll(fd, buf, readPos, want);
      if (n <= 0) break;
      const wrote = writeAll(fd, buf, writePos, n);
      readPos += n;
      writePos += wrote;
      if (wrote < n) break;
    }
    ftruncateSync(fd, writePos);
    c.sizes.set(file, writePos);

    for (const w of c.writers) {
      if (w.file === file) w.startOffset = MARKER_BYTES + Math.max(0, w.startOffset - src);
    }
    return size - writePos;
  } finally {
    closeSync(fd);
  }
}

function byMtimeThenName(c: Coordinator, blocked?: Set<string>): string[] {
  const rows: { path: string; mtime: number }[] = [];
  for (const p of c.sizes.keys()) {
    if (blocked?.has(p)) continue;
    try {
      rows.push({ path: p, mtime: statSync(p).mtimeMs });
    } catch {
      c.sizes.delete(p);
    }
  }
  rows.sort((a, b) => (a.mtime === b.mtime ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : a.mtime - b.mtime));
  return rows.map((r) => r.path);
}

/** Reclaim directory bytes from the oldest files first, then delete closed marker-only residue if still over. */
function reclaimDirectory(c: Coordinator): void {
  const cap = c.limits.directoryBytes;
  const blocked = new Set<string>();
  while (total(c) > cap) {
    const [oldest] = byMtimeThenName(c, blocked);
    if (oldest === undefined) break;
    const size = sizeOf(c, oldest);
    if (size <= MARKER_BYTES) {
      blocked.add(oldest);
      continue;
    }
    const deficit = total(c) - cap;
    compactFile(c, oldest, Math.max(MARKER_BYTES, size - deficit));
    blocked.add(oldest);
  }
  if (total(c) > cap) {
    for (const p of byMtimeThenName(c)) {
      if (total(c) <= cap) break;
      if (hasWriter(c, p)) continue;
      if (sizeOf(c, p) === MARKER_BYTES) {
        try {
          unlinkSync(p);
        } catch {
          /* already gone */
        }
        c.sizes.delete(p);
      }
    }
  }
}

/** Per-file overflow compacts to at most half the cap, then the directory cap is enforced. */
function enforce(c: Coordinator): void {
  for (const p of [...c.sizes.keys()]) {
    if (sizeOf(c, p) > c.limits.fileBytes) compactFile(c, p, Math.floor(c.limits.fileBytes / 2));
  }
  if (total(c) > c.limits.directoryBytes) reclaimDirectory(c);
}

function validateLimits(c: Coordinator, limits: LogLimits): void {
  if (!(limits.fileBytes > 0) || !(limits.directoryBytes > 0)) {
    throw new Error(`log caps must be positive (fileBytes=${limits.fileBytes}, directoryBytes=${limits.directoryBytes})`);
  }
  if (limits.fileBytes < MARKER_BYTES) {
    throw new Error(`log file cap ${limits.fileBytes} bytes is smaller than the ${MARKER_BYTES}-byte truncation marker`);
  }
  const writers = c.writers.size + 1;
  if (limits.directoryBytes < writers * MARKER_BYTES) {
    throw new Error(
      `log directory cap ${limits.directoryBytes} bytes cannot hold ${writers} active writer marker(s) of ${MARKER_BYTES} bytes`,
    );
  }
}

/**
 * Append-only bounded writer for one log file inside its `logs` directory. Caps are enforced on open (including
 * pre-existing oversized files) and on every append, per file and per directory.
 */
export function openBoundedLog(file: string, limits: LogLimits = DEFAULT_LOG_LIMITS): BoundedLog {
  const abs = resolve(file);
  const dir = ensureDir(dirname(abs));
  const target = join(dir, basename(abs));
  checkLogFile(target);

  const c = getCoordinator(dir, limits);
  validateLimits(c, limits);
  c.limits = limits;
  inventory(c);

  let size = 0;
  try {
    size = statSync(target).size;
  } catch {
    /* new file */
  }
  const w: WriterState = { file: target, fd: openSync(target, "a"), closed: false, startOffset: size };
  c.writers.add(w);
  c.sizes.set(target, size);

  const log: BoundedLog = {
    write(data) {
      if (w.closed) return;
      const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      if (buf.length === 0) return;
      const cap = c.limits.fileBytes;
      const payload = buf.length > cap ? buf.subarray(buf.length - cap) : buf;
      const n = writeAll(w.fd, payload, null, payload.length);
      c.sizes.set(w.file, (c.sizes.get(w.file) ?? 0) + n);
      if ((c.sizes.get(w.file) ?? 0) > cap) compactFile(c, w.file, Math.floor(cap / 2));
      if (total(c) > c.limits.directoryBytes) reclaimDirectory(c);
    },
    close() {
      if (w.closed) return;
      w.closed = true;
      c.writers.delete(w);
      try {
        closeSync(w.fd);
      } catch {
        /* already closed */
      }
    },
    get startOffset() {
      return w.startOffset;
    },
  };
  enforce(c);
  return log;
}
