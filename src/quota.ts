export type Floors = Record<string, number>;

export type QuotaResult =
  | { ok: true }
  | { ok: false; reason: "quota_floor" | "quota_limit_reached" | "quota_unknown"; detail: string }
  | { ok: false; reason: "quota_wait"; detail: string; provider: string; window: string; resetsAt: number };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

interface Win {
  id: string;
  remaining: number | null;
  resetsAt: number | null;
}

const windowsOf = (report: Obj): Win[] =>
  (Array.isArray(report.limits) ? report.limits.filter(isObj) : []).map((l) => {
    const scope = isObj(l.scope) ? l.scope : {};
    const win = isObj(l.window) ? l.window : {};
    return {
      id: String(scope.windowId ?? win.id),
      remaining: isObj(l.amount) ? num(l.amount.remainingFraction) : null,
      resetsAt: num(win.resetsAt),
    };
  });

const limitReached = (report: Obj): boolean => isObj(report.metadata) && report.metadata.limitReached === true;

/** Hard stops: every floor provider needs a 7d window at or above its floor. */
function checkFloors(reports: Obj[], floors: Floors): QuotaResult {
  for (const [provider, floor] of Object.entries(floors)) {
    const mine = reports.filter((r) => r.provider === provider);
    if (!mine.length) return { ok: false, reason: "quota_unknown", detail: `${provider}: no usage report` };
    let best: number | null = null;
    for (const r of mine) {
      for (const w of windowsOf(r)) {
        if (w.id !== "7d" || w.remaining === null) continue;
        if (w.remaining <= 0) return { ok: false, reason: "quota_limit_reached", detail: `${provider} 7d exhausted` };
        best = best === null ? w.remaining : Math.max(best, w.remaining);
      }
    }
    if (best === null) return { ok: false, reason: "quota_unknown", detail: `${provider}: no 7d remainingFraction` };
    if (best < floor) {
      return { ok: false, reason: "quota_floor", detail: `${provider} 7d ${best.toFixed(2)} < ${floor.toFixed(2)}` };
    }
  }
  return { ok: true };
}

interface Unblock {
  at: number;
  window: string;
}

/** null = usable; else the blocking window ids and when the report recovers (null = not on its own). */
function blockage(report: Obj, reserve: number): { windows: string[]; unblock: Unblock | null } | null {
  const wins = windowsOf(report);
  const low = wins.filter((w) => w.remaining !== null && w.remaining <= reserve);
  if (!limitReached(report) && !low.length) return null;
  let blocking = low;
  if (!blocking.length) {
    // limitReached with every window above the reserve: exhausted windows, else the earliest non-7d reset
    blocking = wins.filter((w) => w.remaining !== null && w.remaining <= 0);
    if (!blocking.length) {
      const short = wins.filter((w) => w.id !== "7d" && w.resetsAt !== null);
      if (short.length) blocking = [short.reduce((a, b) => (Number(b.resetsAt) < Number(a.resetsAt) ? b : a))];
    }
  }
  const windows = blocking.map((w) => w.id);
  if (!blocking.length) return { windows, unblock: null };
  let latest: Unblock | null = null;
  for (const w of blocking) {
    if (w.id === "7d" || w.resetsAt === null) return { windows, unblock: null };
    if (!latest || w.resetsAt > latest.at) latest = { at: w.resetsAt, window: w.id };
  }
  return { windows, unblock: latest };
}

/**
 * Floors (7d) are hard stops. Then, if every provider in the build chain is unusable (limitReached or a window at
 * or below the reserve), either `quota_wait` (some provider recovers on a short window) or `quota_limit_reached`.
 */
export function evaluateQuota(usage: unknown, floors: Floors, chain: string[], reservePct: number): QuotaResult {
  const reports = isObj(usage) && Array.isArray(usage.reports) ? usage.reports.filter(isObj) : [];
  const floor = checkFloors(reports, floors);
  if (!floor.ok || chain.length === 0) return floor;

  const reserve = reservePct / 100;
  const unusable: { provider: string; unblock: Unblock | null; desc: string }[] = [];
  for (const provider of chain) {
    const mine = reports.filter((r) => r.provider === provider);
    if (!mine.length) return { ok: true }; // unknown usage keeps the model, as omp does
    const blocks = mine.map((r) => blockage(r, reserve));
    // a provider is usable if ANY of its accounts is
    if (blocks.some((b) => b === null)) return { ok: true };
    let best: Unblock | null = null;
    const windows: string[] = [];
    for (const b of blocks) {
      if (!b) continue;
      windows.push(...b.windows);
      if (b.unblock && (!best || b.unblock.at < best.at)) best = b.unblock;
    }
    unusable.push({ provider, unblock: best, desc: `${provider} ${[...new Set(windows)].join("/") || "limitReached"}` });
  }

  let first: { provider: string; unblock: Unblock } | null = null;
  for (const u of unusable) {
    if (u.unblock && (!first || u.unblock.at < first.unblock.at)) first = { provider: u.provider, unblock: u.unblock };
  }
  if (!first) {
    return { ok: false, reason: "quota_limit_reached", detail: `build chain unusable: ${unusable.map((u) => u.desc).join(", ")}` };
  }
  return {
    ok: false,
    reason: "quota_wait",
    detail: `build chain unusable; ${first.provider} ${first.unblock.window} resets ${new Date(first.unblock.at).toISOString()}`,
    provider: first.provider,
    window: first.unblock.window,
    resetsAt: first.unblock.at,
  };
}
