import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseBacklog } from "./backlog";
import { writeOverlay } from "./overlayfile";
import { runPreflight } from "./preflight";
import { type SpawnResult, sleep, spawnGroup } from "./proc";
import { type RunJson, loadRunJson } from "./runjson";

const SETTLE_MS = 5000;
const LID_WARNING =
  "WARNING: polkit denied the lid-switch inhibitor; keep the lid open (or on AC with HandleLidSwitchExternalPower=ignore)";

const sh = (argv: string[]): Promise<SpawnResult> => spawnGroup(argv, { timeoutMs: 60_000 });

function systemdRunArgv(run: RunJson, lock: string, what: string, runJson: string, cliPath: string, dryRun: boolean): string[] {
  const sshSock = process.env.SSH_AUTH_SOCK;
  return [
    "systemd-run", "--user", `--unit=${run.unit}`, "--collect",
    `--description=omp overnight ${run.repoName} ${run.date}`,
    `--working-directory=${run.repo}`,
    `--setenv=PATH=${process.env.PATH ?? ""}`,
    `--setenv=HOME=${process.env.HOME ?? homedir()}`,
    ...(sshSock ? [`--setenv=SSH_AUTH_SOCK=${sshSock}`] : []),
    ...(process.env.OMP_OVERNIGHT_POWER_DIR ? [`--setenv=OMP_OVERNIGHT_POWER_DIR=${process.env.OMP_OVERNIGHT_POWER_DIR}`] : []),
    "--",
    "systemd-inhibit", `--what=${what}`, "--who=omp-overnight", `--why=omp overnight ${run.repoName}`, "--mode=block",
    "flock", "-n", "-E", "75", lock, process.execPath, cliPath, "run", runJson, ...(dryRun ? ["--dry-run"] : []),
  ];
}

/** Start the unit and verify (after SETTLE_MS) that it is running with its inhibitor, or finished cleanly. */
async function startAndVerify(argv: string[], unit: string): Promise<{ ok: boolean; denied: boolean; message: string }> {
  const since = Math.floor(Date.now() / 1000) - 1; // journal of this attempt only, not earlier same-day invocations
  const start = await sh(argv);
  if (start.code !== 0) return { ok: false, denied: false, message: `systemd-run failed: ${start.stderr.trim()}` };
  await sleep(SETTLE_MS);
  const state = (await sh(["systemctl", "--user", "is-active", unit])).stdout.trim();
  const journal = (await sh(["journalctl", "--user", "-u", unit, `--since=@${since}`, "--no-pager", "-o", "cat", "-n", "200"])).stdout;
  const tail = journal.split("\n").slice(-25).join("\n");
  if (state === "active") {
    const inhibitors = (await sh(["systemd-inhibit", "--list", "--no-pager"])).stdout;
    if (inhibitors.includes("omp-overnight")) return { ok: true, denied: false, message: `unit ${unit} is active` };
    await sh(["systemctl", "--user", "stop", unit]); // never leave an unprotected run behind
    return { ok: false, denied: false, message: `unit ${unit} is active but holds no omp-overnight inhibitor; stopped it\n${tail}` };
  }
  const failed = /Failed with result/i.test(journal);
  if (!failed && journal.includes("run_start")) {
    return { ok: true, denied: false, message: `unit ${unit} already finished (state ${state}); see journalctl --user -u ${unit}` };
  }
  return {
    ok: false,
    denied: /Access denied|Permission denied/i.test(journal),
    message: `unit ${unit} is ${state} and did not run cleanly\n${tail}`,
  };
}

/** Validate, write overlay, run preflight synchronously, then start the detached systemd unit. Exit code. */
export async function launch(runJsonPath: string, dryRun: boolean, cliPath: string): Promise<number> {
  const runJson = resolve(runJsonPath);
  const run = loadRunJson(runJson);
  parseBacklog(readFileSync(join(run.runDir, "backlog.md"), "utf8")); // fail fast on a bad backlog

  // Lock first: a second launch must not run its preflight (which recreates <worktreeRoot>/_preflight)
  // while another run owns this repo.
  const lock = join(homedir(), ".omp/overnight", run.repoName, "lock");
  mkdirSync(dirname(lock), { recursive: true });
  if ((await sh(["flock", "-n", lock, "true"])).code !== 0) {
    console.error(`another overnight run holds ${lock}`);
    return 1;
  }

  console.log(`overlay: ${(await writeOverlay(run)).path}`);
  const checks = await runPreflight(run, {
    ledger: null,
    logFile: join(run.runDir, "logs", "preflight.log"),
    onResult: (c) => console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`),
  });
  if (checks.some((c) => !c.ok)) return 1;

  let res = await startAndVerify(systemdRunArgv(run, lock, "sleep:idle:handle-lid-switch", runJson, cliPath, dryRun), run.unit);
  if (!res.ok && res.denied) {
    await sh(["systemctl", "--user", "reset-failed", run.unit]);
    console.log(LID_WARNING);
    res = await startAndVerify(systemdRunArgv(run, lock, "sleep:idle", runJson, cliPath, dryRun), run.unit);
  }
  if (!res.ok) {
    console.error(res.message);
    return 1;
  }
  console.log(res.message);
  console.log(`watch: journalctl --user -fu ${run.unit}`);
  console.log("status: /skill:overnight status");
  console.log("stop: /skill:overnight stop");
  return 0;
}
