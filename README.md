# omp-nightshift

Unattended overnight agent for [omp](https://github.com/can1357/oh-my-pi). In any repo type
`/skill:overnight <goal>`: the skill plans a backlog of small, test-proven chunks with you, then a detached
systemd user unit works through it (one omp session per chunk, an independent gate, draft PRs) and writes a
morning report. Bun TypeScript, no npm dependencies. The runner delegates delivery to omp: local mode
keeps branches local; GitHub and Graphite modes can push and open draft PRs.

## Requirements

Linux with a running systemd user manager, Bun (tested with 1.4.2), Git, Bash, and the
`systemd-run`, `systemd-inhibit`, `flock`, and `setsid` commands. Install and authenticate
[omp](https://github.com/can1357/oh-my-pi), configure its model roles, and confirm
`omp usage --json` works. GitHub delivery also needs authenticated `gh` and Git remote
access; Graphite delivery needs authenticated `gt` and an initialized Graphite repository.
`notify-send` is optional. macOS and Windows are not supported.

## Install

Clone the source and install the skill (no npm install or package publishing required):

```sh
mkdir -p "$HOME/.local/share" "$HOME/.omp/agent/skills/overnight"
git clone https://github.com/charliemartin0/omp-nightshift.git "$HOME/.local/share/omp-nightshift"
cp "$HOME/.local/share/omp-nightshift/skill/SKILL.md" "$HOME/.omp/agent/skills/overnight/SKILL.md"
bun "$HOME/.local/share/omp-nightshift/src/cli.ts" --help
```

For a different checkout location, export `OMP_NIGHTSHIFT_HOME` to its absolute path
in the environment used to start omp. To update, pull the checkout and copy the skill again.
In a target Git repository, invoke `/skill:overnight <goal>` to plan and approve a run.
Delivery follows that repository's instructions; choose local branches unless you want remote delivery.

## Commands
`bun src/cli.ts <cmd>` (the skill calls these; `/skill:overnight status|stop` wrap the last two):

- `launch <run.json> [--dry-run]` validate, write `overlay.yml`, preflight (prints PASS/FAIL), start the unit
- `run <run.json> [--dry-run]` runner body, started by systemd (dry-run never starts an omp session)
- `status [--repo <path>]` unit state, chunk table, ledger tail, worktrees, report path
- `stop [--repo <path>]` stop the unit; worktrees, branches and PRs are left alone
- `trunk [--repo <path>]` trunk branch (Graphite config, else `origin/HEAD`, else `main`)

`bun test` runs the unit tests from the source checkout. The package remains `private: true`
because installation is from Git, not npm; this does not affect GitHub repository visibility.

## Safety and dry runs

Only run against trusted repositories. Agents and configured shell commands execute with your
user permissions and inherited credentials; worktrees are not a sandbox. Review the backlog,
`setupCommand`, `preflightTest`, provider floors, and delivery mode before launching.

`--dry-run` means **no omp sessions, branches, pushes, or PRs**, not no side effects:
preflight still executes setup and baseline tests, fetches Git refs when needed, creates temporary
worktrees, and writes logs. Chunk dry runs also execute the first chunk's setup command.
`launch --dry-run` still starts a detached systemd unit; `run --dry-run` runs in the foreground.

Run files, raw session logs, prompts, and reports may contain sensitive project data. Keep them
outside tracked files (the skill chooses an ignored directory or a directory under `~/.omp`).
Stop a run with `/skill:overnight stop`; it leaves real worktrees, branches, and PRs intact.

## License

[MIT](LICENSE).

## Run directory
`<repo>/.omp/overnight/<date>/` when git-ignored there, else `~/.omp/overnight/<repoName>/<date>/`:

- `run.json` (written by the skill), `backlog.md`, `overlay.yml` (your modelRoles and fallback chains unchanged; `usageReservePct` from `reservePct`, default 40)
- `ledger.jsonl` (`ledger.dry-run.jsonl`), `report.md` (`report.dry-run.md`)
- `prompts/<id>.md`, `prompts/report.md`
- `sessions/<id>/` omp session dirs
- `logs/<id>-omp-<n>.jsonl` raw stream, `logs/<id>-setup.log`, `logs/<id>-test-<k>.log`, `logs/preflight.log`

Worktrees live outside the repo at `~/.omp/overnight/<repoName>/<date>/wt/<chunk-id>`; the run lock is
`~/.omp/overnight/<repoName>/lock`.

## Quota
7d floors and 7d exhaustion stop the run. When every provider in the build role's fallback chain is below the
reserve (`reservePct`, default 40) on a short window, the runner logs `quota_wait`, sleeps until the earliest
reset + 2 min (re-checking every 10 min), and never past the stop time (`stop_time`). A chunk killed by a
quota/429 error returns to `pending` (at most 3 times) without counting as a failure.

## Modules
Pure libs: `backlog`, `quota`, `watchdog`, `overlay`. Runner: `runner` (loop), `chunk` (setup, agent, resumes),
`gate`, `agent` (omp + watchdog), `preflight`, `stops`, `report`, `prompt`, `dryrun`; plumbing: `proc`, `git`,
`ledger`, `runjson`, `ctx`, `overlayfile`, `launch`, `status`, `cli`.
