import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkNeeds, parseBacklog } from "../src/backlog";
import { globToRegExp, isTestPath, lintBacklog, lintText } from "../src/planlint";
import { preflightSummary } from "../src/preflight";
import { renderChunkPrompt } from "../src/prompt";
import { jev, playwrightBrowsers } from "../src/toolchecks";
import { setup } from "./helpers";

const chunk = (id: string, fields: Record<string, string>) =>
  `## ${id}\n- status: ${fields.status ?? "pending"}\n- scope: ${fields.scope ?? "s"}\n- done-when: ${fields.done ?? "d"}\n- test: ${fields.test ?? "true"}\n- prod-code: ${fields.prod ?? "no"}\n${fields.allow ? `- allow: ${fields.allow}\n` : ""}${fields.needs ? `- needs: ${fields.needs}\n` : ""}`;

test("new needs are inferred from the proof command and scope", () => {
  const [pw, api, j] = parseBacklog([
    chunk("pw", { test: "cd Frontend && yarn playwright test" }),
    chunk("api", { test: "dotnet apicompat --left a.dll" }),
    chunk("j", { scope: "measure Jev selection accuracy" }),
  ].join("\n")).chunks;
  expect(chunkNeeds(pw)).toEqual(["browser", "playwright"]);
  expect(chunkNeeds(api)).toEqual(["dotnet", "apicompat"]);
  expect(chunkNeeds(j)).toEqual(["jev"]);
  expect(parseBacklog(chunk("l", { needs: "lsp" })).chunks[0].needs).toEqual(["lsp"]);
});

test("plan lint flags tests-only chunks that describe production edits", () => {
  const chunks = parseBacklog([
    chunk("ok", { scope: "add tests for Frontend/apps/admin/src/Pager.test.tsx and e2e/campaigns.spec.ts" }),
    chunk("prodfile", { scope: "make the dashboard test deterministic; touches src/features/applyAdminTenantChange.ts" }),
    chunk("phrase", { scope: "add aria-labels to the campaigns pager so axe passes" }),
    chunk("lint", { test: "cd Frontend && yarn eslint apps/admin" }),
    chunk("allowed", { scope: "fix src/features/applyAdminTenantChange.ts query key", allow: "src/features/*.ts" }),
    chunk("prod", { scope: "fix the bug in src/a.ts", prod: "yes" }),
    chunk("done", { scope: "src/a.ts", status: "passed" }),
  ].join("\n")).chunks;
  const findings = lintBacklog(chunks);
  expect(findings.map((f) => f.id)).toEqual(["prodfile", "phrase", "lint"]);
  expect(findings[0].paths).toEqual(["src/features/applyAdminTenantChange.ts"]);
  expect(findings[1].reasons[0]).toContain("aria-labels");
  const text = lintText(findings);
  expect(text).toContain("3 chunk(s) may need production-code approval");
  expect(text).toContain("`- allow: src/features/applyAdminTenantChange.ts`");
  expect(lintText([])).toContain("no prod-code: no chunk");
});

test("test-path and glob helpers", () => {
  for (const p of ["a/b.test.ts", "x/__tests__/y.ts", "Backend/Foo.Tests/Bar.cs", "OrderTests.cs", "Frontend/e2e/a.ts", "playwright.config.ts"]) expect(isTestPath(p)).toBe(true);
  for (const p of ["src/a.ts", "Backend/Src/Order.cs", "tsconfig.eslint.json"]) expect(isTestPath(p)).toBe(false);
  expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
  expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
  expect(globToRegExp("tsconfig.eslint.json").test("Frontend/tsconfig.eslint.json")).toBe(true);
});

test("approved allow globs reach the chunk prompt", () => {
  const { ctx } = setup();
  const c = parseBacklog(chunk("a", { allow: "src/x.ts, `tsconfig.eslint.json`" })).chunks[0];
  expect(c.allow).toEqual(["src/x.ts", "tsconfig.eslint.json"]);
  const prompt = renderChunkPrompt(ctx.run, c, { wt: "/w", branch: "b", base: "main", prBase: "main" });
  expect(prompt).toContain("except these paths the operator approved up front: src/x.ts, tsconfig.eslint.json");
});

test("preflight summary lists each problem, the chunks it blocks and the fix", () => {
  const chunks = parseBacklog([chunk("pw", { test: "npx playwright test" }), chunk("j", { scope: "jev accuracy" })].join("\n")).chunks;
  const text = preflightSummary(chunks, [
    { name: "playwright_browsers", need: "playwright", ok: false, detail: "chromium-1200 not installed" },
    { name: "jev", need: "jev", ok: false, detail: "missing key", fix: "set it" },
    { name: "disk", ok: false, detail: "3 GB free" },
    { name: "docker", need: "docker", ok: true, detail: "ok" },
  ]);
  expect(text).toContain("preflight: 3 problem(s):");
  expect(text).toContain("playwright_browsers: chromium-1200 not installed [blocks pw]");
  expect(text).toContain("npx playwright install chromium");
  expect(text).toContain("jev: missing key [blocks j]\n    fix: set it");
  expect(text).toContain("disk: 3 GB free [blocks the launch]");
  expect(preflightSummary(chunks, [{ name: "x", ok: true, detail: "" }])).toBe("");
});

test("playwright browser check matches the repo's pinned Chromium revision", () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-check-"));
  const old = process.env.PLAYWRIGHT_BROWSERS_PATH;
  try {
    const { ctx } = setup();
    const repo = join(dir, "repo");
    const cache = join(dir, "cache");
    mkdirSync(join(repo, "Frontend", "node_modules", "playwright-core"), { recursive: true });
    writeFileSync(join(repo, "Frontend", "node_modules", "playwright-core", "browsers.json"), JSON.stringify({ browsers: [{ name: "chromium", revision: "1200" }] }));
    mkdirSync(join(cache, "chromium-1100"), { recursive: true });
    writeFileSync(join(cache, "chromium-1100", "INSTALLATION_COMPLETE"), "");
    process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
    const run = { ...ctx.run, repo };
    expect(playwrightBrowsers(run)).toMatchObject({ ok: false, detail: expect.stringContaining("chromium-1200 not installed") });
    mkdirSync(join(cache, "chromium-1200"));
    writeFileSync(join(cache, "chromium-1200", "INSTALLATION_COMPLETE"), "");
    expect(playwrightBrowsers(run)).toMatchObject({ ok: true });
  } finally {
    if (old === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH; else process.env.PLAYWRIGHT_BROWSERS_PATH = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("jev check accepts the environment variable", () => {
  const old = process.env.TYPESAFE_API_KEY;
  try {
    process.env.TYPESAFE_API_KEY = "k";
    expect(jev().ok).toBe(true);
  } finally {
    if (old === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = old;
  }
});