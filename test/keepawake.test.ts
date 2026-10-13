import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ES_FLAGS, holderScript, isWsl, parseSchtasks, startKeepAwake, windowsSleep, windowsTools, winToWsl } from "../src/keepawake";
import { type Check, runPreflight } from "../src/preflight";
import { setup } from "./helpers";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "keepawake-"));
  dirs.push(d);
  return d;
};
afterEach(() => { dirs.length = 0; });
const shim = (dir: string, name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/bash\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const decode = (b64: string) => Buffer.from(b64, "base64").toString("utf16le");

/** real rows from the PC: unescaped quotes inside the action column */
const SCHTASKS = [
  `"HOST","\\NightlySleep","11/10/2026 23:00:00","Ready","Interactive only","10/10/2026 23:00:01","0","N/A","powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\Users\\user\\bin\\sleep-now.ps1"","N/A","N/A","Enabled","Disabled","","user","Disabled","00:05:00","n/a","Daily ","23:00:00"`,
  `"HOST","\\CamCameraNightStop","11/10/2026 23:00:00","Ready","Interactive only","10/10/2026 23:00:01","127","N/A","wsl.exe -d Ubuntu-24.04 -- /home/user/Dev/cam/scripts/camera-night-stop.sh","N/A","Stop cam","Enabled","Disabled","","user"`,
  `"HOST","\\Microsoft\\Windows\\Power\\Sleep","N/A","Ready","Interactive only","N/A","0","N/A","C:\\Windows\\System32\\sleep.exe","N/A","N/A","Enabled","Disabled"`,
  `"HOST","\\OldHibernate","N/A","Disabled","Interactive only","N/A","0","N/A","shutdown.exe /h","N/A","N/A","Disabled","Disabled"`,
].join("\n");

test("isWsl and windowsTools follow the environment, shims and the off switch", () => {
  const d = tmp();
  const ps = shim(d, "powershell.exe", "true");
  const st = shim(d, "schtasks.exe", "true");
  expect(isWsl({ OMP_NIGHTSHIFT_WINDOWS: "off", WSL_DISTRO_NAME: "x" })).toBe(false);
  expect(isWsl({ WSL_DISTRO_NAME: "Ubuntu" })).toBe(true);
  expect(windowsTools({ OMP_NIGHTSHIFT_WINDOWS: "off", OMP_NIGHTSHIFT_POWERSHELL: ps, OMP_NIGHTSHIFT_SCHTASKS: st })).toBeNull();
  expect(windowsTools({ OMP_NIGHTSHIFT_POWERSHELL: ps, OMP_NIGHTSHIFT_SCHTASKS: st })).toEqual({ powershell: ps, schtasks: st });
  expect(windowsTools({ OMP_NIGHTSHIFT_POWERSHELL: join(d, "missing.exe"), OMP_NIGHTSHIFT_SCHTASKS: st })).toBeNull();
});

test("holder script asserts continuous system+away execution state and watches the lease", () => {
  const s = holderScript("\\\\wsl.localhost\\Ubuntu\\tmp\\it's.lease");
  expect(ES_FLAGS).toBe(0x80000041);
  expect(s).toContain("SetThreadExecutionState");
  expect(s).toContain("[uint32]2147483713");
  expect(s).toContain("'\\\\wsl.localhost\\Ubuntu\\tmp\\it''s.lease'");
  expect(s).toContain("Test-Path -LiteralPath $lease");
});

test("startKeepAwake runs the holder from a lease, touches it, and stop() releases everything", async () => {
  const d = tmp();
  const argvFile = join(d, "argv");
  const pidFile = join(d, "pid");
  const ps = shim(d, "powershell.exe", `echo "$@" > ${argvFile}\necho $$ > ${pidFile}\necho keepawake-ready\nexec sleep 300`);
  const lease = join(d, ".keepawake");
  const ka = await startKeepAwake({ leaseFile: lease, tools: { powershell: ps, schtasks: ps }, toWinPath: async (p) => `W:${p}`, touchMs: 30 });
  expect(ka.ok).toBe(true);
  const args = readFileSync(argvFile, "utf8").trim().split(" ");
  expect(args).toContain("-EncodedCommand");
  expect(decode(args[args.length - 1])).toContain(`'W:${lease}'`);
  const m1 = Bun.file(lease).lastModified;
  await Bun.sleep(150);
  expect(Bun.file(lease).lastModified).toBeGreaterThan(m1);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  expect(alive(pid)).toBe(true);
  await ka.stop();
  expect(existsSync(lease)).toBe(false);
  await Bun.sleep(100);
  expect(alive(pid)).toBe(false);
});

test("startKeepAwake degrades to a warning, never throws", async () => {
  const d = tmp();
  const failing = shim(d, "powershell.exe", "echo keepawake-failed; exit 1");
  const silent = shim(d, "ps-silent.exe", "exec sleep 300");
  const lease = join(d, ".keepawake");
  const base = { leaseFile: lease, toWinPath: async (p: string) => p };
  expect(await startKeepAwake({ ...base, tools: { powershell: failing, schtasks: failing } })).toMatchObject({ ok: false, detail: "powershell holder keepawake-failed" });
  expect(await startKeepAwake({ ...base, tools: { powershell: silent, schtasks: silent }, readyTimeoutMs: 200 })).toMatchObject({ ok: false, detail: "powershell holder timeout" });
  expect(await startKeepAwake({ ...base, tools: null })).toMatchObject({ ok: false });
  expect(await startKeepAwake({ ...base, tools: { powershell: failing, schtasks: failing }, toWinPath: async () => { throw new Error("no wslpath"); } })).toMatchObject({ ok: false, detail: "no wslpath" });
  expect(existsSync(lease)).toBe(false);
});

test("schtasks rows with unescaped quotes parse; paths map onto /mnt", () => {
  const tasks = parseSchtasks(SCHTASKS);
  expect(tasks.map((t) => t.name)).toEqual(["\\NightlySleep", "\\CamCameraNightStop", "\\Microsoft\\Windows\\Power\\Sleep", "\\OldHibernate"]);
  expect(tasks[0]).toMatchObject({ state: "Enabled", action: expect.stringContaining("sleep-now.ps1") });
  expect(winToWsl("C:\\Users\\user\\bin\\sleep-now.ps1")).toBe("/mnt/c/Users/user/bin/sleep-now.ps1");
});

function schtasksShim(csv: string, code = 0) {
  const d = tmp();
  writeFileSync(join(d, "rows.csv"), csv);
  const schtasks = shim(d, "schtasks.exe", code ? "echo access denied >&2; exit 1" : `cat ${join(d, "rows.csv")}`);
  return { d, tools: { powershell: schtasks, schtasks } };
}

test("windows_sleep: a scheduled sleep whose script is gone is inert", async () => {
  const { d, tools } = schtasksShim(SCHTASKS);
  const c = await windowsSleep(tools, { driveRoot: d });
  expect(c).toMatchObject({ name: "windows_sleep", ok: true });
  expect(c.detail).toContain("\\NightlySleep");
  expect(c.detail).toContain("does nothing");
});

test("windows_sleep: a live scheduled sleep warns with the exact fix, and can be silenced", async () => {
  const { d, tools } = schtasksShim(SCHTASKS);
  mkdirSync(join(d, "c/Users/user/bin"), { recursive: true });
  writeFileSync(join(d, "c/Users/user/bin/sleep-now.ps1"), "Start-Sleep 1");
  const bad = await windowsSleep(tools, { driveRoot: d, env: {} });
  expect(bad).toMatchObject({ ok: true, warn: true }); // a warning never blocks the launch
  expect(bad.detail).toContain("Disable-ScheduledTask -TaskName 'NightlySleep'");
  expect(bad.detail).not.toContain("CamCameraNightStop"); // night-stop is not a sleep command
  expect(bad.detail).not.toContain("OldHibernate"); // disabled
  const allowed = await windowsSleep(tools, { driveRoot: d, env: { OMP_NIGHTSHIFT_ALLOW_SCHEDULED_SLEEP: "1" } });
  expect(allowed.ok).toBe(true);
  expect(allowed.warn).toBeUndefined();
});

test("windows_sleep: no sleep tasks, and schtasks failures, pass", async () => {
  expect((await windowsSleep(schtasksShim(`"H","\\Backup","N/A","Ready","x","N/A","0","N/A","backup.exe","N/A","N/A","Enabled"`).tools)).detail).toBe("no scheduled sleep task");
  expect(await windowsSleep(schtasksShim("", 1).tools)).toMatchObject({ ok: true, detail: expect.stringContaining("skipped") });
});

test("runPreflight reports a live scheduled sleep as a warning that does not fail preflight", async () => {
  // no script path in the action, so the task is live without touching the real drive root
  const { d, tools } = schtasksShim(`"H","\\NightlyShutdown","N/A","Ready","x","N/A","0","N/A","shutdown.exe /s","N/A","N/A","Enabled"`);
  const { run } = (() => { const s = setup(); return { run: s.ctx.run }; })();
  const keys = ["OMP_NIGHTSHIFT_WINDOWS", "OMP_NIGHTSHIFT_POWERSHELL", "OMP_NIGHTSHIFT_SCHTASKS"];
  const saved = keys.map((k) => process.env[k]);
  try {
    process.env.OMP_NIGHTSHIFT_WINDOWS = "on";
    process.env.OMP_NIGHTSHIFT_POWERSHELL = tools.powershell;
    process.env.OMP_NIGHTSHIFT_SCHTASKS = tools.schtasks;
    const seen: Check[] = [];
    // forge local + tiny preflightTest keep this hermetic; only the check names matter
    await runPreflight({ ...run, preflightTest: "true" }, { ledger: null, logFile: join(d, "p.log"), needs: [], onResult: (c) => seen.push(c) });
    expect(seen.find((c) => c.name === "windows_sleep")).toMatchObject({ ok: true, warn: true });
  } finally {
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
});
