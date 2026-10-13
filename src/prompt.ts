import type { Chunk } from "./backlog";
import type { RunJson } from "./runjson";
import { REPO_LOCK_WRAPPER } from "./repolock";

export interface PromptCtx {
  /** worktree path */
  wt: string;
  branch: string;
  /** git ref the branch was created from */
  base: string;
  /** expected PR base branch (trunk, or previous branch in stack mode) */
  prBase: string;
}

export const STALL_RESUME_MESSAGE =
  "You were stalled and restarted by the overnight runner. Continue the original task from where you left off, following all original instructions.";

export function fixResumeMessage(failures: string[]): string {
  return `The overnight runner's independent gate failed:\n${failures.map((f) => `- ${f}`).join("\n")}\nFix only these problems, keep to the chunk scope, commit, and update the draft PR. Do not ask questions.`;
}

/** One shell argument, including embedded quotes and whitespace. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function forgeBlock(run: RunJson, ctx: PromptCtx): string {
  switch (run.forge) {
    case "graphite":
      return `Graphite repo. Stage explicit paths with git add, commit with overnight_repo gt modify --no-interactive -c -m "<msg>" (the branch is already tracked on ${ctx.prBase}; do not run gt create or gt checkout). Submit with overnight_repo gt submit --draft --no-interactive. Never gh pr create, never git push, never --force, never --publish, never gh pr ready (except gh pr ready --undo).`;
    case "github":
      return `Commit with git commit. Push with overnight_repo git push -u ${shellQuote(run.remote)} ${shellQuote(ctx.branch)} (never --force). Open the PR with gh pr create --draft --base ${shellQuote(ctx.prBase)} --head ${shellQuote(ctx.branch)} --fill. Never mark it ready.`;
    case "local":
      return "Commit with git commit. Do not push and do not open a PR.";
  }
}

export function renderChunkPrompt(run: RunJson, chunk: Chunk, ctx: PromptCtx): string {
  const prod = chunk.prodCode
    ? "Production code changes are allowed only as the chunk scope requires."
    : "Do NOT change production code; only add or fix tests and test fixtures/config.";
  const parallel = run.concurrency > 1
    ? `\nOther overnight chunks run at the same time in their own worktrees: only change files inside ${ctx.wt}, and never touch another worktree or branch.`
    : "";
  return `You are running UNATTENDED overnight for the operator. Nobody will answer questions.
- Never use the ask tool, never wait for input, never pause for confirmation.
- Environment problem (a tool, browser, MCP server, service or permission that is missing or fails to start): write one line \`BLOCKED: env: <reason>\` to ${ctx.wt}/.overnight-status and stop immediately. Do not commit that file.
- Human gate (missing secret, another account, ambiguous product decision, destructive or force-push step): write one line \`BLOCKED: <reason>\` to ${ctx.wt}/.overnight-status and stop immediately. Do not commit that file.

Goal of the night: ${run.goal}
Your chunk: ${chunk.id}
Scope: ${chunk.scope}
Done when: ${chunk.doneWhen}
Proof command (must pass from the worktree root): ${chunk.test}
Production code: ${prod}

Workspace: ${ctx.wt} (git worktree). Branch \`${ctx.branch}\` already exists and is checked out, based on \`${ctx.base}\`. Stay on it. Never check out ${run.trunk}.${parallel}
Shared-repository mutations must exclude the runner's setup steps. Define this shell-safe wrapper in the same shell as each command, from your worktree:
\`\`\`sh
${REPO_LOCK_WRAPPER}
\`\`\`
Use \`overnight_repo git fetch ...\`, \`overnight_repo git pull ...\`, \`overnight_repo git push ...\`, and \`overnight_repo gt ...\` for every fetch/pull/push or Graphite command. Never nest \`overnight_repo\`, and do not hold it around agent execution, setup, proof tests, or other long work.
Follow the repo AGENTS.md and ~/.omp/agent/AGENTS.md for commits and PRs, with these specifics:
${forgeBlock(run, ctx)}
Before finishing: run the proof command yourself until it passes, leave \`git status\` clean, and make sure the latest commit is pushed to the draft PR (when a PR is required).
`;
}
