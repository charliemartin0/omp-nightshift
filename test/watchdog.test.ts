import { expect, test } from "bun:test";
import { Watchdog } from "../src/watchdog";

const lines = (await Bun.file(new URL("./fixtures/stream.jsonl", import.meta.url)).text()).split("\n").filter(Boolean);
const mk = (o: Partial<ConstructorParameters<typeof Watchdog>[0]> = {}) =>
  new Watchdog({ now: 0, stallMs: 1000, hardMs: 10_000, tokenCap: 1_000_000, ...o });

test("sessionId and tokens from stream", () => {
  const w = mk();
  expect(w.sessionId).toBeNull();
  lines.forEach((l, i) => w.onLine(l, i));
  expect(w.sessionId).toBe("s-1");
  expect(w.tokens).toBe(100 + 50 + 20 + 10 + 5 + 0);
});

test("stall trips at exactly stallMs", () => {
  const w = mk();
  expect(w.check(999)).toBeNull();
  expect(w.check(1000)).toBe("stall");
});

test("onLine and touch reset stall", () => {
  const w = mk();
  w.onLine("{}", 900);
  expect(w.check(1800)).toBeNull();
  expect(w.check(1900)).toBe("stall");
  w.touch(1900);
  expect(w.check(2800)).toBeNull();
  expect(w.check(2900)).toBe("stall");
});

test("timeout trips at hardMs despite activity", () => {
  const w = mk();
  w.onLine("{}", 9500);
  expect(w.check(9999)).toBeNull();
  expect(w.check(10_000)).toBe("timeout");
});

test("token_cap wins over timeout", () => {
  const w = mk({ tokenCap: 100 });
  w.onLine(lines[2], 10_000);
  expect(w.check(10_000)).toBe("token_cap");
});

test("garbage line is activity and does not throw", () => {
  const w = mk();
  expect(() => w.onLine("not json {{", 800)).not.toThrow();
  expect(() => w.onLine("null", 850)).not.toThrow();
  expect(w.check(1700)).toBeNull();
});

test("tokensUsed seeds total", () => {
  const w = mk({ tokensUsed: 500 });
  expect(w.tokens).toBe(500);
  w.onLine(lines[2], 1);
  expect(w.tokens).toBe(670);
});
