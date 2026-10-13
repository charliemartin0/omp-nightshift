import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ctx } from "../src/ctx";
import { LOG_CAP_MARKER, openBoundedLog } from "../src/logcap";
import { runOmp } from "../src/agent";
import { spawnGroup } from "../src/proc";

const MARKER_BYTES = Buffer.byteLength(LOG_CAP_MARKER);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh temp run dir; auto-removed after the test. */
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "logcap-"));
  dirs.push(d);
  return d;
}

/** Total bytes of counted `.log`/`.jsonl` files directly in `dir`. */
function countedBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || e.name.startsWith("ledger")) continue;
    if (e.name.endsWith(".log") || e.name.endsWith(".jsonl")) n += statSync(join(dir, e.name)).size;
  }
  return n;
}

test("appends up to the file cap without truncating", () => {
  const dir = tmp();
  const file = join(dir, "a.log");
  const log = openBoundedLog(file, { fileBytes: 4096, directoryBytes: 4096 * 8 });
  expect(log.startOffset).toBe(0);
  const line = `${"y".repeat(63)}\n`; // 64 bytes
  for (let i = 0; i < 64; i++) log.write(line); // exactly 4096 bytes
  log.close();
  expect(statSync(file).size).toBe(4096);
  expect(readFileSync(file, "utf8")).toBe(line.repeat(64));
  expect(log.startOffset).toBe(0);
});

test("bounds an oversized write to the cap before writing", () => {
  const dir = tmp();
  const file = join(dir, "a.log");
  const log = openBoundedLog(file, { fileBytes: 4096, directoryBytes: 4096 * 8 });
  const huge = Array.from({ length: 2000 }, (_, i) => `row-${i}\n`).join("");
  log.write(huge);
  expect(statSync(file).size).toBe(4096);
  expect(readFileSync(file, "utf8")).toBe(huge.slice(-4096));
  log.close();
});

test("per-file overflow compacts to half with the marker and newest tail", () => {
  const dir = tmp();
  const file = join(dir, "a.log");
  const log = openBoundedLog(file, { fileBytes: 4096, directoryBytes: 4096 * 8 });
  const huge = Array.from({ length: 2000 }, (_, i) => `row-${i}\n`).join("");
  log.write("first\n");
  log.write(huge);
  log.close();
  const size = statSync(file).size;
  expect(size).toBeLessThanOrEqual(2048);
  const text = readFileSync(file, "utf8");
  expect(text.startsWith(LOG_CAP_MARKER)).toBe(true);
  expect(text.endsWith("row-1999\n")).toBe(true);
});

test("repeated small writes keep the marker and newest tail with no unbounded growth", () => {
  const dir = tmp();
  const file = join(dir, "a.log");
  const log = openBoundedLog(file, { fileBytes: 8192, directoryBytes: 8192 * 8 });
  for (let i = 0; i < 800; i++) log.write(`line ${i} ${"z".repeat(60)}\n`);
  log.close();
  const size = statSync(file).size;
  expect(size).toBeLessThanOrEqual(8192);
  const text = readFileSync(file, "utf8");
  expect(text.startsWith(LOG_CAP_MARKER)).toBe(true);
  expect(text.endsWith("line 799 " + "z".repeat(60) + "\n")).toBe(true);
  expect(log.startOffset).toBeGreaterThanOrEqual(0);
  expect(log.startOffset).toBeLessThanOrEqual(size);
});

test("byte limits, not character counts, bound multibyte output", () => {
  const dir = tmp();
  const file = join(dir, "a.log");
  const log = openBoundedLog(file, { fileBytes: 1024, directoryBytes: 1024 * 16 });
  for (let i = 0; i < 400; i++) log.write(`${i}: ${"€".repeat(20)}\n`);
  log.close();
  const size = statSync(file).size;
  expect(size).toBeLessThanOrEqual(1024);
  const text = readFileSync(file, "utf8");
  expect(text.startsWith(LOG_CAP_MARKER)).toBe(true);
  expect(text.endsWith("399: " + "€".repeat(20) + "\n")).toBe(true);

  const file2 = join(dir, "b.log");
  const log2 = openBoundedLog(file2, { fileBytes: 1024, directoryBytes: 1024 * 16 });
  log2.write("s\n");
  log2.write("€".repeat(1000)); // 3000 bytes; total overflows the 1024-byte cap
  log2.close();
  expect(statSync(file2).size).toBeLessThanOrEqual(512);
});

test("an oversized pre-existing file is compacted on open", () => {
  const dir = tmp();
  const file = join(dir, "old.log");
  writeFileSync(file, "q".repeat(4096 * 4));
  const log = openBoundedLog(file, { fileBytes: 4096, directoryBytes: 4096 * 16 });
  const size = statSync(file).size;
  expect(size).toBeLessThanOrEqual(2048);
  expect(readFileSync(file, "utf8").startsWith(LOG_CAP_MARKER)).toBe(true);
  // This writer has written nothing yet: its content begins at the (new) end of the file.
  expect(log.startOffset).toBe(size);
  log.close();
});

test("directory cap reclaims oldest files first, including active writers", () => {
  const dir = tmp();
  // Old closed file, then an active writer: total 4000 > 3000.
  writeFileSync(join(dir, "old.log"), "O".repeat(2000));
  const act = openBoundedLog(join(dir, "active.log"), { fileBytes: 100_000, directoryBytes: 3000 });
  act.write("N".repeat(2000));
  expect(countedBytes(dir)).toBeLessThanOrEqual(3000);
  expect(readFileSync(join(dir, "old.log"), "utf8").startsWith(LOG_CAP_MARKER)).toBe(true);
  expect(readFileSync(join(dir, "active.log"), "utf8")).toBe("N".repeat(2000));
  act.close();

  // Two active writers: the older one's head is reclaimed through the coordinator.
  const dir2 = tmp();
  const w1 = openBoundedLog(join(dir2, "one.log"), { fileBytes: 100_000, directoryBytes: 3000 });
  w1.write("P".repeat(2000));
  const w2 = openBoundedLog(join(dir2, "two.log"), { fileBytes: 100_000, directoryBytes: 3000 });
  w2.write("Q".repeat(2000));
  expect(countedBytes(dir2)).toBeLessThanOrEqual(3000);
  const one = readFileSync(join(dir2, "one.log"), "utf8");
  expect(one.startsWith(LOG_CAP_MARKER)).toBe(true);
  expect(one.length).toBeLessThan(2000);
  expect(w1.startOffset).toBe(MARKER_BYTES);
  expect(readFileSync(join(dir2, "two.log"), "utf8")).toBe("Q".repeat(2000));
  expect(w2.startOffset).toBe(0);
  w1.close();
  w2.close();
});

test("a closed file at marker residue is deleted when the directory is still over cap", () => {
  const dir = tmp();
  writeFileSync(join(dir, "a.log"), "A".repeat(200));
  writeFileSync(join(dir, "b.log"), "B".repeat(200));
  const act = openBoundedLog(join(dir, "c.log"), { fileBytes: 100_000, directoryBytes: 60 });
  expect(existsSync(join(dir, "a.log"))).toBe(false);
  expect(readFileSync(join(dir, "b.log"), "utf8")).toBe(LOG_CAP_MARKER);
  expect(countedBytes(dir)).toBeLessThanOrEqual(60);
  act.close();
});

test("a symlinked log file is refused", () => {
  const dir = tmp();
  const real = join(dir, "real.log");
  writeFileSync(real, "hi\n");
  const link = join(dir, "link.log");
  symlinkSync(real, link);
  expect(() => openBoundedLog(link)).toThrow();
});

test("a symlinked logs directory is refused", () => {
  const dir = tmp();
  const realDir = join(dir, "realdir");
  mkdirSync(realDir);
  const linkDir = join(dir, "linkdir");
  symlinkSync(realDir, linkDir);
  expect(() => openBoundedLog(join(linkDir, "a.log"))).toThrow();
});

test("unrelated files and other extensions are preserved", () => {
  const dir = tmp();
  writeFileSync(join(dir, "notes.md"), "# keep\n");
  writeFileSync(join(dir, "data.txt"), "keep me\n");
  writeFileSync(join(dir, "ledger.jsonl"), "L".repeat(50_000));
  const log = openBoundedLog(join(dir, "app.log"), { fileBytes: 2048, directoryBytes: 8192 });
  log.write("M".repeat(20_000));
  log.close();
  expect(statSync(join(dir, "app.log")).size).toBeLessThanOrEqual(2048);
  expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("# keep\n");
  expect(readFileSync(join(dir, "data.txt"), "utf8")).toBe("keep me\n");
  expect(readFileSync(join(dir, "ledger.jsonl"), "utf8")).toBe("L".repeat(50_000));
});

test("the active inode is unchanged by head truncation", () => {
  const dir = tmp();
  const file = join(dir, "a.log");
  const log = openBoundedLog(file, { fileBytes: 4096, directoryBytes: 4096 * 8 });
  const before = statSync(file).ino;
  log.write("seed\n");
  log.write(Array.from({ length: 2000 }, (_, i) => `z-${i}\n`).join(""));
  expect(readFileSync(file, "utf8").startsWith(LOG_CAP_MARKER)).toBe(true);
  expect(statSync(file).ino).toBe(before);
  log.close();
});

test("writes after close are ignored and close is idempotent", () => {
  const dir = tmp();
  const file = join(dir, "a.log");
  const log = openBoundedLog(file, { fileBytes: 4096, directoryBytes: 4096 * 8 });
  log.write("hello\n");
  const before = statSync(file).size;
  log.close();
  log.close();
  log.write("ignored\n");
  expect(statSync(file).size).toBe(before);
  expect(readFileSync(file, "utf8")).toBe("hello\n");
});

test("limits too small for the marker are rejected", () => {
  const dir = tmp();
  expect(() => openBoundedLog(join(dir, "a.log"), { fileBytes: 10, directoryBytes: 10 })).toThrow();
  const w1 = openBoundedLog(join(dir, "b.log"), { fileBytes: 4096, directoryBytes: 4096 * 8 });
  expect(() => openBoundedLog(join(dir, "c.log"), { fileBytes: 4096, directoryBytes: MARKER_BYTES * 2 - 1 })).toThrow();
  w1.close();
});

test("spawnGroup bounds a chatty command's log to a small cap", async () => {
  const dir = tmp();
  const logs = join(dir, "logs");
  const logFile = join(logs, "cmd.log");
  const r = await spawnGroup(["bash", "-lc", "seq 1 2000"], {
    logFile,
    logLimits: { fileBytes: 1024, directoryBytes: 4096 },
  });
  expect(r.code).toBe(0);
  expect(r.logStartOffset).not.toBeNull();
  const size = statSync(logFile).size;
  expect(size).toBeLessThanOrEqual(4096);
  const text = readFileSync(logFile, "utf8");
  expect(text.startsWith(LOG_CAP_MARKER)).toBe(true);
  expect(text.endsWith("2000\n")).toBe(true);
  expect(countedBytes(logs)).toBeLessThanOrEqual(4096);
});

test("runOmp bounds a fake omp stream and returns", async () => {
  const dir = tmp();
  const logs = join(dir, "logs");
  const sessions = join(dir, "sessions");
  mkdirSync(logs, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const argvFile = join(dir, "argv.txt");
  const omp = join(bin, "omp");
  writeFileSync(
    omp,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\ni=0\nwhile [ $i -lt 2000 ]; do i=$((i+1)); printf '{"type":"message_end","message":{"role":"assistant"},"i":%d}\\n' "$i"; done\n`,
  );
  chmodSync(omp, 0o755);

  const ctx = {
    run: {
      limits: { maxTime: "30m", resumeMaxTime: "15m", tokenCap: 3_000_000, stallMinutes: 10, testTimeoutMinutes: 20 },
      models: { plan: "@plan", build: "@default", report: "@smol" },
    },
    logs,
    sessions,
    overlay: join(dir, "overlay.yml"),
    ledger: { log: () => {} },
    runTokens: 0,
    stopAtMs: null,
    capAtMs: Date.now() + 3_600_000,
  } as unknown as Ctx;

  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${oldPath}`;
    const res = await runOmp(ctx, {
      chunk: "c1",
      wt: dir,
      n: 1,
      mode: { kind: "initial", promptFile: join(dir, "prompt.md") },
      tokensUsed: 0,
      logLimits: { fileBytes: 2048, directoryBytes: 8192 },
    });
    expect(res.code).toBe(0);
  } finally {
    process.env.PATH = oldPath;
  }

  const jsonl = join(logs, "c1-omp-1.jsonl");
  const text = readFileSync(jsonl, "utf8");
  expect(text.startsWith(LOG_CAP_MARKER)).toBe(true);
  expect(text.endsWith('"i":2000}\n')).toBe(true);
  expect(countedBytes(logs)).toBeLessThanOrEqual(8192);
  const argv = readFileSync(argvFile, "utf8").split("\n");
  expect(argv).toContain("--mode");
  expect(argv).toContain("json");
});
