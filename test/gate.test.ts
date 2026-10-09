import { expect, test } from "bun:test";
import { parseFailedTests, withFlakySection } from "../src/gate";
const vitest = await Bun.file(new URL("./fixtures/vitest-flaky.log", import.meta.url)).text();
const dotnet = await Bun.file(new URL("./fixtures/dotnet-flaky.log", import.meta.url)).text();

test("vitest evidence names two flaky tests and their messages", () => {
  const tests = parseFailedTests(vitest);
  expect(tests).toHaveLength(2);
  expect(tests[0].name.startsWith("platform-admin apps/platform-admin/src/screens/PlanWizardScreen.test.tsx > PlanWizardScreen > saves a brand")).toBe(true);
  expect(tests[0].message).toBe("Error: Test timed out in 5000ms.");
  expect(tests[1].name).toContain("PlansTab > shows live inventory");
});
test("dotnet evidence extracts Error Message after Failed test", () => {
  const tests = parseFailedTests(dotnet);
  expect(tests).toHaveLength(1);
  expect(tests[0].name).toBe("Acme.Platform.IntegrationTests.Handlers.Orders.OrdersHealthTransitionRecorderTests.RecordSnapshots_persists_transition_on_state_change_and_skips_duplicates");
  expect(tests[0].message.startsWith("Acme.Platform.Domain.Exceptions.DomainArgumentException : Modified date cannot be earlier")).toBe(true);
});
test("jest ignores Console, deduplicates, caps names and messages, and falls back", () => {
  expect(parseFailedTests(" ● Console\nnoise\n ● Checkout > saves\n\n error\n ● Checkout > saves\nother")).toEqual([{ name: "Checkout > saves", message: "error" }]);
  const tests = parseFailedTests(Array.from({ length: 15 }, (_, i) => ` FAIL test ${i}\n${"x".repeat(400)}`).join("\n"));
  expect(tests).toHaveLength(10);
  expect(tests[0].message).toHaveLength(300);
  expect(parseFailedTests("unknown log\nlast line\n\n")).toEqual([{ name: "(unparsed)", message: "last line" }]);
});
test("flaky section replaces its predecessor and keeps following notes", () => {
  const body = "## Summary\nHello\n\n## Flaky tests\nold content\n\n## Notes\nkeep me\n";
  const out = withFlakySection(body, [{ name: "Plan saves", message: "timeout" }], 3);
  expect(out).not.toContain("old content");
  expect(out).toContain("## Notes\nkeep me");
  expect(out).toContain("run 3 failed.");
  expect(out).toContain("- `Plan saves`: timeout");
  expect(out.match(/## Flaky tests/g)).toHaveLength(1);
  expect(withFlakySection(out, [{ name: "Plan saves", message: "timeout" }], 3)).toBe(out);
});
