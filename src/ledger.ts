import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LedgerEntry {
  ts: string;
  event: string;
  chunk?: string;
  [k: string]: unknown;
}

/** One-line human summary: `HH:MM:SS event chunk key=value ...` (values truncated). */
export function summarize(e: LedgerEntry): string {
  const { ts, event, chunk, ...rest } = e;
  const t = new Date(ts);
  const hms = Number.isNaN(t.getTime()) ? ts : t.toTimeString().slice(0, 8);
  const fields = Object.entries(rest).map(([k, v]) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}=${s.length > 100 ? `${s.slice(0, 100)}…` : s}`;
  });
  return [hms, event, chunk, ...fields].filter((p) => p !== undefined && p !== "").join(" ");
}

export class Ledger {
  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  /** Append one JSON line and echo a summary to stdout (so `journalctl -fu <unit>` shows progress). */
  log(event: string, fields: Record<string, unknown> = {}): void {
    const entry: LedgerEntry = { ts: new Date().toISOString(), event, ...fields };
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    console.log(summarize(entry));
  }
}

export function readLedger(file: string): LedgerEntry[] {
  if (!existsSync(file)) return [];
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {
      /* ignore a torn line */
    }
  }
  return out;
}
