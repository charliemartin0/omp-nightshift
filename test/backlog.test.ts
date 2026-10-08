import { expect, test } from "bun:test";
import { parseBacklog, setChunkStatus } from "../src/backlog";

const md = await Bun.file(new URL("./fixtures/backlog.md", import.meta.url)).text();

test("parses chunks", () => {
  const { goal, chunks } = parseBacklog(md);
  expect(goal).toBe("harden the checkout flow tests");
  expect(chunks.map((c) => c.id)).toEqual(["cart-tests", "login-fix", "api-tests"]);
  expect(chunks[0].test).toBe("npm test -- cart");
  expect(chunks[1].test).toBe("npm test -- login");
  expect(chunks.map((c) => c.prodCode)).toEqual([false, true, false]);
  expect(chunks[1].note).toBe("old note");
  expect(chunks[2].status).toBe("skipped");
});

test("missing test throws naming chunk", () => {
  const bad = md.replace("- test: `npm test -- cart`\n", "");
  expect(() => parseBacklog(bad)).toThrow(/backlog: cart-tests: missing field test/);
});

test("duplicate id throws", () => {
  expect(() => parseBacklog(md + "\n## cart-tests\n- status: pending\n")).toThrow(/backlog: cart-tests: duplicate/);
});

test("invalid status throws", () => {
  expect(() => parseBacklog(md.replace("status: skipped", "status: weird"))).toThrow(/backlog: api-tests: invalid status/);
});

test("bad id and zero chunks throw", () => {
  expect(() => parseBacklog(md.replace("## login-fix", "## Login_Fix"))).toThrow(/Login_Fix/);
  expect(() => parseBacklog("# Overnight backlog\ngoal: x\n")).toThrow(/no chunks/);
});

test("setChunkStatus changes only status and note lines", () => {
  const out = setChunkStatus(md, "login-fix", "failed", "tests 1/3");
  const expected = md.replace("- status: pending\n- scope: fix login", "- status: failed\n- scope: fix login").replace("- note: old note", "- note: tests 1/3");
  expect(out).toBe(expected);
});

test("setChunkStatus inserts missing note after status", () => {
  const noNote = md.replace("- note: old note\n", "");
  const out = setChunkStatus(noNote, "login-fix", "passed", "PR #1");
  expect(out).toBe(noNote.replace("- status: pending\n- scope: fix login", "- status: passed\n- note: PR #1\n- scope: fix login"));
  expect(parseBacklog(out).chunks[1].note).toBe("PR #1");
});
