#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { parseBacklog } from "./backlog";
import { estimateText, loadHistory } from "./estimate";
import { launch } from "./launch";
import { lintBacklog, lintText } from "./planlint";
import { resolveTrunk } from "./git";
import { errMsg, shutdown } from "./proc";
import { runMain } from "./runner";
import { resolveRepo, statusText, stopRun } from "./status";

const USAGE = `omp-overnight: unattended overnight runner

Usage: bun cli.ts <command>
  launch <run.json> [--dry-run] [--retry-blocked] [--strict]   validate, plan-lint, preflight, start the systemd user unit
                                  (--strict: refuse to launch when any tool check fails instead of blocking those chunks)
  lint <backlog.md>               flag prod-code: no chunks that look like they need production-code approval
  run <run.json> [--dry-run]      runner body (started by systemd; --dry-run never starts an omp session)
  status [--repo <path>]          latest run: unit state, chunks, ledger tail, worktrees, report
  stop [--repo <path>]            stop the unit (worktrees, branches and PRs are left alone), then status
  trunk [--repo <path>]           print the trunk branch (Graphite config, origin/HEAD, else main)
  estimate <backlog.md>           pending-chunk finish estimate and recommended safety cap
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args: string[]): Promise<number> {
  const [cmd, ...rest] = args;
  const dryRun = rest.includes("--dry-run");
  if (rest.includes("--retry-blocked") && cmd !== "launch") throw new Error("--retry-blocked is only valid for launch");
  if (rest.includes("--strict") && cmd !== "launch") throw new Error("--strict is only valid for launch");
  const positional = rest.find((a) => !a.startsWith("--"));
  switch (cmd) {
    case "launch":
    case "run": {
      if (!positional) throw new Error(`${cmd}: missing <run.json>`);
      if (cmd === "run") return runMain(positional, dryRun);
      process.on("SIGINT", () => void shutdown().then(() => process.exit(130)));
      return launch(positional, dryRun, import.meta.path, rest.includes("--retry-blocked"), rest.includes("--strict"));
    }
    case "lint": {
      if (!positional) throw new Error("lint: missing <backlog.md>");
      const findings = lintBacklog(parseBacklog(readFileSync(positional, "utf8")).chunks);
      console.log(lintText(findings));
      return findings.length ? 3 : 0;
    }
    case "estimate":
      if (!positional) throw new Error("estimate: missing <backlog.md>");
      console.log(estimateText(loadHistory(), parseBacklog(readFileSync(positional, "utf8")).chunks.filter((c) => c.status === "pending").map((c) => c.id), Date.now()));
      return 0;
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
