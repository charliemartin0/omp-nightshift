const q = (s: string) => JSON.stringify(s);

/** Overlay YAML: the live modelRoles and fallbackChains verbatim, usageReservePct from the run. */
export function buildOverlay(roles: Record<string, string>, chains: Record<string, string[]>, reservePct: number): string {
  const lines: string[] = ["modelRoles:"];
  for (const [k, v] of Object.entries(roles)) lines.push(`  ${q(k)}: ${q(v)}`);
  lines.push(
    "retry:",
    "  modelFallback: true",
    "  usageAwareFallback: true",
    `  usageReservePct: ${reservePct}`,
    "  waitForUsageReset: false",
  );
  const keys = Object.keys(chains);
  if (keys.length === 0) lines.push("  fallbackChains: {}");
  else {
    lines.push("  fallbackChains:");
    for (const k of keys) lines.push(`    ${q(k)}: [${chains[k].map(q).join(", ")}]`);
  }
  lines.push(
    "providers:", "  streamIdleTimeoutSeconds: 300",
    "task:", "  maxRuntimeMs: 1800000", "  maxConcurrency: 2",
    "completion:", '  notify: "off"',
  );
  return lines.join("\n") + "\n";
}

/**
 * Providers omp may use for `model` (a model string or `@role`): the primary plus its fallback chain,
 * unique, in order.
 */
export function buildChainProviders(
  model: string,
  roles: Record<string, string>,
  chains: Record<string, string[]>,
): string[] {
  const entries: (string | undefined)[] = model.startsWith("@")
    ? [roles[model.slice(1)], ...(chains[model.slice(1)] ?? [])]
    : [model, ...(chains[model] ?? [])];
  const out: string[] = [];
  for (const e of entries) {
    if (!e) continue;
    const p = e.split("/")[0];
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
