# omp-nightshift

Unattended overnight agent for [omp](https://github.com/can1357/oh-my-pi). In any repo type
`/skill:overnight <goal>`: the skill plans a backlog of small, test-proven chunks with you, then a detached
systemd user unit works through it (one omp session per chunk, optionally up to three chunks in parallel, an
independent gate, draft PRs) and writes a morning report. Bun TypeScript, no runtime npm dependencies. The runner
delegates delivery to omp: local mode keeps branches local; GitHub and Graphite modes can push and open draft PRs.

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

`bun test` runs the unit tests from the source checkout; `bun install && bun run typecheck` type-checks `src` and
`test` with the dev-only TypeScript and Bun type packages (running the tool needs neither). The package remains `private: true`
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
- `logs/<id>-omp-<n>.jsonl` raw stream, `logs/<id>-setup.log`, `logs/<id>-test-<k>.log` (`-test-env2-<k>` after a gate environment retry), `logs/preflight.log`
- `logs/<id>-pr-body.md`, `logs/<id>-review.log`, `reviews/<id>.md`

Worktrees live outside the repo at `~/.omp/overnight/<repoName>/<date>/wt/<chunk-id>`; the run lock is
`~/.omp/overnight/<repoName>/lock`.

## Quota
Quota never stops a run: it waits. A provider under its 7d floor (default 7d floors are Anthropic 20%, OpenAI 40%,
others 20%) or 7d-exhausted is unusable but the run carries on while another provider in the build role's fallback
chain is usable. A chain provider is also unusable when `limitReached` or below the reserve (`reservePct`, default 40)
on any window. When every chain provider is unusable, the runner logs `quota_wait` and sleeps until the earliest reset
of any of them, 7d windows included, plus 2 min (re-checking every 10 min). Waiting for a known future reset counts as
progress and does not use up the safety cap (the cap is extended by the time slept); an explicit `stopAt` override is
wall-clock and still ends the run. A window with no reset time, or usage that stays stale after a reset, is re-checked
every 10 min and bounded by the safety cap and the 60 min no-progress limit. Only unreadable usage with no chain
(`quota_unknown`) is a stop. A chunk killed by a quota/429 error returns to `pending` (at most 6 times, pausing 1, 2,
4... up to 10 min between attempts) without counting as a failure, even when the attempts run out.

Free-tier models (`...-free`, `...:free`) are never used, not even as a fallback: they are dropped from every chain in
the generated overlay and from the quota chain, and `launch` rejects a run whose `models` resolve to one.

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
tokens exceed `tokenCap × chunk count`. Two failed attempts in a row stop with `consecutive_failures`. Both failure
limits consume outcomes in dispatch order, not completion order: passed/flaky resets the consecutive streak;
blocked/skipped and quota requeues neither count nor reset it. Identical normalized failures accumulate across passes.
An out-of-order completion holds new admission until earlier attempts finish, so a later pass cannot erase an earlier
failure limit and fast failures cannot escape accounting behind a slow chunk. Retried attempts get a new dispatch position. Quota never stops a run (see Quota).
`status` shows the latest stop reason, finish estimate, safety cap and optional override.

## Parallel chunks

`concurrency` in `run.json` (default 1, max 3) runs that many pending chunks at once, in backlog order. It requires
`prMode: independent`, because stack mode bases each branch on the previous chunk's branch. Every chunk gets its own
branch and worktree. Shared repository mutations use `flock` on `omp-nightshift.lock` in the common Git directory,
so runner planning/fetch/worktree creation/tracking and agent delivery exclude each other across processes and linked
worktrees. The chunk prompt defines `overnight_repo`, a shell wrapper resolving the common directory at runtime:
use it for every `git fetch`, `git pull`, `git push`, and Graphite command, including `gt modify` and `gt submit`.
Never nest the wrapper or hold it around setup, agents, or tests. Local commits on distinct branches remain independent.
The lock is cooperative: commands outside the runner and agents ignoring the wrapper are not protected.
Acquisition waits are bounded: the runner and agent wrapper default to 120 seconds; Git calls account for lock wait
within their command timeout. A busy agent wrapper exits 75 with an explicit diagnostic rather than waiting forever.
Setup commands, agents and gate tests run side by side; choose concurrency above 1 only when they do not share
ports, databases, containers, or fixed output paths.

A global stop condition or runner-level error ends dispatch, then drains running chunks before finalization.
A chunk exception instead marks only that chunk failed (`chunk_error`), records its outcome and continues dispatch
subject to the ordinary failure limits. Self-review and the report run once after draining, including partial launches.
While chunks run, quota waits and potential `maxPrs` exhaustion hold new admission rather than sleeping.

Each additional slot reads fresh quota and requires more headroom: with `N = running + 1`, a configured remaining
threshold `t` becomes `1 - (1 - t) / N` for admission only, for both provider floors and the fallback reserve.
For example, a 40% reserve requires more than 70% remaining for two concurrent chunks and more than 80% for three.
This divides allowable consumption across slots without multiplying a threshold above 100%. If only the stricter
admission check fails, new starts wait for a chunk to finish; the normal one-chunk floors/reserve still determine
whether the run waits for quota reset or stops. Model fallback settings themselves are unchanged.

Once idle, the runner waits out quota windows as before. A quota-requeued chunk reruns in a fresh worktree, never
alongside itself. Environment-blocked chunks are rechecked only when nothing is running. Each chunk-scoped ledger
line is one append tagged with its `chunk`, so interleaved events stay attributable. The finish estimate still assumes
one chunk at a time, so the default safety cap stays conservative.

SIGTERM records both admitted setup chunks (including those waiting for the repository lock) and agent-running
chunks as `stopped`, with distinct phase notes. A real relaunch recovers unmatched setup ownership before preflight:
only an exact, registered worktree with no changed, untracked, or ignored files, on its recorded unchanged base and
branch in the same common Git directory, may be removed; a partial branch-only creation uses compare-and-delete.
Proven cleanup resets the interrupted setup chunk to `pending`, so the next attempt can reclaim its names.
Advanced/dirty, ignored-file-bearing, agent-started, explicitly completed/failed/blocked, unrelated, or unverifiable
resources are retained with a `setup_recovered` explanation. Recovery is idempotent; dry runs never authorize removal
of real resources. Signal stops still skip self-review and report generation. Dry cleanup failures retain the refused
worktree, continue the remaining cleanup, and still produce a runner-error report.

## Host suspend

A sleeping host (Windows/WSL sleep, a closed lid) must not look like a hung agent. The agent watchdog, the setup and
gate test timeouts and quota sleeps all detect a timer that fires 90 s or more late, subtract that gap, and log a
`host_suspend {where, gapSec}` ledger event. The gap is also removed from the safety cap and the no-progress timer;
an explicit `stopAt` stays wall-clock. Watchdog trips now say which limit fired, for example
`watchdog timeout: ran 12 min awake against a 95 min wall-clock limit, 300 min host suspend excluded; 473629 of
3000000 tokens (cap not reached)`, so a timeout is never reported as a token cap.

## Scope sweep

Every child (omp session, setup, each gate test run) starts under `setsid`. When it exits, the runner SIGTERMs, waits
3 s and SIGKILLs whatever is left of its process group and, for agent sessions, setup and gate tests, its session.
That stops orphaned dev servers, headless browsers and `yarn` trees before the next phase, so a stale listener cannot
fail the next gate with "port already in use" or serve another chunk's worktree. Findings are logged as
`sweep {phase, found, comms}` ledger events (and `swept` on `omp_exit`). Only processes in the child's own group/session
are touched; processes that call `setsid` themselves, and everything unrelated, are left alone. Transient systemd scopes
were rejected because a scope outlives the unit if the runner crashes.

## Keep awake (Windows hosts)

systemd inhibitors only hold locks inside WSL; Windows can still sleep and freeze the VM. Under WSL the runner starts
a `powershell.exe` helper (`-EncodedCommand`, no admin needed) that calls
`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED)` for as long as the runner
touches `<runDir>/.keepawake` (it exits by itself if the lease goes stale for 2 min or the runner dies). Real runs log
`keepawake {ok, detail}`; a failed helper is a warning, never a stop. `powershell.exe` and `schtasks.exe` are found on
PATH or in `/mnt/c/Windows/System32`; `OMP_NIGHTSHIFT_POWERSHELL` / `OMP_NIGHTSHIFT_SCHTASKS` override them and
`OMP_NIGHTSHIFT_WINDOWS=off` disables everything Windows-specific.

An explicit sleep command beats an execution-state request, so preflight also runs `windows_sleep`: it lists enabled
non-Microsoft scheduled tasks whose action sleeps, suspends or hibernates the PC. A task whose script no longer exists
is reported as inert; a live one is a warning (the launch is not blocked) with the exact
`Disable-ScheduledTask -TaskName '<name>'` fix (set `OMP_NIGHTSHIFT_ALLOW_SCHEDULED_SLEEP=1` to silence it).

## Preflight

Global checks cover power, a clean main checkout, `windows_sleep` (WSL only, warning only), remote/forge access (including `gh api user`) and the
baseline test in a disposable `_preflight` worktree. A global failure stops the run. Tool checks run only
for pending chunks that need them: `docker ps`, a real Chrome/Chromium headless DOM render, a configured
Playwright MCP initialize/navigate call, and `dotnet restore` in the same worktree after the baseline passes.
Restore uses the repository's own NuGetAudit settings; when `setupCommand` already includes
`dotnet restore`, that global setup/baseline covers it instead. No NuGetAudit overrides are added.
Conventional `cd <directory> && dotnet test <target>` commands retain their working directory for restore.

More tool checks run only when a pending chunk needs them, and each failure names its fix:

- `playwright`: Playwright's browser cache (`PLAYWRIGHT_BROWSERS_PATH` or `~/.cache/ms-playwright`) holds the
  Chromium revision pinned by the repo's installed `playwright-core` (repo root or one level down), or any Chromium
  when `node_modules` isn't installed in the main checkout
- `lsp`: `typescript-language-server` on `PATH`
- `jev`: `TYPESAFE_API_KEY` in the environment or in `~/.config/typesafe/env`
- `apicompat`: `apicompat` on `PATH` or listed by `dotnet tool list` (local manifest or `-g`)

A global `disk` check needs 10 GB free on the worktree volume (`OMP_NIGHTSHIFT_MIN_FREE_GB` overrides this), and it warns
below 25 GB. Pending TypeScript chunks without a language server get a launch warning unless they declare `needs: lsp`,
which blocks them instead.

After the checks, launch prints one `preflight: N problem(s)` block listing each failed check, the chunks it blocks
and how to fix it. `launch --strict` refuses to start while any check fails. Without it, a missing tool only blocks
the chunks that need it, as before.

An optional backlog line `- needs: browser, docker, dotnet, playwright, lsp, jev, apicompat` declares requirements. Test commands
mentioning dotnet, Docker/TestContainers, Playwright/Cypress or apicompat infer the obvious needs (Playwright adds both
`browser` and `playwright`), and a test, scope or done-when mentioning Jev/TypeSafe adds `jev`. Frontend work
whose rules require UI smoke/screenshots must explicitly declare `browser` when its test command does
not mention it. A need-scoped failure blocks only affected pending chunks, with an `env: preflight …`
note. Each failing need check gets one retry after 15 s; no browsers are installed, permissions changed,
services configured or MCP config edited. Environment rechecks skip power/git-clean checks.
Rechecks do not start at the effective deadline margin; subprocess timeouts and retry sleeps are bounded
by the remaining deadline.

## Plan lint

`launch` (and `bun src/cli.ts lint <backlog.md>`, exit 3 when anything is flagged) lists pending `prod-code: no`
chunks that look like they'll need production changes they aren't allowed to make, so the operator can approve them
before the night starts instead of finding them blocked in the morning. A chunk is flagged when its scope or done-when:

- names a non-test file (not a `*.test.*` or `*.spec.*` file, a `tests/`, `__tests__/`, `e2e/` or fixtures path, `*Tests.cs`, a
  `*.Tests` project or a test-runner config), or
- uses phrases such as "production fix", "aria-label", "seed", "migration", "endpoint", "tsconfig" or "duplicate export".

A chunk is also flagged when its proof command is only a lint, type or analyzer check with no test run. To approve one, set
`prod-code: yes`, or add `- allow: <globs>` to permit just those production paths. `allow` is passed to the agent
as the only production files it may change, and it silences the phrase and proof-command heuristics for that chunk.

## Gate strategy

`gate` in `run.json` is optional and defaults to `{ "strategy": "full", "repeat": 3 }`, the original behaviour: the
chunk test runs three times, all passing is `passed`, exactly one failure is `flaky`, more is a failure.
`repeat` (1-10) sets how many times the flake-detection runs happen.

`"strategy": "affected"` runs only the tests the chunk touched `repeat` times for flake detection, then the full chunk
test once as the broad check. A failed broad run is retried once, and passing on that retry counts as `flaky`. One failed
affected run is also `flaky`, and anything more fails. An affected run whose runner reports "No tests found" passes.
The affected command is:

- the chunk's optional `- affected-test:` backlog line, with `{base}` replaced by the chunk's start commit and
  `{files}` by its changed files, shell-quoted (for example `yarn test:e2e:affected --base {base}`), or
- derived from a single-command `test` (optionally `cd <dir> && …`): Playwright gets `--only-changed=<base>`,
  vitest `--changed <base>`, jest `--changedSince=<base>`, and `dotnet test` a `--filter` over the changed
  `*Test(s).cs` classes.

When nothing can be derived (a compound command, an existing filter, no changed test class), that chunk falls back to
the full strategy. Each decision is logged as `gate_strategy {strategy, affected|fallback, changedFiles}`.

## Gate environment retry

Each gate runs its planned test runs (see Gate strategy). When every failed run carries an environmental signature (a port already
in use such as `EADDRINUSE` or Playwright's "http://localhost:9999 is already used", `ENOSPC`, an out-of-memory kill or
exit 137), the gate does not wake the agent. It stops listeners on the named ports only when their working directory is
inside this run's `worktreeRoot` (its own leftover dev servers; anything else is reported and left alone), waits 2 s and
re-runs the three tests once. Evidence is logged as `gate_env_retry {signature, freed, foreign}`; the retry's logs are
`logs/<id>-test-env2-<k>.log` next to the first attempt's `logs/<id>-test-<k>.log`. If the retry still fails
environmentally, and the tests were the only failing check, the chunk is `blocked` with an `env: gate tests: ...` note
(its branch stays committed) so it joins the normal environment retry instead of burning fix-resume tokens or inviting
test-config hacks such as `reuseExistingServer: true`. A real test failure, a mix of environmental and real failures,
or a timeout is never retried this way. `disk_full` is classified as environmental but not retried.

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
Flaky attribution reads only the current test invocation's appended log, not failures from earlier attempts.

The report event records `attempts`: 0 for deterministic dry runs, 1/2 for a valid model attempt, 3 for
fallback. Existing reports are renamed to `.bak` before generation (replacing an older backup), including
dry-run reports; relaunches never silently discard the previous report. Action-needed notifications are
unchanged.

## Self-review

`selfReview` defaults to false. When enabled, every non-signal launch (including partial runs stopped by failures
or runner errors) makes one end-of-run pass. The report model asks exactly one reviewer subagent per successful
draft PR from the current launch for read-only P0–P3 findings
(≤200 words). Findings go to `reviews/<id>.md` and the report, never to PR comments/reviews, pushes or
ready/approval actions. Local delivery is skipped, and the pass stops without waiting when quota or
deadline headroom is unavailable. It does not fix code.


## Modules
Pure libs: `backlog`, `quota`, `watchdog`, `overlay`, `estimate` (history loading at the boundary). Runner:
`runner` (loop), `chunk` (setup, agent, resumes), `gate`, `agent` (omp + watchdog), `preflight`, `stops`,
`report`, `review`, `prompt`, `dryrun`, `setup` (interrupted ownership); plumbing: `proc`, `git`, `repolock`, `ledger`,
`runjson`, `ctx`, `overlayfile`, `launch`, `status`, `cli`.
