import type { Chunk } from "./backlog";
import type { RunJson } from "./runjson";

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

function forgeBlock(run: RunJson, ctx: PromptCtx): string {
  switch (run.forge) {
    case "graphite":
      return `Graphite repo. Stage explicit paths with git add, commit with gt modify --no-interactive -c -m "<msg>" (the branch is already tracked on ${ctx.prBase}; do not run gt create or gt checkout). Submit with gt submit --draft --no-interactive. Never gh pr create, never git push, never --force, never --publish, never gh pr ready (except gh pr ready --undo).`;
    case "github":
      return `Commit with git commit. Push with git push -u ${run.remote} ${ctx.branch} (never --force). Open the PR with gh pr create --draft --base ${ctx.prBase} --head ${ctx.branch} --fill. Never mark it ready.`;
    case "local":
      return "Commit with git commit. Do not push and do not open a PR.";
  }
}

export function renderChunkPrompt(run: RunJson, chunk: Chunk, ctx: PromptCtx): string {
  const prod = chunk.prodCode
    ? "Production code changes are allowed only as the chunk scope requires."
    : "Do NOT change production code; only add or fix tests and test fixtures/config.";
  return `You are running UNATTENDED overnight for Charlie. Nobody will answer questions.
- Never use the ask tool, never wait for input, never pause for confirmation.
- Human gate (missing secret/service/tool, another account needed, an ambiguous product decision, a destructive or force-push step):
  write one line \`BLOCKED: <reason>\` to ${ctx.wt}/.overnight-status and stop immediately. Do not commit that file.

Goal of the night: ${run.goal}
Your chunk: ${chunk.id}
Scope: ${chunk.scope}
Done when: ${chunk.doneWhen}
Proof command (must pass from the worktree root): ${chunk.test}
Production code: ${prod}

Workspace: ${ctx.wt} (git worktree). Branch \`${ctx.branch}\` already exists and is checked out, based on \`${ctx.base}\`. Stay on it. Never check out ${run.trunk}.
Follow the repo AGENTS.md and ~/.omp/agent/AGENTS.md for commits and PRs, with these specifics:
${forgeBlock(run, ctx)}
Before finishing: run the proof command yourself until it passes, leave \`git status\` clean, and make sure the latest commit is pushed to the draft PR (when a PR is required).
`;
}
