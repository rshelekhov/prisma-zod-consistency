/**
 * Orchestrates a single CLI run: load config → discover project → run rules → return findings.
 */

import { loadConfig, type RuleConfig } from "./config.js";
import { discover } from "./discovery.js";
import { allRules, getRule } from "./rules/index.js";
import type { Finding, Rule, RuleId, Severity } from "./types.js";

export interface RunOptions {
  cwd?: string;
  /** Subset of rule ids to run; if undefined, runs every registered rule. */
  rules?: RuleId[];
}

export interface RunResult {
  findings: Finding[];
  ranRules: RuleId[];
  skippedRules: RuleId[];
}

export async function run(options: RunOptions = {}): Promise<RunResult> {
  const config = await loadConfig(options.cwd);
  const ctx = await discover(config);

  const requested = options.rules ?? allRules().map((r) => r.id);
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
