const q = (s: string) => JSON.stringify(s);

/** Free-tier models (`...-free`, `...:free`) are never used, not even as a quota fallback. */
export const isFreeModel = (model: string): boolean => /[-:]free$/i.test(model.trim());

/** Fallback chains without free-tier entries; a chain left empty keeps its key. */
export function withoutFreeModels(chains: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(chains).map(([k, v]) => [k, v.filter((m) => !isFreeModel(m))]));
}

/** Throws when a model the run is configured to use directly (or through a role) is a free-tier model. */
export function assertNoFreeModels(models: Record<string, string>, roles: Record<string, string>): void {
  for (const [slot, model] of Object.entries(models)) {
    const resolved = model.startsWith("@") ? roles[model.slice(1)] ?? model : model;
    if (isFreeModel(resolved)) throw new Error(`run.json models.${slot} resolves to the free model ${resolved}; free models are never used`);
  }
}

/** Overlay YAML: the live modelRoles and fallbackChains verbatim, usageReservePct from the run. */
export function buildOverlay(roles: Record<string, string>, allChains: Record<string, string[]>, reservePct: number): string {
  const chains = withoutFreeModels(allChains);
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
  allChains: Record<string, string[]>,
): string[] {
  const chains = withoutFreeModels(allChains);
  const entries: (string | undefined)[] = model.startsWith("@")
    ? [roles[model.slice(1)], ...(chains[model.slice(1)] ?? [])]
    : [model, ...(chains[model] ?? [])];
  const out: string[] = [];
  for (const e of entries) {
    if (!e) continue;
    if (isFreeModel(e)) continue;
    const p = e.split("/")[0];
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
