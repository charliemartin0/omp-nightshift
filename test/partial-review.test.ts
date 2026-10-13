import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../src/git";
import { finishRun } from "../src/runner";
import { backlog, entries, setup } from "./helpers";

// Actual review and report subprocesses, with only the external model replaced by deterministic output.
for (const reason of ["consecutive_failures", "runner_error", "finished"]) {
  test(`successful PR is reviewed exactly once and findings reach the report after ${reason}`, async () => {
    const { ctx, dir } = setup();
    ctx.run.forge = "github";
    ctx.run.selfReview = true;
    expect((await git(dir, ["init", "-q"])).code).toBe(0);
    expect((await git(dir, ["remote", "add", "origin", "https://example.invalid/project/repo.git"])).code).toBe(0);
    backlog(ctx, [{ id: "passed", status: "passed" }, { id: "failed", status: "failed" }]);
    ctx.ledger.log("run_start");
    ctx.ledger.log("chunk_start", { chunk: "passed", wt: dir, base: "main" });
    ctx.ledger.log("gate", { chunk: "passed", ok: true, checks: { pr: { pr: { number: 7, url: "https://example.invalid/pr/7", isDraft: true } } } });
    ctx.ledger.log("chunk_end", { chunk: "passed", status: "passed" });
    ctx.ledger.log("chunk_start", { chunk: "failed", wt: dir });
    ctx.ledger.log("chunk_end", { chunk: "failed", status: "failed", note: "chunk_error: model process exited" });
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const command = join(bin, "omp");
    writeFileSync(command, `#!${process.execPath}
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const root = ${JSON.stringify(dir)};
const prompt = process.argv.at(-1).slice(1);
if (basename(prompt) === "passed-review.md") {
  mkdirSync(join(root, "reviews"), { recursive: true });
  writeFileSync(join(root, "reviews", "passed.md"), "- P2: Partial launch review finding.\\n");
} else if (basename(prompt) === "report.md") {
  writeFileSync(join(root, "report.md"), "## What went well\\n- Draft PR retained.\\n\\n## Even better if\\n- One chunk failed.\\n");
} else process.exit(1);
`);
    chmodSync(command, 0o755);
    const path = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${path ?? ""}`;
      await finishRun(ctx, { reason });
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
    const log = entries(ctx);
    const reviews = log.filter((e) => e.event === "self_review");
    expect(reviews).toMatchObject([{ chunk: "passed", pr: 7, ok: true }]);
    expect(log.findIndex((e) => e.event === "stop")).toBeLessThan(log.findIndex((e) => e.event === "self_review"));
    expect(log.findIndex((e) => e.event === "self_review")).toBeLessThan(log.findIndex((e) => e.event === "report"));
    expect(readFileSync(join(dir, "report.md"), "utf8")).toContain("Partial launch review finding");
  });
}
