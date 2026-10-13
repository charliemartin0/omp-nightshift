import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompArgv, runOmp } from "../src/agent";
import { entries, setup } from "./helpers";

// Fake omp: refuses any `-r` resume the way omp 18.6.3+ does when the saved model is gone; records every argv.
function fakeOmp(): { bin: string; calls: string } {
  const bin = mkdtempSync(join(tmpdir(), "fake-omp-"));
  const calls = join(bin, "calls");
  writeFileSync(join(bin, "omp"), `#!/bin/bash
echo "$*" >> ${calls}
for a in "$@"; do if [ "$a" = "-r" ]; then echo "Error: Could not restore model anthropic/gone" >&2; exit 1; fi; done
echo '{"type":"session","id":"s-fresh"}'
`);
  chmodSync(join(bin, "omp"), 0o755);
  return { bin, calls };
}

test("fresh mode argv keeps the build model and message but drops -r", () => {
  const { ctx, dir } = setup();
  const argv = ompArgv(ctx, "c", dir, { kind: "fresh", message: "fix the gate" });
  expect(argv).not.toContain("-r");
  expect(argv.slice(0, 6)).toEqual(["omp", "-p", "--mode", "json", "--model", "@default"]);
  expect(argv.at(-1)).toBe("fix the gate");
});

test("a resume omp cannot restore the model for restarts as a fresh session with a warning", async () => {
  const { bin, calls } = fakeOmp();
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const { ctx, dir } = setup();
    ctx.capAtMs = Date.now() + 3_600_000;
    const r = await runOmp(ctx, { chunk: "c", wt: dir, n: 1, tokensUsed: 0, mode: { kind: "resume", session: "s-old", message: "fix the gate" } });
    expect(r).toMatchObject({ code: 0, trip: null, sessionId: "s-fresh" });
    const lines = readFileSync(calls, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("-r s-old");
    expect(lines[1]).not.toContain("-r");
    expect(lines[1]).toEndWith("fix the gate");
    const log = entries(ctx);
    expect(log.find((e) => e.event === "warning")).toMatchObject({ chunk: "c", kind: "model_restore" });
  } finally {
    process.env.PATH = saved;
  }
});
