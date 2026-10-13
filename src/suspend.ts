// Host-suspend compensation. Windows/WSL sleep (or a laptop lid) freezes the machine; on wake `Date.now()` has jumped
// by the whole sleep while no work happened. Every wall-clock deadline in the runner must exclude that gap, or a
// sleeping host looks like a hung or runaway agent (the 2026-10-10 stores-panels "watchdog timeout" at 473k tokens).

/** A periodic timer that fires this much later than scheduled is treated as a host suspend. */
export const SUSPEND_GAP_MS = 90_000;

/** Compares consecutive timer samples with their expected spacing. */
export class GapDetector {
  private last: number;

  constructor(
    now: number,
    private readonly expectedMs: number,
    private readonly thresholdMs = SUSPEND_GAP_MS,
  ) {
    this.last = now;
  }

  /** Milliseconds to exclude from elapsed time since the previous sample; 0 when the timer was on schedule. */
  sample(now: number): number {
    const excess = now - this.last - this.expectedMs;
    this.last = now;
    return excess >= this.thresholdMs ? excess : 0;
  }
}

export interface GuardOptions {
  timeoutMs: number;
  onTimeout: () => void;
  /** Called with the excluded gap each time a suspend is detected (the deadline has already moved). */
  onSuspend?: (gapMs: number) => void;
  tickMs?: number;
  thresholdMs?: number;
  now?: () => number;
}

/** Suspend-aware replacement for `setTimeout`: the deadline moves out by every detected gap. Returns a cancel fn. */
export function guardTimeout(o: GuardOptions): () => void {
  const now = o.now ?? Date.now;
  const tickMs = o.tickMs ?? Math.min(15_000, Math.max(50, Math.floor(o.timeoutMs / 4)));
  const gaps = new GapDetector(now(), tickMs, o.thresholdMs);
  let deadlineAt = now() + o.timeoutMs;
  const timer = setInterval(() => {
    const t = now();
    const gap = gaps.sample(t);
    if (gap > 0) {
      deadlineAt += gap;
      o.onSuspend?.(gap);
    }
    if (t >= deadlineAt) {
      clearInterval(timer);
      o.onTimeout();
    }
  }, tickMs);
  return () => clearInterval(timer);
}
