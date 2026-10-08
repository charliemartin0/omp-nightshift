---
name: overnight
description: "Use for /skill:overnight <goal>, /skill:overnight status, /skill:overnight stop: plan a backlog of small test-proven chunks in the current repo, ask the user for limits, then launch the unattended omp-nightshift runner as a systemd user unit."
---

# Overnight

Plan interactively, launch detached, end the turn. CLI: `bun "${OMP_NIGHTSHIFT_HOME:-$HOME/.local/share/omp-nightshift}/src/cli.ts"` (below: `CLI`). Resolve this installation path before launching; if it is missing, follow the repository README installation instructions. Ask every question with the `ask` tool, one batched call per step, recommended option first. You never run `CLI run` and never do the chunk work yourself; the runner does.

## Dispatch

Arg is the text after `/skill:overnight`.

- `status`: run `CLI status`, show the output, stop.
- `stop`: run `CLI stop`, show the output, stop.
- Empty: `ask` for the goal.
- Anything else: it is the goal. Continue.

## Step 0 Classify

- `repo` = `git rev-parse --show-toplevel`. `repoName` = basename with every char outside `[A-Za-z0-9-]` replaced by `-`.
- `date` = `date +%F`. `unit` = `omp-overnight-<repoName>-<date>`.
- Origin = `git remote get-url origin`. Respect the repo's instructions for delivery: if they require Graphite, select `graphite` and treat missing authentication or repository initialization as a blocker, never fall back to another forge. Otherwise a GitHub remote -> `github` or `local`, decided in Step 3; no or other remote -> `local`. `remote` = `origin` (use the only remote if there is none named origin).
- `trunk`: run `CLI trunk` (Graphite `.trunk` from `<git-common-dir>/.graphite_repo_config`, else `origin/HEAD` minus `origin/`, else `main`).
- `runDir`: `<repo>/.omp/overnight/<date>/` if `git -C <repo> check-ignore -q .omp/overnight/<date>/backlog.md` succeeds, else `~/.omp/overnight/<repoName>/<date>/`. Never edit the repo's `.gitignore`.
- `worktreeRoot` = `~/.omp/overnight/<repoName>/<date>/wt` (always outside the repo). Expand `~` to absolute paths. `mkdir -p` the run dir.

## Step 1 Read & backlog

Read repo `AGENTS.md`/`CLAUDE.md`, CI configs (`.github/workflows/*`), test setup (package.json scripts, playwright/jest/vitest configs, `*.csproj` test projects) and existing tests.

Produce 3-12 chunks:

- Each is at most ~60 min of agent work.
- Independent: in `independent` PR mode no chunk relies on another chunk's files.
- Tests only, unless the goal requires production code (`prod-code: yes` only then).
- `test` is an exact shell command, run from the repo root, that targets only that chunk's tests.

Also pick `setupCommand` (dependency install for a fresh worktree, e.g. `npm ci`, `dotnet restore`; empty if none) and `preflightTest` (an existing passing suite or harness smoke such as `npx playwright test --list`).

Write `<runDir>/backlog.md` in exactly this format (id regex `^[a-z0-9][a-z0-9-]{0,40}$`; `test` may be wrapped in one backtick pair):

```md
# Overnight backlog
goal: <goal text>
repo: <abs repo path>

## <chunk-id>
- status: pending
- scope: <one line>
- done-when: <one line>
- test: <exact shell command, run from repo root; may be wrapped in one pair of backticks>
- prod-code: no
- note:
```

## Step 2 Blockers

Check and list:

- Required tooling missing or deliberately removed (`git log --oneline -i --grep=<tool>`, `git log --diff-filter=D --name-only -- '*<tool>*'`, package manifests).
- Services the tests need (DBs, docker compose, local stack, external APIs).
- Secrets/env vars (`.env.example` vs environment).
- Anything needing another account.
- Dirty main checkout; running on battery.

For each blocker, one batched `ask` with options: `Skip affected chunks` (recommended: set those chunks `status: skipped`, `note: blocked: <reason>`), `Proceed anyway`, `Abort`. Abort: stop without launching. No blockers: skip the ask.

## Step 3 Limits

One batched `ask`; the first option is the recommended default.

- Stop time: `07:00` / `06:00` / `08:00`.
- Max PRs: `4` / `2` / `6`.
- Quota floors (7d remaining): `Anthropic 7d >=25%, OpenAI >=50%, never Cursor` / `Anthropic >=40%, OpenAI >=60%` / `Anthropic >=15%, OpenAI >=30%`. Only include providers present in `omp usage --json`. Cursor is never a floor or fallback. Provider ids: `anthropic`, `openai-codex`.
- Models: `plan @default, build @smol` / `plan @default, build @default` / `plan @smol, build @smol`.
- PR mode: `Independent drafts off <trunk>` / `One stack`.
- Only for a non-work GitHub remote, delivery: `Local branches only` (recommended; forge `local`) / `Push + gh draft PR` (forge `github`).

## Step 4 Launch

Write `<runDir>/run.json` (unknown keys are rejected; `stopAt` is `HH:MM` local, the runner resolves it to the next occurrence):

```json
{ "version": 1, "repo": "/abs", "repoName": "x", "date": "YYYY-MM-DD", "goal": "...",
  "runDir": "/abs", "worktreeRoot": "/abs", "unit": "omp-overnight-<repoName>-<date>",
  "remote": "origin", "trunk": "main", "forge": "graphite|github|local", "prMode": "independent|stack",
  "stopAt": "HH:MM", "maxPrs": 4, "floors": { "anthropic": 0.25, "openai-codex": 0.5 },
  "models": { "plan": "@default", "build": "@smol", "report": "@smol" },
  "setupCommand": "", "preflightTest": "<cmd>",
  "limits": { "maxTime": "90m", "resumeMaxTime": "45m", "stallMinutes": 10, "tokenCap": 3000000, "testTimeoutMinutes": 20 } }
```

Use the limit defaults shown unless the user asked otherwise; `models.report` is `@smol`.

Show a summary: goal, forge, trunk, PR mode, stop time, max PRs, floors, models, chunk table (id, test, status), run dir. Then run `CLI launch <runDir>/run.json`.

- Preflight FAIL: show the failing checks, `ask` `Fix and retry` / `Abort`.
- Success: print the unit name and the watch/stop commands the CLI printed (`journalctl --user -fu <unit>`, `/skill:overnight status`, `/skill:overnight stop`), tell the user the session can be closed, end the turn.

## Rules

- Never run `CLI run`. Never run chunk work, `gt`, `gh pr`, or push from this session.
- Never remove worktrees, branches, or PRs.
