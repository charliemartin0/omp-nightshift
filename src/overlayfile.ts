import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildChainProviders, buildOverlay } from "./overlay";
import { spawnGroup } from "./proc";
import type { RunJson } from "./runjson";

/** `omp config get <key> --json` (read-only, zero model tokens) -> `.value` entries. */
async function configEntries(repo: string, key: string): Promise<[string, unknown][]> {
  const r = await spawnGroup(["omp", "config", "get", key, "--json"], { cwd: repo, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`omp config get ${key}: ${r.stderr.trim() || `exit ${r.code}`}`);
  const parsed: unknown = JSON.parse(r.stdout);
  const value = typeof parsed === "object" && parsed !== null && "value" in parsed ? parsed.value : undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`omp config get ${key}: no object .value in output`);
  }
  return Object.entries(value);
}

/** Build and write `<runDir>/overlay.yml` from the live global config; returns its path and the build chain's providers. */
export async function writeOverlay(run: RunJson): Promise<{ path: string; buildProviders: string[] }> {
  const roles: Record<string, string> = {};
  for (const [k, v] of await configEntries(run.repo, "modelRoles")) if (typeof v === "string") roles[k] = v;
  const chains: Record<string, string[]> = {};
  for (const [k, v] of await configEntries(run.repo, "retry.fallbackChains")) {
    if (Array.isArray(v)) chains[k] = v.filter((m): m is string => typeof m === "string");
  }
  const file = join(run.runDir, "overlay.yml");
  mkdirSync(run.runDir, { recursive: true });
  writeFileSync(file, buildOverlay(roles, chains, run.reservePct));
  return { path: file, buildProviders: buildChainProviders(run.models.build, roles, chains) };
}
