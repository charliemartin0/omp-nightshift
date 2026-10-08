import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { errMsg } from "./proc";

export type Forge = "graphite" | "github" | "local";
export interface Limits {
  maxTime: string;
  resumeMaxTime: string;
  stallMinutes: number;
  tokenCap: number;
  testTimeoutMinutes: number;
}
export interface RunJson {
  version: 1;
  repo: string;
  repoName: string;
  date: string;
  goal: string;
  runDir: string;
  worktreeRoot: string;
  unit: string;
  remote: string;
  trunk: string;
  forge: Forge;
  prMode: "independent" | "stack";
  stopAt: string;
  maxPrs: number;
  floors: Record<string, number>;
  /** omp's `retry.usageReservePct` for the run overlay (percent left below which omp switches models) */
  reservePct: number;
  models: { plan: string; build: string; report: string };
  setupCommand: string;
  preflightTest: string;
  limits: Limits;
}

export const RESERVE_PCT_DEFAULT = 40;

export const LIMIT_DEFAULTS: Limits = {
  maxTime: "90m",
  resumeMaxTime: "45m",
  stallMinutes: 10,
  tokenCap: 3_000_000,
  testTimeoutMinutes: 20,
};

const TOP_KEYS = [
  "version", "repo", "repoName", "date", "goal", "runDir", "worktreeRoot", "unit", "remote", "trunk", "forge",
  "prMode", "stopAt", "maxPrs", "floors", "reservePct", "models", "setupCommand", "preflightTest", "limits",
];
const OPTIONAL_KEYS = ["reservePct"];
const MODEL_KEYS = ["plan", "build", "report"];

export function sanitizeRepoName(name: string): string {
  return name.replace(/[^A-Za-z0-9-]/g, "-");
}

export function parseDuration(s: string): number {
  const m = /^(\d+)([smh])$/.exec(s);
  if (!m) throw new Error(`invalid duration "${s}" (expected e.g. 90m, 45s, 2h)`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
}

/** Next occurrence of local HH:MM strictly after `from`. */
export function resolveStopAt(hhmm: string, from: Date = new Date()): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`run.json: ${where} must be an object`);
  return v as Record<string, unknown>;
}

function noUnknown(o: Record<string, unknown>, allowed: string[], where: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`run.json: unknown key(s) in ${where}: ${extra.join(", ")}`);
}

function str(o: Record<string, unknown>, k: string, re?: RegExp, allowEmpty = false): string {
  const v = o[k];
  if (typeof v !== "string" || (!allowEmpty && v.trim() === "")) throw new Error(`run.json: ${k} must be a non-empty string`);
  if (re && !re.test(v)) throw new Error(`run.json: ${k} "${v}" does not match ${re}`);
  return v;
}

function num(v: unknown, where: string, min: number, max = Infinity, int = false): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
    throw new Error(`run.json: ${where} must be ${int ? "an integer" : "a number"} in [${min}, ${max}]`);
  }
  return v;
}

function absPath(o: Record<string, unknown>, k: string): string {
  const v = str(o, k);
  if (!isAbsolute(v)) throw new Error(`run.json: ${k} must be an absolute path`);
  return v;
}

export function validateRunJson(x: unknown): RunJson {
  const o = obj(x, "root");
  noUnknown(o, TOP_KEYS, "root");
  for (const k of TOP_KEYS) if (!(k in o) && !OPTIONAL_KEYS.includes(k)) throw new Error(`run.json: missing key ${k}`);
  if (o.version !== 1) throw new Error("run.json: version must be 1");

  const repo = absPath(o, "repo");
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new Error(`run.json: repo ${repo} is not a directory`);
  const forge = str(o, "forge", /^(graphite|github|local)$/) as Forge;
  const prMode = str(o, "prMode", /^(independent|stack)$/) as RunJson["prMode"];

  const floorsIn = obj(o.floors, "floors");
  const floors: Record<string, number> = {};
  for (const [k, v] of Object.entries(floorsIn)) floors[k] = num(v, `floors.${k}`, 0, 1);

  const modelsIn = obj(o.models, "models");
  noUnknown(modelsIn, MODEL_KEYS, "models");
  const models = { plan: str(modelsIn, "plan"), build: str(modelsIn, "build"), report: str(modelsIn, "report") };

  const limitsIn = obj(o.limits, "limits");
  noUnknown(limitsIn, Object.keys(LIMIT_DEFAULTS), "limits");
  const l = { ...LIMIT_DEFAULTS, ...limitsIn } as Limits;
  parseDuration(String(l.maxTime));
  parseDuration(String(l.resumeMaxTime));
  num(l.stallMinutes, "limits.stallMinutes", 1);
  num(l.tokenCap, "limits.tokenCap", 1, Infinity, true);
  num(l.testTimeoutMinutes, "limits.testTimeoutMinutes", 1);

  return {
    version: 1,
    repo,
    repoName: str(o, "repoName", /^[A-Za-z0-9-]+$/),
    date: str(o, "date", /^\d{4}-\d{2}-\d{2}$/),
    goal: str(o, "goal"),
    runDir: absPath(o, "runDir"),
    worktreeRoot: absPath(o, "worktreeRoot"),
    unit: str(o, "unit", /^omp-overnight-[A-Za-z0-9-]+$/),
    remote: str(o, "remote", /^[A-Za-z0-9._-]+$/),
    trunk: str(o, "trunk", /^[A-Za-z0-9._/-]+$/),
    forge,
    prMode,
    stopAt: str(o, "stopAt", /^([01]\d|2[0-3]):[0-5]\d$/),
    maxPrs: num(o.maxPrs, "maxPrs", 1, Infinity, true),
    floors,
    reservePct: o.reservePct === undefined ? RESERVE_PCT_DEFAULT : num(o.reservePct, "reservePct", 0, 99, true),
    models,
    setupCommand: str(o, "setupCommand", undefined, true),
    preflightTest: str(o, "preflightTest"),
    limits: l,
  };
}

/** Load + validate; also checks that the file lives in its own runDir. */
export function loadRunJson(path: string): RunJson {
  const abs = resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(`run.json: cannot read ${abs}: ${errMsg(e)}`);
  }
  const run = validateRunJson(raw);
  if (!existsSync(run.runDir) || realpathSync(run.runDir) !== realpathSync(dirname(abs))) {
    throw new Error(`run.json: runDir ${run.runDir} is not the directory containing ${abs}`);
  }
  return run;
}
