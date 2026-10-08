const BASE_CHAIN_KEYS = ["default", "task", "slow", "plan", "smol", "commit"];

const q = (s: string) => JSON.stringify(s);
const banned = (v: string) => /opus/i.test(v) || v.startsWith("cursor/");

export function buildOverlay(roles: Record<string, string>, chains: Record<string, string[]>): string {
  if (typeof roles.default === "string" && banned(roles.default)) {
    throw new Error(`overlay: default role is ${roles.default}; no Opus/Cursor allowed`);
  }
  const outRoles: Record<string, string> = { slow: "@default", plan: "@default" };
  for (const [k, v] of Object.entries(roles)) {
    if (typeof v === "string" && banned(v)) outRoles[k] = "@default";
  }
  const keys = [...new Set([...BASE_CHAIN_KEYS, ...Object.keys(chains)])];
  const lines: string[] = ["modelRoles:"];
  for (const [k, v] of Object.entries(outRoles)) lines.push(`  ${q(k)}: ${q(v)}`);
  lines.push("retry:", "  usageReservePct: 25", "  waitForUsageReset: false", "  fallbackChains:");
  for (const k of keys) {
    const kept = (chains[k] ?? []).filter((e) => e.startsWith("openai/") || e.startsWith("openai-codex/"));
    lines.push(`    ${q(k)}: [${kept.map(q).join(", ")}]`);
  }
  lines.push(
    "providers:", "  streamIdleTimeoutSeconds: 300",
    "task:", "  maxRuntimeMs: 1800000", "  maxConcurrency: 2",
    "completion:", '  notify: "off"',
  );
  return lines.join("\n") + "\n";
}
