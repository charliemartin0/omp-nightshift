import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseBacklog } from "../src/backlog";
import { chunksBlockedBy, preflightRequirements } from "../src/preflight";
import { backlog, setup } from "./helpers";

test("preflight blocks only pending chunks needing the failed tool", () => {
  const { ctx } = setup();
  backlog(ctx, [{ id: "a", needs: "docker" }, { id: "b", test: "dotnet test X" }, { id: "c" }, { id: "d", needs: "browser", status: "passed" }]);
  const chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
  const blocked = chunksBlockedBy(chunks, [
    { name: "docker", need: "docker", ok: false, detail: "socket denied\ntry permissions" },
    { name: "browser", need: "browser", ok: false, detail: "missing" },
    { name: "dotnet", need: "dotnet", ok: true, detail: "restored" },
  ]);
  expect(blocked).toEqual([{ id: "a", note: "env: preflight docker: socket denied try permissions" }]);
  expect(preflightRequirements(chunks)).toEqual({ needs: ["docker", "dotnet"], dotnetTarget: "X" });
});

test("dotnet targets respect quoted paths and ignore options", () => {
  const { ctx } = setup();
  backlog(ctx, [{ id: "a", test: 'dotnet test "test space.sln" --no-restore' }]);
  let chunks = parseBacklog(readFileSync(ctx.backlog, "utf8")).chunks;
  expect(preflightRequirements(chunks).dotnetTarget).toBe("test space.sln");
  chunks = [{ ...chunks[0], test: "dotnet test --no-restore" }];
  expect(preflightRequirements(chunks).dotnetTarget).toBeUndefined();
});
