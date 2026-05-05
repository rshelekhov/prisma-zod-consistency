/**
 * Orchestrates a single CLI run: load config → discover project → run rules → return findings.
 */

import { type ResolvedConfig, type RuleConfig, loadConfig } from "./config.js";
import { snapshotDatabase } from "./db/postgres.js";
import { discover } from "./discovery.js";
import { DB_RULES, allRules, getRule } from "./rules/index.js";
import { clearSuppressionCache, getSuppressionMap } from "./suppression.js";
import type { Finding, ProjectContext, Rule, RuleId, Severity } from "./types.js";

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

export interface RunResult {
  findings: Finding[];
  ranRules: RuleId[];
  skippedRules: RuleId[];
  /** Project root used by output formatters that need to relativize paths (SARIF). */
  rootDir: string;
}

export async function run(options: RunOptions = {}): Promise<RunResult> {
  const config = await loadConfig(options.cwd);
  const ctx: ProjectContext = await discover(config);

  const requested = options.rules ?? allRules().map((r) => r.id);
  const wantsDbRule = requested.some((id) => DB_RULES.has(id));

  if (options.db && wantsDbRule) {
    const url = options.databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DB rules requested but no DATABASE_URL is set. Pass --database-url or export DATABASE_URL.",
      );
    }
    if (ctx.provider !== "postgresql") {
      throw new Error(
        `DB rules currently only support Postgres; this project's provider is ${ctx.provider}.`,
      );
    }
    ctx.db = await snapshotDatabase({ url });
  }

  const findings: Finding[] = [];
  const ran: RuleId[] = [];
  const skipped: RuleId[] = [];

  for (const id of requested) {
    const rule = getRule(id);
    if (!rule) {
      skipped.push(id);
      continue;
    }
    const ruleConfig = config.rules[id] ?? {};
    if (ruleConfig.severity === "off") {
      skipped.push(id);
      continue;
    }
    if (DB_RULES.has(id) && !ctx.db) {
      // Silently skip DB rules when no snapshot is available.
      skipped.push(id);
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

  return {
    findings: filtered,
    ranRules: ran,
    skippedRules: skipped,
    rootDir: ctx.rootDir,
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
