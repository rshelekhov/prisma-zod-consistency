/**
 * Orchestrates a single CLI run: load config → discover project → run rules → return findings.
 */

import { loadConfig, type RuleConfig } from "./config.js";
import { snapshotDatabase } from "./db/postgres.js";
import { discover } from "./discovery.js";
import { allRules, DB_RULES, getRule } from "./rules/index.js";
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
}

export async function run(options: RunOptions = {}): Promise<RunResult> {
  const config = await loadConfig(options.cwd);
  const ctx: ProjectContext = await discover(config);

  const requested = options.rules ?? allRules().map((r) => r.id);
  const wantsDbRule = requested.some((id) => DB_RULES.has(id));

  if (options.db && wantsDbRule) {
    const url = options.databaseUrl ?? process.env["DATABASE_URL"];
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

  return { findings, ranRules: ran, skippedRules: skipped };
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
