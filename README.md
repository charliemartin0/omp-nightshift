# omp-nightshift

Unattended overnight agent for [omp](https://github.com/can1357/oh-my-pi). In any repo type
`/skill:overnight <goal>`: the skill plans a backlog of small, test-proven chunks with you, then a detached
systemd user unit works through it (one omp session per chunk, an independent gate, draft PRs) and writes a
morning report. Bun TypeScript, no npm dependencies. Never pushes anywhere itself.

## Commands
`bun src/cli.ts <cmd>` (the skill calls these; `/skill:overnight status|stop` wrap the last two):

- `launch <run.json> [--dry-run]` validate, write `overlay.yml`, preflight (prints PASS/FAIL), start the unit
- `run <run.json> [--dry-run]` runner body, started by systemd (dry-run never starts an omp session)
- `status [--repo <path>]` unit state, chunk table, ledger tail, worktrees, report path
- `stop [--repo <path>]` stop the unit; worktrees, branches and PRs are left alone
- `trunk [--repo <path>]` trunk branch (Graphite config, else `origin/HEAD`, else `main`)

`bun test` runs the unit tests. Install the skill with `cp skill/SKILL.md ~/.omp/agent/skills/overnight/SKILL.md`.

## Run directory
`<repo>/.omp/overnight/<date>/` when git-ignored there, else `~/.omp/overnight/<repoName>/<date>/`:

- `run.json` (written by the skill), `backlog.md`, `overlay.yml` (Opus/Cursor removed from roles and fallbacks)
- `ledger.jsonl` (`ledger.dry-run.jsonl`), `report.md` (`report.dry-run.md`)
- `prompts/<id>.md`, `prompts/report.md`
- `sessions/<id>/` omp session dirs
- `logs/<id>-omp-<n>.jsonl` raw stream, `logs/<id>-setup.log`, `logs/<id>-test-<k>.log`, `logs/preflight.log`

Worktrees live outside the repo at `~/.omp/overnight/<repoName>/<date>/wt/<chunk-id>`; the run lock is
`~/.omp/overnight/<repoName>/lock`.

## Modules
Pure libs: `backlog`, `quota`, `watchdog`, `overlay`. Runner: `runner` (loop), `chunk` (setup, agent, resumes),
`gate`, `agent` (omp + watchdog), `preflight`, `stops`, `report`, `prompt`, `dryrun`; plumbing: `proc`, `git`,
`ledger`, `runjson`, `ctx`, `overlayfile`, `launch`, `status`, `cli`.
