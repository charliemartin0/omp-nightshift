export type Status =
  | "pending" | "running" | "passed" | "flaky" | "failed" | "blocked" | "skipped" | "stopped";

export interface Chunk {
  id: string;
  status: Status;
  scope: string;
  doneWhen: string;
  test: string;
  prodCode: boolean;
  note: string;
}

const STATUSES: readonly string[] = [
  "pending", "running", "passed", "flaky", "failed", "blocked", "skipped", "stopped",
];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const FIELD_RE = /^- ([A-Za-z0-9-]+):(.*)$/;

interface Section {
  id: string;
  start: number; // index of "## " line
  end: number; // exclusive
}

function sections(lines: string[]): Section[] {
  const out: Section[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^## (.*?)\s*$/.exec(lines[i]);
    if (!m) continue;
    if (out.length) out[out.length - 1].end = i;
    out.push({ id: m[1], start: i, end: lines.length });
  }
  return out;
}

export function parseBacklog(md: string): { goal: string; chunks: Chunk[] } {
  const lines = md.split("\n");
  const secs = sections(lines);
  const head = lines.slice(0, secs.length ? secs[0].start : lines.length);
  let goal = "";
  for (const l of head) {
    const m = /^goal:\s*(.*?)\s*$/.exec(l);
    if (m) {
      goal = m[1];
      break;
    }
  }
  const chunks: Chunk[] = [];
  const seen = new Set<string>();
  for (const s of secs) {
    if (!ID_RE.test(s.id)) throw new Error(`backlog: ${s.id}: invalid chunk id`);
    if (seen.has(s.id)) throw new Error(`backlog: ${s.id}: duplicate chunk id`);
    seen.add(s.id);
    const f: Record<string, string> = {};
    for (let i = s.start + 1; i < s.end; i++) {
      const m = FIELD_RE.exec(lines[i]);
      if (m && !(m[1] in f)) f[m[1]] = m[2].trim();
    }
    for (const k of ["status", "scope", "done-when", "test"]) {
      if (!f[k]) throw new Error(`backlog: ${s.id}: missing field ${k}`);
    }
    if (!STATUSES.includes(f.status)) throw new Error(`backlog: ${s.id}: invalid status ${f.status}`);
    const prod = f["prod-code"] || "no";
    if (prod !== "yes" && prod !== "no") throw new Error(`backlog: ${s.id}: invalid prod-code ${prod}`);
    let test = f.test;
    if (test.length >= 2 && test.startsWith("`") && test.endsWith("`")) test = test.slice(1, -1).trim();
    if (!test) throw new Error(`backlog: ${s.id}: missing field test`);
    chunks.push({
      id: s.id,
      status: f.status as Status,
      scope: f.scope,
      doneWhen: f["done-when"],
      test,
      prodCode: prod === "yes",
      note: f.note ?? "",
    });
  }
  if (!chunks.length) throw new Error("backlog: no chunks");
  return { goal, chunks };
}

export function setChunkStatus(md: string, id: string, status: Status, note: string): string {
  const lines = md.split("\n");
  const sec = sections(lines).find((s) => s.id === id);
  if (!sec) throw new Error(`backlog: ${id}: no such chunk`);
  let statusIdx = -1;
  let noteIdx = -1;
  for (let i = sec.start + 1; i < sec.end; i++) {
    const m = FIELD_RE.exec(lines[i]);
    if (!m) continue;
    if (m[1] === "status" && statusIdx < 0) statusIdx = i;
    if (m[1] === "note" && noteIdx < 0) noteIdx = i;
  }
  if (statusIdx < 0) throw new Error(`backlog: ${id}: missing field status`);
  const noteLine = note ? `- note: ${note}` : "- note:";
  lines[statusIdx] = `- status: ${status}`;
  if (noteIdx >= 0) lines[noteIdx] = noteLine;
  else lines.splice(statusIdx + 1, 0, noteLine);
  return lines.join("\n");
}
