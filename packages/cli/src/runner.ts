/**
 * Orchestrates a single CLI run: load config → discover project → run rules → return findings.
 */

import { type ResolvedConfig, type RuleConfig, loadConfig } from "./config.js";
import { isDbProviderSupported, snapshotDatabase } from "./db/index.js";
import { discover } from "./discovery.js";
import { DB_RULES, allRules, getRule } from "./rules/index.js";
import { parsePrismaRegistry } from "./schema/prisma-models.js";
import { clearSuppressionCache, getSuppressionMap } from "./suppression.js";
import type { Finding, ProjectContext, Rule, RuleId, Severity } from "./types.js";
import { discoverZodSchemas } from "./zod/discover.js";
import { matchSchemasToModels } from "./zod/match.js";

export interface RunOptions {
  cwd?: string;
  /** Subset of rule ids to run; if undefined, runs every registered rule. */
  rules?: RuleId[];
  /**
   * When true, fetch a live DB snapshot (via DATABASE_URL) for Group B rules.
   * Without it, R07/R08/R09 are silently skipped.
   */
  db?: boolean;
  /** Override DATABASE_URL. Falls back to process.env.DATABASE_URL. */
  databaseUrl?: string;
}

/**
 * Why a requested rule wasn't run. The CLI surfaces these three reasons
 * differently to avoid the 0.9.0 nit where typos and "needs --db" looked
 * identical in stderr ("note: skipped unregistered or unsatisfied …"):
 *
 * - `"unknown"` — id isn't in the registry. Most likely a typo or a rule
 *   from a future version. CLI should fail with exit=2 (bad invocation)
 *   so a `--rules R99` in CI doesn't pass silently.
 * - `"needs-db"` — id is a live-DB rule (R07-R09d), but `--db` wasn't
 *   passed. Normal case for the static default run; CLI surfaces it as
 *   `info:` so the user knows what they could opt into.
 * - `"disabled"` — id is in the registry but the user explicitly set
 *   `severity: "off"` in `.prismazodrc.json`. CLI stays silent; the
 *   user already knows.
 */
export type SkippedRuleReason = "unknown" | "needs-db" | "disabled";

export interface SkippedRule {
  id: string;
  reason: SkippedRuleReason;
}

export interface RunResult {
  findings: Finding[];
  ranRules: RuleId[];
  /**
   * Rules that were requested but didn't run, with the reason for each.
   * Shape changed in 0.10.1: was `RuleId[]`, now structured so the CLI
   * can give the user actionable feedback per reason. Pre-1.0 breaking
   * change in the runner API surface (CLI is the only known consumer).
   */
  skippedRules: SkippedRule[];
  /** Project root used by output formatters that need to relativize paths (SARIF). */
  rootDir: string;
  /**
   * Diagnostic messages the runner wants the CLI to surface on stderr — for
   * example, "R08 was requested but the provider doesn't track index usage".
   * These are not findings: they don't appear in JSON/SARIF output, they're
   * meant for the human reading the terminal.
   */
  warnings: string[];
  /**
   * Discovery-level counts (UX bug #5, 0.8.0). Populated when at least one
   * static Zod-aware rule (R01/R03/R04) ran, so the CLI's pretty output
   * can disambiguate "tool worked, project was clean" from "tool didn't
   * see what it expected" — the latter case used to surface as the same
   * `✓ no findings` regardless of cause.
   */
  summary?: RunSummary;
}

export interface RunSummary {
  /** Number of Prisma models in the schema. */
  prismaModelCount: number;
  /** Number of object-shaped Zod schemas R01/R03/R04 considered. */
  zodSchemaCount: number;
  /** Subset of `zodSchemaCount` that matched a Prisma model after name normalization. */
  matchedSchemaCount: number;
  /** Naming prefixes the matcher applied (default `["Z"]`). */
  namingPrefixes: readonly string[];
  /**
   * Effective `include` glob patterns the discovery layer used. Surfaced so
   * the pretty formatter can quote them back at the user when no Zod files
   * matched — most common monorepo first-run pitfall (Nit #2, 0.9.0).
   *
   * Optional for backwards compatibility with existing tests that build
   * `RunSummary` literals; absent → formatter falls back to "(default)".
   */
  includePaths?: readonly string[];
}

export async function run(options: RunOptions = {}): Promise<RunResult> {
  const config = await loadConfig(options.cwd);
  const ctx: ProjectContext = await discover(config);

  const requested = options.rules ?? allRules().map((r) => r.id);
  const wantsDbRule = requested.some((id) => DB_RULES.has(id));

  const warnings: string[] = [];

  if (options.db && wantsDbRule) {
    const url = options.databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DB rules requested but no DATABASE_URL is set. Pass --database-url or export DATABASE_URL.",
      );
    }
    if (!isDbProviderSupported(ctx.provider)) {
      throw new Error(
        `Group B rules support postgresql / mysql / sqlite; this project's provider is ${ctx.provider}. Skip --db, or run the rules from a project on a supported engine.`,
      );
    }
    ctx.db = await snapshotDatabase(ctx.provider, { url });

    // Emit a one-shot warning when the user explicitly asked for R08 but the
    // provider can't deliver index-usage stats. R08 still silently skips
    // (returning [] below); the warning is purely so the user understands
    // why nothing was reported. Don't warn if R08 wasn't requested at all.
    if (requested.includes("R08") && !ctx.db.capabilities.indexUsageTracking) {
      warnings.push(
        `R08 (unused indexes) was requested but ${ctx.provider} does not expose index-usage statistics in a usable form for this database. R08 will be skipped. ${
          ctx.provider === "mysql"
            ? "Enable performance_schema (MySQL default in 5.7+) to make R08 available."
            : "SQLite does not track index usage; this is a permanent provider limitation."
        }`,
      );
    }

    // Same shape for R09b: when explicitly requested but the provider's type
    // metadata isn't precise enough for type-drift comparison, warn once.
    if (requested.includes("R09b") && !ctx.db.capabilities.typeDriftAccurate) {
      warnings.push(
        `R09b (type drift) was requested but ${ctx.provider} reports column types via affinity, not declared length/precision — drift comparison would produce noise. R09b will be skipped on this provider.`,
      );
    }
  }

  const findings: Finding[] = [];
  const ran: RuleId[] = [];
  const skipped: SkippedRule[] = [];

  // Capture the effective `include` so `maybeBuildSummary` can echo it back
  // to the user via `RunSummary.includePaths` when no Zod files matched.
  // We have to reach back to config here because `ctx.sourceFiles` already
  // resolved the glob into file paths; the patterns themselves don't survive.
  const includePaths = config.include;

  for (const id of requested) {
    const rule = getRule(id);
    if (!rule) {
      skipped.push({ id, reason: "unknown" });
      continue;
    }
    const ruleConfig = config.rules[id] ?? {};
    if (ruleConfig.severity === "off") {
      skipped.push({ id, reason: "disabled" });
      continue;
    }
    if (DB_RULES.has(id) && !ctx.db) {
      // Live-DB rules without --db: surfaced as `needs-db` so the CLI can
      // tell the user about the opt-in instead of conflating it with typos.
      skipped.push({ id, reason: "needs-db" });
      continue;
    }
    const severity = resolveSeverity(rule, ruleConfig);
    const result = await rule.run(ctx, {
      severity,
      config: stripFrameworkKeys(ruleConfig),
    });
    findings.push(...result);
    ran.push(id);
  }

  const filtered = await applySuppressions(findings, config);

  const summary = await maybeBuildSummary(ctx, ran, includePaths);

  return {
    findings: filtered,
    ranRules: ran,
    skippedRules: skipped,
    rootDir: ctx.rootDir,
    warnings,
    ...(summary ? { summary } : {}),
  };
}

/**
 * Static Zod-aware rules whose presence justifies emitting a discovery
 * summary at the end of the run. R02 (relations only), R05 (server-action
 * scan), and the live-DB family don't tell the user anything new about
 * Prisma↔Zod coverage, so we don't bother with the extra ts-morph pass
 * when only those ran.
 */
const SUMMARY_RULES: ReadonlySet<RuleId> = new Set<RuleId>(["R01", "R03", "R04"]);

async function maybeBuildSummary(
  ctx: ProjectContext,
  ran: RuleId[],
  includePaths: readonly string[],
): Promise<RunSummary | undefined> {
  if (!ran.some((id) => SUMMARY_RULES.has(id))) return undefined;

  // The cost of this is one extra Prisma parse plus a single ts-morph pass
  // over the source files — measured in single-digit seconds even on
  // dub-sized projects. Worth it for the clarity boost on retention-critical
  // first-run paths.
  const registry = parsePrismaRegistry(ctx.schemaSource);
  const zodSchemas = await discoverZodSchemas(ctx.sourceFiles);
  const objectSchemas = zodSchemas.filter((s) => s.shape.kind === "object");
  const matches = matchSchemasToModels(objectSchemas, registry, ctx.namingPrefixes);

  return {
    prismaModelCount: registry.models.size,
    zodSchemaCount: objectSchemas.length,
    matchedSchemaCount: matches.length,
    namingPrefixes: ctx.namingPrefixes,
    includePaths,
  };
}

/**
 * Rules whose findings live in TS/TSX files and therefore go through the
 * comment-based suppression parser. Rules outside this set are returned
 * unchanged:
 *   - R02 reports on schema.prisma; Prisma's comment syntax differs and is
 *     handled by a separate parser (deferred — see post-mvp-roadmap A4).
 *   - R07/R08/R09 are live-DB findings with `location.file = "<live-db>"`,
 *     not anchored to a source file.
 *   - R06/R10/R11 are skill-only and don't reach the runner.
 */
const SUPPRESSION_SCOPE: ReadonlySet<RuleId> = new Set<RuleId>(["R01", "R03", "R04", "R05"]);

async function applySuppressions(findings: Finding[], config: ResolvedConfig): Promise<Finding[]> {
  // Suppression maps live in a process-wide cache; clear between runs so
  // a long-lived embedder (e.g. tests, watch mode) doesn't see stale entries
  // when files change on disk.
  clearSuppressionCache();

  const survivors: Finding[] = [];
  for (const f of findings) {
    if (!SUPPRESSION_SCOPE.has(f.ruleId)) {
      survivors.push(f);
      continue;
    }
    if (f.location.file === "<live-db>") {
      // Belt-and-braces: in-scope rules don't currently emit live-db
      // findings, but if that ever changes we don't want to crash trying
      // to read "<live-db>" off disk.
      survivors.push(f);
      continue;
    }
    // Per-rule opt-out: R0X.suppressionsEnabled = false → ignore comments,
    // always report. Lets users hard-gate a rule for compliance reasons.
    const ruleCfg = config.rules[f.ruleId];
    if (ruleCfg?.suppressionsEnabled === false) {
      survivors.push(f);
      continue;
    }

    const map = await getSuppressionMap(f.location.file);
    if (!map.isSuppressed(f.location.line, f.ruleId)) {
      survivors.push(f);
    }
  }
  clearSuppressionCache();
  return survivors;
}

function resolveSeverity(rule: Rule, ruleConfig: RuleConfig): Severity {
  const requested = ruleConfig.severity;
  if (requested === undefined || requested === "off") return rule.defaultSeverity;
  return requested;
}

function stripFrameworkKeys(ruleConfig: RuleConfig): Record<string, unknown> {
  const { severity, ...rest } = ruleConfig;
  void severity;
  return rest;
}
