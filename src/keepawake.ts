// Keep the Windows host awake while a run is active. systemd-inhibit only holds locks inside the WSL VM; Windows
// decides on its own to sleep (idle timeout, power plan) and then freezes the whole VM, runner included.
// A powershell.exe helper asserts SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED)
// for as long as the runner keeps touching a lease file; it works without admin rights. An explicit sleep command
// (a scheduled task calling SetSuspendState) still wins, which is what the `windows_sleep` preflight check is for.
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "./preflight";
import { readLines, spawnGroup, startGroup } from "./proc";

const SYS32 = "/mnt/c/Windows/System32";
export const ES_FLAGS = 0x80000041; // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED
const ES_CONTINUOUS = 0x80000000;
const LEASE_STALE_S = 120;
const LEASE_TOUCH_MS = 20_000;

export interface WindowsTools {
  powershell: string;
  schtasks: string;
}

/** True under WSL (and false when `OMP_NIGHTSHIFT_WINDOWS=off`, which the unit tests use). */
export function isWsl(env: NodeJS.ProcessEnv = process.env, procVersion = "/proc/version"): boolean {
  if (env.OMP_NIGHTSHIFT_WINDOWS === "off") return false;
  if (env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync(procVersion, "utf8"));
  } catch {
    return false;
  }
}

function find(name: string, override: string | undefined, fallback: string): string | null {
  if (override) return existsSync(override) ? override : null;
  return Bun.which(name) ?? (existsSync(fallback) ? fallback : null);
}

/** powershell.exe / schtasks.exe for the Windows host; null outside WSL. WSL often has no Windows PATH, so fall back to /mnt/c. */
export function windowsTools(env: NodeJS.ProcessEnv = process.env): WindowsTools | null {
  if (env.OMP_NIGHTSHIFT_WINDOWS === "off") return null;
  const overridden = Boolean(env.OMP_NIGHTSHIFT_POWERSHELL || env.OMP_NIGHTSHIFT_SCHTASKS);
  if (!overridden && !isWsl(env)) return null;
  const powershell = find("powershell.exe", env.OMP_NIGHTSHIFT_POWERSHELL, `${SYS32}/WindowsPowerShell/v1.0/powershell.exe`);
  const schtasks = find("schtasks.exe", env.OMP_NIGHTSHIFT_SCHTASKS, `${SYS32}/schtasks.exe`);
  return powershell && schtasks ? { powershell, schtasks } : null;
}

/** PowerShell source of the holder loop; exits when the lease file vanishes or is not touched for LEASE_STALE_S. */
export function holderScript(winLeasePath: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace Nightshift -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    `$lease = '${winLeasePath.replace(/'/g, "''")}'`,
    `$flags = [uint32]${ES_FLAGS}`,
    "if ([Nightshift.Power]::SetThreadExecutionState($flags) -eq 0) { Write-Output 'keepawake-failed'; exit 1 }",
    "Write-Output 'keepawake-ready'",
    `while ((Test-Path -LiteralPath $lease) -and (((Get-Date) - (Get-Item -LiteralPath $lease).LastWriteTime).TotalSeconds -lt ${LEASE_STALE_S})) {`,
    "  Start-Sleep -Seconds 15",
    "  [void][Nightshift.Power]::SetThreadExecutionState($flags)",
    "}",
    `[void][Nightshift.Power]::SetThreadExecutionState([uint32]${ES_CONTINUOUS})`,
  ].join("\n");
}

export interface KeepAwake {
  ok: boolean;
  detail: string;
  stop(): Promise<void>;
}

export interface KeepAwakeOptions {
  /** lease file the holder watches; touched while the runner lives */
  leaseFile: string;
  tools?: WindowsTools | null;
  /** WSL path -> Windows path (default `wslpath -w`) */
  toWinPath?: (p: string) => Promise<string>;
  readyTimeoutMs?: number;
  touchMs?: number;
}

const wslpathW = async (p: string): Promise<string> => {
  const r = await spawnGroup(["wslpath", "-w", p], { timeoutMs: 10_000 });
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(`wslpath -w failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

const NOOP = (detail: string): KeepAwake => ({ ok: false, detail, stop: async () => {} });

/** Start the holder; never throws (a failed keep-awake is a ledger warning, not a stop). */
export async function startKeepAwake(o: KeepAwakeOptions): Promise<KeepAwake> {
  const tools = o.tools === undefined ? windowsTools() : o.tools;
  if (!tools) return NOOP("skipped: not WSL (no powershell.exe)");
  try {
    writeFileSync(o.leaseFile, `${process.pid}\n`);
    const script = holderScript(await (o.toWinPath ?? wslpathW)(o.leaseFile));
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const g = startGroup([tools.powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]);
    void new Response(g.stderr).text().catch(() => ""); // drain
    const first = (async (): Promise<string> => {
      for await (const line of readLines(g.stdout)) if (/keepawake-(ready|failed)/.test(line)) return line.trim();
      return "exited";
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([first, new Promise<string>((r) => { timer = setTimeout(() => r("timeout"), o.readyTimeoutMs ?? 30_000); })]);
    clearTimeout(timer);
    const touch = setInterval(() => {
      try { utimesSync(o.leaseFile, new Date(), new Date()); } catch { /* lease removed: stopping */ }
    }, o.touchMs ?? LEASE_TOUCH_MS);
    touch.unref();
    const stop = async () => {
      clearInterval(touch);
      rmSync(o.leaseFile, { force: true });
      await g.kill();
    };
    if (outcome !== "keepawake-ready") {
      await stop();
      return NOOP(`powershell holder ${outcome}`);
    }
    return { ok: true, detail: "SetThreadExecutionState(system+away) held by powershell.exe while the lease is touched", stop };
  } catch (e) {
    rmSync(o.leaseFile, { force: true });
    return NOOP(e instanceof Error ? e.message : String(e));
  }
}

export interface ScheduledTask {
  name: string;
  state: string;
  action: string;
}

/** `schtasks /Query /FO CSV /V /NH` rows. The action column embeds unescaped quotes, so split on `","`, not CSV rules. */
export function parseSchtasks(csv: string): ScheduledTask[] {
  const tasks: ScheduledTask[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const f = line.replace(/^"/, "").replace(/"\s*$/, "").split('","');
    if (f.length < 12) continue;
    tasks.push({ name: f[1], action: f[8], state: f[11] });
  }
  return tasks;
}

const SLEEP_RE = /sleep|suspend|hibernate|SetSuspendState|shutdown(\.exe)?\s+\/[hs]\b/i;
const FILE_RE = /[A-Za-z]:\\[^"|<>]*?\.(?:ps1|bat|cmd|exe|vbs|sh)\b/i;

/** `C:\a\b.ps1` -> `<root>/c/a/b.ps1` (root `/mnt` under WSL). */
export function winToWsl(p: string, root = "/mnt"): string {
  return join(root, p[0].toLowerCase(), p.slice(3).replace(/\\/g, "/"));
}

/**
 * Enabled non-system scheduled tasks that put the PC to sleep. A task whose script no longer exists is a harmless
 * no-op (the `NightlySleep` task after its script was deleted); a live one will suspend the VM under the runner, so it is reported as a warning (the run still starts).
 */
export async function windowsSleep(tools: WindowsTools, o: { env?: NodeJS.ProcessEnv; driveRoot?: string } = {}): Promise<Check> {
  const name = "windows_sleep";
  const env = o.env ?? process.env;
  const r = await spawnGroup([tools.schtasks, "/Query", "/FO", "CSV", "/V", "/NH"], { timeoutMs: 60_000 });
  if (r.code !== 0 || r.timedOut) return { name, ok: true, detail: `skipped: schtasks failed (${r.stderr.trim().split("\n")[0] || `exit ${r.code}`})` };
  const sleepers = parseSchtasks(r.stdout).filter((t) => !t.name.startsWith("\\Microsoft\\") && /^enabled$/i.test(t.state) && SLEEP_RE.test(t.action));
  const live: ScheduledTask[] = [];
  const inert: string[] = [];
  for (const t of sleepers) {
    const file = FILE_RE.exec(t.action)?.[0];
    if (file && !existsSync(winToWsl(file, o.driveRoot))) inert.push(`${t.name} (action ${file} is missing, so it does nothing)`);
    else live.push(t);
  }
  if (live.length) {
    const fix = live.map((t) => `Disable-ScheduledTask -TaskName '${t.name.replace(/^\\/, "")}'`).join("; ");
    const detail = `scheduled task(s) ${live.map((t) => t.name).join(", ")} will suspend this PC and freeze the run (the watchdog and timers exclude the gap); disable in an admin PowerShell: ${fix}`;
    if (env.OMP_NIGHTSHIFT_ALLOW_SCHEDULED_SLEEP === "1") return { name, ok: true, detail: `allowed by OMP_NIGHTSHIFT_ALLOW_SCHEDULED_SLEEP: ${detail}` };
    return { name, ok: true, warn: true, detail };
  }
  return { name, ok: true, detail: inert.length ? `no live scheduled sleep; inert: ${inert.join("; ")}` : "no scheduled sleep task" };
}
