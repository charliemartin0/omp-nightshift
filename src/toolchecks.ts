import { existsSync, readdirSync, readFileSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Chunk, Need } from "./backlog";
import type { TimeoutBudget } from "./git";
import { spawnGroup } from "./proc";
import type { RunJson } from "./runjson";

/** Shape shared with preflight's Check (kept structural to avoid an import cycle). */
export interface ToolCheck { name: string; ok: boolean; warn?: boolean; detail: string; need?: Need; fix?: string }

/** How to fix each missing tool, shown in the launch summary. */
export const FIXES: Record<string, string> = {
  playwright: "run `npx playwright install chromium` (or `--with-deps`) in the package that owns the Playwright config",
  lsp: "install a TypeScript language server, e.g. `npm i -g typescript typescript-language-server`",
  jev: "export TYPESAFE_API_KEY or put `TYPESAFE_API_KEY=...` in ~/.config/typesafe/env",
  apicompat: "install it, e.g. `dotnet tool install -g Microsoft.DotNet.ApiCompat.Tool` (or restore the repo's tool manifest)",
  docker: "start the Docker daemon and make sure this user can reach its socket",
  browser: "install Chrome or Chromium",
  dotnet: "install the .NET SDK the repo needs and check `dotnet restore`",
  disk: "free space on the worktree volume (old worktrees, build caches, docker images)",
};

/** Default minimum free space on the worktree volume; override with OMP_NIGHTSHIFT_MIN_FREE_GB. */
export const MIN_FREE_GB = 10;
const WARN_FREE_GB = 25;

function freeGb(path: string): number {
  let p = path;
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  const s = statfsSync(p);
  return (Number(s.bavail) * Number(s.bsize)) / 1024 ** 3;
}

/** Global: the volume holding worktrees must have room for fresh checkouts, builds and test artefacts. */
export function disk(run: RunJson): ToolCheck {
  const min = Number(process.env.OMP_NIGHTSHIFT_MIN_FREE_GB) || MIN_FREE_GB;
  const gb = freeGb(run.worktreeRoot);
  const detail = `${gb.toFixed(1)} GB free on the worktree volume (minimum ${min} GB)`;
  if (gb < min) return { name: "disk", ok: false, detail, fix: FIXES.disk };
  return { name: "disk", ok: true, warn: gb < WARN_FREE_GB, detail };
}

/** Directories (repo root and one level down) holding an installed playwright-core, for its browsers.json. */
function playwrightCores(repo: string): string[] {
  const roots = [repo];
  try {
    for (const d of readdirSync(repo, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules") roots.push(join(repo, d.name));
  } catch { /* unreadable repo: fall back to any installed browser */ }
  return roots.map((r) => join(r, "node_modules", "playwright-core", "browsers.json")).filter(existsSync);
}

/** Playwright's own browser cache holds the Chromium build the repo's Playwright expects (INSTALLATION_COMPLETE marker). */
export function playwrightBrowsers(run: RunJson): ToolCheck {
  const name = "playwright_browsers";
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== "0"
    ? process.env.PLAYWRIGHT_BROWSERS_PATH
    : join(homedir(), ".cache", "ms-playwright");
  const installed = existsSync(cache) ? readdirSync(cache).filter((d) => existsSync(join(cache, d, "INSTALLATION_COMPLETE"))) : [];
  const wanted = new Set<string>();
  for (const file of playwrightCores(run.repo)) {
    try {
      const browsers = (JSON.parse(readFileSync(file, "utf8")) as { browsers?: { name?: string; revision?: string }[] }).browsers ?? [];
      for (const b of browsers) if (b.name === "chromium" && b.revision) wanted.add(`chromium-${b.revision}`);
    } catch { /* malformed browsers.json: ignore */ }
  }
  const missing = [...wanted].filter((d) => !installed.includes(d));
  if (wanted.size && !missing.length) return { name, need: "playwright", ok: true, detail: `${[...wanted].join(", ")} installed in ${cache}` };
  if (!wanted.size && installed.some((d) => d.startsWith("chromium"))) return { name, need: "playwright", ok: true, detail: `Chromium found in ${cache} (repo Playwright version not resolved: node_modules not installed in the main checkout)` };
  return { name, need: "playwright", ok: false, detail: missing.length ? `${missing.join(", ")} not installed in ${cache}` : `no Playwright Chromium installed in ${cache}`, fix: FIXES.playwright };
}

export function lsp(): ToolCheck {
  const bin = Bun.which("typescript-language-server");
  return bin
    ? { name: "lsp", need: "lsp", ok: true, detail: bin }
    : { name: "lsp", need: "lsp", ok: false, detail: "typescript-language-server is not on PATH", fix: FIXES.lsp };
}

export function jev(): ToolCheck {
  if (process.env.TYPESAFE_API_KEY?.trim()) return { name: "jev", need: "jev", ok: true, detail: "TYPESAFE_API_KEY set in the environment" };
  const file = join(homedir(), ".config", "typesafe", "env");
  const ok = existsSync(file) && /^\s*(?:export\s+)?TYPESAFE_API_KEY=\S+/m.test(readFileSync(file, "utf8"));
  return ok
    ? { name: "jev", need: "jev", ok: true, detail: "TYPESAFE_API_KEY found in ~/.config/typesafe/env" }
    : { name: "jev", need: "jev", ok: false, detail: "TYPESAFE_API_KEY is neither set nor in ~/.config/typesafe/env", fix: FIXES.jev };
}

export async function apicompat(run: RunJson, budget: TimeoutBudget): Promise<ToolCheck> {
  const name = "apicompat";
  const bin = Bun.which("apicompat");
  if (bin) return { name, need: "apicompat", ok: true, detail: bin };
  for (const args of [["tool", "list"], ["tool", "list", "-g"]]) {
    const r = await spawnGroup(["dotnet", ...args], { cwd: run.repo, timeoutMs: budget(60_000) });
    if (r.code === 0 && /apicompat/i.test(r.stdout)) return { name, need: "apicompat", ok: true, detail: `dotnet ${args.join(" ")} lists apicompat` };
  }
  return { name, need: "apicompat", ok: false, detail: "no apicompat on PATH and no dotnet tool (local or global) provides it", fix: FIXES.apicompat };
}

/** TypeScript-heavy pending work without a language server degrades symbol-aware edits; a warning unless declared. */
export function lspWarning(chunks: Chunk[], needs: Need[]): ToolCheck | null {
  if (needs.includes("lsp") || Bun.which("typescript-language-server")) return null;
  const ts = chunks.filter((c) => c.status === "pending" && /\b(tsc|eslint|vitest|jest|playwright|yarn|pnpm|npm|npx|bun)\b/.test(c.test));
  return ts.length
    ? { name: "lsp", ok: true, warn: true, detail: `typescript-language-server is not on PATH; ${ts.length} TypeScript chunk(s) lose symbol-aware edits (declare \`needs: lsp\` to block them instead)`, fix: FIXES.lsp }
    : null;
}