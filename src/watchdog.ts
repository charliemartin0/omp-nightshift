export type Trip = "stall" | "timeout" | "token_cap";

export class Watchdog {
  sessionId: string | null = null;
  tokens: number;
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
    if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message.usage) {
      const u = ev.message.usage;
      for (const k of ["input", "output", "cacheWrite"]) {
        if (typeof u[k] === "number" && Number.isFinite(u[k])) this.tokens += u[k];
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
