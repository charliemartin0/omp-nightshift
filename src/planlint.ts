import type { Chunk } from "./backlog";

export interface LintFinding { id: string; reasons: string[]; paths: string[] }

const PATH_RE = /(?:[\w.@-]+\/)*[\w.@-]+\.(?:tsx?|jsx?|mjs|cjs|cs|csproj|props|json|ya?ml|css|scss|sql|py|go|rs|razor|cshtml|html)\b/g;
const TESTISH = [
  /(?:^|[./_-])(?:test|tests|spec|specs|stories)\.[a-z]+$/i,
  /(?:^|\/)(?:tests?|__tests__|__mocks__|e2e|specs?|fixtures?|testdata|test-utils)\//i,
  /Tests?\.cs$/,
  /(?:^|\/)[\w.]+\.(?:Tests?|IntegrationTests|UnitTests|E2E)(?:\/|\.csproj$)/,
  /(?:^|\/)(?:playwright|vitest|jest)\.config\.[a-z]+$/i,
];
/** Scope phrases that usually mean editing production code or shared config. */
const PROD_PHRASES = /\b(?:fix(?:es|ing)? (?:a |the )?(?:prod(?:uction)? )?bug|production (?:code|fix|bug|change)|prod code|aria-labels?|seed(?:er|ing)?|migrations?|endpoints?|refactor(?:ing)?|rename (?:the )?(?:symbol|method|class|type)|lint baseline|tsconfig|eslint config|eslintrc|query change|component (?:change|fix)|generated (?:api )?client|duplicate exports?)\b/i;
/** Proof commands whose fixes land in production files rather than tests. */
const PROD_PROOF = /\b(?:eslint|tsc|typecheck|type-check|lint|dotnet build|dotnet format|analy[sz]ers?)\b/i;

/** A proof that also runs tests is about those tests, not a lint sweep. */
const TEST_RUNNER = /\b(?:test|tests|vitest|jest|playwright|cypress|e2e|spec)\b/i;

/** Minimal glob: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`(?:^|/)${re}$`);
}

export const isTestPath = (p: string): boolean => TESTISH.some((re) => re.test(p));

/**
 * Plan-time lint: pending `prod-code: no` chunks whose scope, done-when or proof command suggest production-code
 * edits that the chunk is not allowed to make (so it would block overnight waiting for approval). `allow:` globs
 * cover approved paths.
 */
export function lintBacklog(chunks: Chunk[]): LintFinding[] {
  const out: LintFinding[] = [];
  for (const c of chunks) {
    if (c.status !== "pending" || c.prodCode) continue;
    const allow = c.allow.map(globToRegExp);
    const text = `${c.scope}\n${c.doneWhen}`;
    const paths = [...new Set(text.match(PATH_RE) ?? [])].filter((p) => !isTestPath(p) && !allow.some((re) => re.test(p)));
    const reasons: string[] = [];
    if (paths.length) reasons.push(`mentions non-test file(s): ${paths.join(", ")}`);
    const phrase = PROD_PHRASES.exec(text)?.[0];
    if (phrase && !c.allow.length) reasons.push(`scope mentions "${phrase}"`);
    if (PROD_PROOF.test(c.test) && !TEST_RUNNER.test(c.test) && !c.allow.length) reasons.push(`proof command (${c.test.slice(0, 80)}) is only a lint/type/analyzer check, whose fixes usually edit production files`);
    if (reasons.length) out.push({ id: c.id, reasons, paths });
  }
  return out;
}

export function lintText(findings: LintFinding[]): string {
  if (!findings.length) return "plan lint: no prod-code: no chunk looks like it needs production changes";
  return [
    `plan lint: ${findings.length} chunk(s) may need production-code approval; approve now with \`prod-code: yes\` or \`allow: <globs>\`, or they may block overnight:`,
    ...findings.map((f) => `  - ${f.id}: ${f.reasons.join("; ")}${f.paths.length ? ` (e.g. \`- allow: ${f.paths.join(", ")}\`)` : ""}`),
  ].join("\n");
}