export type Floors = Record<string, number>;

export type QuotaResult =
  | { ok: true }
  | { ok: false; reason: "quota_floor" | "quota_limit_reached" | "quota_unknown"; detail: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function evaluateQuota(usage: unknown, floors: Floors): QuotaResult {
  const reports = isObj(usage) && Array.isArray(usage.reports) ? usage.reports.filter(isObj) : [];
  for (const [provider, floor] of Object.entries(floors)) {
    const mine = reports.filter((r) => r.provider === provider);
    if (!mine.length) return { ok: false, reason: "quota_unknown", detail: `${provider}: no usage report` };
    let best: number | null = null;
    for (const r of mine) {
      if (isObj(r.metadata) && r.metadata.limitReached === true) {
        return { ok: false, reason: "quota_limit_reached", detail: `${provider} limitReached` };
      }
      const limits = Array.isArray(r.limits) ? r.limits.filter(isObj) : [];
      for (const l of limits) {
        const rem = isObj(l.amount) ? num(l.amount.remainingFraction) : null;
        const scope = isObj(l.scope) ? l.scope : {};
        const win = isObj(l.window) ? l.window : {};
        const wid = scope.windowId ?? win.id;
        if (rem !== null && rem <= 0) {
          return { ok: false, reason: "quota_limit_reached", detail: `${provider} ${String(wid)} exhausted` };
        }
        if ((scope.windowId === "7d" || win.id === "7d") && rem !== null) {
          best = best === null ? rem : Math.max(best, rem);
        }
      }
    }
    if (best === null) return { ok: false, reason: "quota_unknown", detail: `${provider}: no 7d remainingFraction` };
    if (best < floor) {
      return { ok: false, reason: "quota_floor", detail: `${provider} 7d ${best.toFixed(2)} < ${floor.toFixed(2)}` };
    }
  }
  return { ok: true };
}
