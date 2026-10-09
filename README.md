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

- `launch <run.json> [--dry-run] [--retry-blocked]` validate, write `overlay.yml`, preflight (prints PASS/FAIL/WARN), optionally reset blocked chunks, start the unit
- `run <run.json> [--dry-run]` runner body, started by systemd (dry-run never starts an omp session)
- `status [--repo <path>]` unit state, chunk table, ledger tail, worktrees, report path
- `stop [--repo <path>]` stop the unit; worktrees, branches and PRs are left alone
- `trunk [--repo <path>]` trunk branch (Graphite config, else `origin/HEAD`, else `main`)
- `estimate <backlog.md>` pending-chunk estimate from history: median/p90 finish, expected quota waits, recommended safety cap

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
- `ledger.jsonl` (`ledger.dry-run.jsonl`), `report.md` (`report.dry-run.md`), `report.md.bak` (`report.dry-run.md.bak`)
- `prompts/<id>.md`, `prompts/report.md`, `prompts/<id>-review.md`
- `sessions/<id>/` omp session dirs
- `logs/<id>-omp-<n>.jsonl` raw stream, `logs/<id>-setup.log`, `logs/<id>-test-<k>.log`, `logs/preflight.log`
- `logs/<id>-pr-body.md`, `logs/<id>-review.log`, `reviews/<id>.md`

Worktrees live outside the repo at `~/.omp/overnight/<repoName>/<date>/wt/<chunk-id>`; the run lock is
`~/.omp/overnight/<repoName>/lock`.

## Quota
A provider under its 7d floor (or 7d-exhausted) is unusable but does not stop the run while another provider in the
build role's fallback chain is usable. A chain provider is also unusable when `limitReached` or below the reserve
(`reservePct`, default 40) on any window. When every chain provider is unusable and one recovers on a short window,
the runner logs `quota_wait`, sleeps until the earliest reset + 2 min (re-checking every 10 min), and never past the
effective deadline (the earlier of the safety cap and optional `stopAt` override). If none can recover (7d only) the run stops with `quota_floor` / `quota_limit_reached`. A
chunk killed by a quota/429 error returns to `pending` (at most 3 times) without counting as a failure.

## Stop and safety cap

Finishing early is normal: a completed backlog stops with `finished`. `stopAt` is an optional local
HH:MM override, not a required overnight deadline. The safety cap defaults to max(2× the p90 estimate,
2h), rounded up to the hour; `safetyCap` can explicitly set a duration such as `8h`. It is fixed at launch,
while `estimate` ledger events refresh the expected median/p90 finish after preflight and every chunk
outcome. Type samples need at least three runs; otherwise the estimate uses pooled samples, then
30m/60m defaults. Historical quota waits are averaged per completed chunk.

The run stops within 20 min of the effective deadline with `safety_cap` or `stopAt`. It also stops with
`safety_cap` after 60 min without a chunk finishing or a real future-reset quota sleep (stale reset rechecks
are not progress), after three identical normalised failure notes (chunk ids/digits removed), or when run
tokens exceed `tokenCap × chunk count`. Existing max-PR, consecutive-failure and quota limits still apply.
`status` shows the latest stop reason, finish estimate, safety cap and optional override.

## Preflight

Global checks cover power, a clean main checkout, remote/forge access (including `gh api user`) and the
baseline test in a disposable `_preflight` worktree. A global failure stops the run. Tool checks run only
for pending chunks that need them: `docker ps`, a real Chrome/Chromium headless DOM render, a configured
Playwright MCP initialize/navigate call, and `dotnet restore` in the same worktree after the baseline passes.
Restore uses the repository's own NuGetAudit settings; when `setupCommand` already includes
`dotnet restore`, that global setup/baseline covers it instead. No NuGetAudit overrides are added.

An optional backlog line `- needs: browser, docker, dotnet` declares requirements. Test commands
mentioning dotnet, Docker/TestContainers or Playwright/Cypress infer the obvious needs. Frontend work
whose rules require UI smoke/screenshots must explicitly declare `browser` when its test command does
not mention it. A need-scoped failure blocks only affected pending chunks, with an `env: preflight …`
note. Each failing need check gets one retry after 15 s; no browsers are installed, permissions changed,
services configured or MCP config edited. Environment rechecks skip power/git-clean checks.

## Blocked chunks

Agents distinguish environment problems (`BLOCKED: env: <reason>`) from human gates such as missing
secrets or product decisions (`BLOCKED: <reason>`). Older tool/browser/service failure notes also use a
keyword classifier; a human note mentioning a tool may therefore get one bounded retry. Fetch/setup
failures are environment blocks; worktree/Graphite tracking failures remain failed outcomes.

After pending work is exhausted, environment-blocked chunks (including earlier launches' leftovers)
get one preflight recheck and automatic retry per runner process. Failed chunks and human gates are not
automatically retried. After fixing a remaining block, run:

```sh
bun src/cli.ts launch /absolute/run-dir/run.json --retry-blocked
```

This atomically resets every blocked chunk to pending; with `--dry-run` it only prints the reset count.

## Report

Reports cover the whole day's ledger across relaunches. Blocked chunks and the relaunch command are
always first. The model writes only the narrative headings, with PR links under “What went well”.
One invalid attempt gets a smaller facts-only retry; if both fail, a deterministic fallback includes PR
states, failed/blocked chunks, quota waits and stop details. Flaky test names/messages, per-chunk
runtime/tokens and launch totals are always added by the runner, along with any self-review findings.
The flaky gate also annotates the draft PR body best-effort without changing the gate result.

The report event records `attempts`: 0 for deterministic dry runs, 1/2 for a valid model attempt, 3 for
fallback. Existing reports are renamed to `.bak` before generation (replacing an older backup), including
dry-run reports; relaunches never silently discard the previous report. Action-needed notifications are
unchanged.

## Self-review

`selfReview` defaults to false. When enabled, after `finished` or `max_prs` the report model asks exactly
one reviewer subagent per successful draft PR from the current launch for read-only P0–P3 findings
(≤200 words). Findings go to `reviews/<id>.md` and the report, never to PR comments/reviews, pushes or
ready/approval actions. Local delivery is skipped, and the pass stops without waiting when quota or
deadline headroom is unavailable. It does not fix code.


## Modules
Pure libs: `backlog`, `quota`, `watchdog`, `overlay`, `estimate` (history loading at the boundary). Runner:
`runner` (loop), `chunk` (setup, agent, resumes), `gate`, `agent` (omp + watchdog), `preflight`, `stops`,
`report`, `review`, `prompt`, `dryrun`; plumbing: `proc`, `git`, `ledger`, `runjson`, `ctx`, `overlayfile`,
`launch`, `status`, `cli`.
