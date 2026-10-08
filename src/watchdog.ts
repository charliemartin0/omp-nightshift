export type Trip = "stall" | "timeout" | "token_cap";

export const QUOTA_ERROR_RE = /usage_limit_reached|usage limit|rate[ _-]?limit|\b429\b|quota/i;

export class Watchdog {
  sessionId: string | null = null;
  tokens: number;
  /** errorMessage of the latest assistant message_end if it ended in error; cleared by a later normal one */
  lastError: string | null = null;
  private start: number;
  private last: number;
  private stallMs: number;
  private hardMs: number;
  private tokenCap: number;

  constructor(o: { now: number; stallMs: number; hardMs: number; tokenCap: number; tokensUsed?: number }) {
    this.start = o.now;
    this.last = o.now;
    this.stallMs = o.stallMs;
    this.hardMs = o.hardMs;
    this.tokenCap = o.tokenCap;
    this.tokens = o.tokensUsed ?? 0;
  }

  onLine(line: string, now: number): void {
    this.last = now;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof ev !== "object" || ev === null) return;
    if (this.sessionId === null && ev.type === "session" && typeof ev.id === "string") this.sessionId = ev.id;
    if (ev.type === "message_end" && ev.message?.role === "assistant") {
      const m = ev.message;
      this.lastError = m.stopReason === "error" && typeof m.errorMessage === "string" ? m.errorMessage : null;
      if (m.usage) {
        for (const k of ["input", "output", "cacheWrite"]) {
          if (typeof m.usage[k] === "number" && Number.isFinite(m.usage[k])) this.tokens += m.usage[k];
        }
      }
    }
  }

  touch(now: number): void {
    this.last = now;
  }

  check(now: number): Trip | null {
    if (this.tokens >= this.tokenCap) return "token_cap";
    if (now - this.start >= this.hardMs) return "timeout";
    if (now - this.last >= this.stallMs) return "stall";
    return null;
  }
}
