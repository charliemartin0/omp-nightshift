#!/usr/bin/env bun
import { launch } from "./launch";
import { resolveTrunk } from "./git";
import { errMsg, shutdown } from "./proc";
import { runMain } from "./runner";
import { resolveRepo, statusText, stopRun } from "./status";

const USAGE = `omp-overnight: unattended overnight runner

Usage: bun cli.ts <command>
  launch <run.json> [--dry-run]   validate, preflight, start the systemd user unit
  run <run.json> [--dry-run]      runner body (started by systemd; --dry-run never starts an omp session)
  status [--repo <path>]          latest run: unit state, chunks, ledger tail, worktrees, report
  stop [--repo <path>]            stop the unit (worktrees, branches and PRs are left alone), then status
  trunk [--repo <path>]           print the trunk branch (Graphite config, origin/HEAD, else main)
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args: string[]): Promise<number> {
  const [cmd, ...rest] = args;
  const dryRun = rest.includes("--dry-run");
  const positional = rest.find((a) => !a.startsWith("--"));
  switch (cmd) {
    case "launch":
    case "run": {
      if (!positional) throw new Error(`${cmd}: missing <run.json>`);
      if (cmd === "run") return runMain(positional, dryRun);
      process.on("SIGINT", () => void shutdown().then(() => process.exit(130)));
      return launch(positional, dryRun, import.meta.path);
    }
    case "status":
      console.log(await statusText(await resolveRepo(flag(rest, "--repo"))));
      return 0;
    case "stop":
      console.log(await stopRun(await resolveRepo(flag(rest, "--repo"))));
      return 0;
    case "trunk":
      console.log(await resolveTrunk(await resolveRepo(flag(rest, "--repo"))));
      return 0;
    case undefined:
    case "-h":
    case "--help":
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

try {
  process.exit(await main(process.argv.slice(2)));
} catch (e) {
  console.error(`error: ${errMsg(e)}`);
  process.exit(1);
}
