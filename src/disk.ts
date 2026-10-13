import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { spawnGroup } from "./proc";
import { GIB, type RunJson } from "./runjson";

/** One measured filesystem: `repo`/`worktree` hold the Linux paths, `host` the WSL backing drive. */
export interface DiskVolume {
  kind: "repo" | "worktree" | "host";
  freeBytes: number;
  minBytes: number;
}

/** Result of one capacity measurement; `ok` is false when any volume is low or any probe failed. */
export interface DiskSample {
  ok: boolean;
  detail: string;
  volumes: DiskVolume[];
}

/** Everything probeDisk touches outside the process, so tests can drive it synchronously. */
export interface DiskDeps {
  run(argv: string[], o: { cwd?: string; env?: Record<string, string>; timeoutMs: number }): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>;
  isWsl(): boolean;
  exists(path: string): boolean;
  isDir(path: string): boolean;
  readdir(path: string): string[];
  env: Record<string, string | undefined>;
}

export const DF_TIMEOUT_MS = 15_000;
const WSL_INTEROP = "/proc/sys/fs/binfmt_misc/WSLInterop";

export const isWsl = (): boolean => existsSync(WSL_INTEROP) || Boolean(process.env.WSL_DISTRO_NAME);

/**
 * Free bytes from `df -Pk` output. POSIX format puts inodes/blocks, used, available and capacity first and the
 * mount point last (it may contain spaces), so only those leading fields are positional.
 */
export function parseDfAvailable(stdout: string): number {
  const rows = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const data = rows.filter((l) => !/^Filesystem\s/i.test(l));
  if (data.length !== 1) throw new Error(`df output does not describe exactly one filesystem: ${rows.join(" | ") || "(empty)"}`);
  const fields = data[0].split(/\s+/);
  if (fields.length < 6 || !/^\d+%$/.test(fields[4])) throw new Error(`unexpected df row: ${data[0]}`);
  const blocks = Number(fields[3]);
  if (!Number.isSafeInteger(blocks) || blocks < 0) throw new Error(`unexpected df available field: ${fields[3]}`);
  return blocks * 1024;
}

/** `df -Pk` free bytes for one path, or null when the probe failed (missing path, permissions, timeout, bad output). */
async function dfFreeBytes(path: string, deps: DiskDeps): Promise<number | null> {
  try {
    const r = await deps.run(["df", "-Pk", "--", path], { env: { LC_ALL: "C" }, timeoutMs: DF_TIMEOUT_MS });
    if (r.code !== 0 || r.timedOut) return null;
    return parseDfAvailable(r.stdout);
  } catch {
    return null;
  }
}

/** Nearest existing ancestor: worktreeRoot normally does not exist yet, and creating it is not a probe's job. */
function nearestExistingDir(path: string, deps: DiskDeps): string | null {
  for (let p = path; ; ) {
    if (deps.exists(p)) return deps.isDir(p) ? p : null;
    const parent = dirname(p);
    if (parent === p) return null;
    p = parent;
  }
}

const DRIVE_RE = /^([A-Za-z]):/;
const MOUNTED_DRIVE_RE = /^[a-z]$/;

/**
 * `powershell.exe` first (Windows interop normally adds it to PATH), else the binary inside a mounted Windows
 * install: interop executes Windows executables by absolute path, and some WSL setups never put them on PATH.
 */
function powershellCandidates(deps: DiskDeps): string[] {
  if (!deps.exists("/mnt") || !deps.isDir("/mnt")) return ["powershell.exe"];
  const installed = deps.readdir("/mnt")
    .filter((n) => MOUNTED_DRIVE_RE.test(n))
    .map((d) => `/mnt/${d}/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`)
    .filter((p) => deps.exists(p));
  return ["powershell.exe", ...installed];
}

/** First candidate that runs the script to exit 0; the parse result still decides whether Windows answered. */
async function powershellOut(script: string, deps: DiskDeps): Promise<string | null> {
  for (const exe of powershellCandidates(deps)) {
    try {
      const r = await deps.run([exe, "-NoProfile", "-Command", script], { timeoutMs: DF_TIMEOUT_MS });
      if (r.code === 0 && !r.timedOut) return r.stdout;
    } catch {
      /* try the next location */
    }
  }
  return null;
}

/**
 * The Windows drive holding the distro's ext4.vhdx: the current distribution's `BasePath` drive, else the drive of
 * `%LOCALAPPDATA%` (the requested default). Returns null rather than guessing; the caller then tries the mounted
 * `/mnt/<drive>` fallback, and fails closed when no single drive is identifiable.
 */
async function wslHostDrive(deps: DiskDeps): Promise<string | null> {
  const inherited = deps.env.LOCALAPPDATA?.match(DRIVE_RE)?.[1];
  const out = await powershellOut(POWERSHELL_DRIVE, deps);
  const parsed = out === null ? null : parsePowershell(out);
  if (parsed !== null) return parsed.drive;
  if (inherited) return inherited;
  const mounted = deps.exists("/mnt") && deps.isDir("/mnt") ? deps.readdir("/mnt").filter((n) => MOUNTED_DRIVE_RE.test(n)) : [];
  return mounted.length === 1 ? mounted[0] : null;
}

/** Drive and free space for the distro's backing drive, straight from Windows; null when Windows cannot say. */
async function wslHostFreeBytes(deps: DiskDeps): Promise<{ drive: string; freeBytes: number } | null> {
  const out = await powershellOut(POWERSHELL_FREE, deps);
  if (out === null) return null;
  const parsed = parsePowershell(out);
  return parsed && parsed.freeBytes !== undefined ? { drive: parsed.drive, freeBytes: parsed.freeBytes } : null;
}

function parsePowershell(stdout: string): { drive: string; freeBytes?: number } | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const { drive, freeBytes } = v as Record<string, unknown>;
  if (typeof drive !== "string" || !/^[A-Za-z]$/.test(drive)) return null;
  if (freeBytes === undefined) return { drive: drive.toUpperCase() };
  if (typeof freeBytes !== "number" || !Number.isSafeInteger(freeBytes) || freeBytes < 0) return null;
  return { drive: drive.toUpperCase(), freeBytes };
}

/** Report the current distribution's `BasePath` drive; Windows may also hand back the drive only, without space. */
const POWERSHELL_DRIVE = [
  "$ErrorActionPreference='Stop'",
  "$d=$null",
  "$n=$env:WSL_DISTRO_NAME",
  "if($n){foreach($k in Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss' -ErrorAction SilentlyContinue){if($k.GetValue('DistributionName') -eq $n){$b=[string]$k.GetValue('BasePath');if($b -match '([A-Za-z]):'){$d=$Matches[1]};break}}}",
  "if(-not $d -and $env:LOCALAPPDATA -match '([A-Za-z]):'){$d=$Matches[1]}",
  "if($d){ConvertTo-Json -Compress -InputObject @{drive=$d}}else{Write-Output '{}'}",
].join("; ");

/** Report the drive and its free space in one call; omits freeBytes when Windows cannot enumerate the disk. */
const POWERSHELL_FREE = [
  "$ErrorActionPreference='Stop'",
  "$d=$null",
  "$n=$env:WSL_DISTRO_NAME",
  "if($n){foreach($k in Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss' -ErrorAction SilentlyContinue){if($k.GetValue('DistributionName') -eq $n){$b=[string]$k.GetValue('BasePath');if($b -match '([A-Za-z]):'){$d=$Matches[1]};break}}}",
  "if(-not $d -and $env:LOCALAPPDATA -match '([A-Za-z]):'){$d=$Matches[1]}",
  "if(-not $d){Write-Output '{}';exit 0}",
  "$l=Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='$($d):'\" -ErrorAction SilentlyContinue",
  "if($l){ConvertTo-Json -Compress -InputObject @{drive=$d;freeBytes=[long]$l.FreeSpace}}else{ConvertTo-Json -Compress -InputObject @{drive=$d}}",
].join("; ");

export const realDiskDeps: DiskDeps = {
  run: (argv, o) => spawnGroup(argv, { cwd: o.cwd, env: o.env, timeoutMs: o.timeoutMs }),
  isWsl,
  exists: existsSync,
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  readdir: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  env: process.env,
};

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

/**
 * Measure the filesystems holding the repository and the worktree root, plus (under WSL only) the Windows drive
 * backing the distro. Thresholds are inclusive: exactly the configured GiB still passes. A failed probe is never
 * treated as zero free space — it fails the sample, so a broken measurement cannot silently allow a run.
 */
export async function probeDisk(run: RunJson, deps: DiskDeps = realDiskDeps): Promise<DiskSample> {
  const minBytes = Math.round(run.disk.minFreeGb * GIB);
  const volumes: DiskVolume[] = [];
  const failures: string[] = [];
  const parts: string[] = [];

  for (const [kind, path] of [["repo", run.repo], ["worktree", run.worktreeRoot]] as const) {
    const dir = nearestExistingDir(path, deps);
    const free = dir === null ? null : await dfFreeBytes(dir, deps);
    if (dir === null) failures.push(`${kind} ${path}: no existing directory to measure`);
    else if (free === null) failures.push(`${kind} ${dir}: df failed`);
    else {
      volumes.push({ kind, freeBytes: free, minBytes });
      parts.push(`${kind} ${dir}: ${gib(free)} free (min ${run.disk.minFreeGb})`);
    }
  }

  if (deps.isWsl()) {
    const host = await wslHostFreeBytes(deps);
    const drive = host?.drive ?? (await wslHostDrive(deps));
    const free = drive === null ? null : host?.freeBytes ?? (await dfFreeBytes(`/mnt/${drive.toLowerCase()}`, deps));
    if (drive === null) failures.push("host drive: unavailable (no PowerShell, no %LOCALAPPDATA% drive, no single /mnt drive)");
    else if (free === null) failures.push(`host drive ${drive}: df failed`);
    else {
      const minHostBytes = Math.round(run.disk.minHostFreeGb * GIB);
      volumes.push({ kind: "host", freeBytes: free, minBytes: minHostBytes });
      parts.push(`host ${drive}: ${gib(free)} free (min ${run.disk.minHostFreeGb})`);
    }
  }

  const low = volumes.filter((v) => v.freeBytes < v.minBytes);
  const ok = failures.length === 0 && low.length === 0;
  const short = low.map((v) => `${v.kind} ${gib(v.freeBytes)} below ${gib(v.minBytes)}`);
  const detail = [...parts, ...failures.map((f) => `error: ${f}`), ...(short.length ? [`low: ${short.join("; ")}`] : [])].join("; ");
  return { ok, detail: detail || "disk ok", volumes };
}
