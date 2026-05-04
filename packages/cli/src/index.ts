#!/usr/bin/env node
/**
 * pz-check — CLI entrypoint for prisma-zod-consistency.
 */

import { Command } from "commander";
import { formatJson } from "./output/json.js";
import { formatPretty } from "./output/pretty.js";
import { formatSarif } from "./output/sarif.js";
import { run } from "./runner.js";
import type { Finding, RuleId } from "./types.js";

const program = new Command();

program
  .name("pz-check")
  .description("Consistency checks for Prisma + Zod + TypeScript stacks.")
  .version("0.0.0");

program
  .command("check", { isDefault: true })
  .description("Run consistency checks against the current project.")
  .option("--cwd <path>", "Project root (defaults to process.cwd())")
  .option("--rules <ids>", "Comma-separated rule ids to run (e.g. R01,R02)")
  .option(
    "--output <format>",
    "Output format: pretty | json | sarif (sarif is Phase 2 placeholder)",
    "pretty",
  )
  .action(async (opts: { cwd?: string; rules?: string; output: string }) => {
    try {
      const ruleIds = opts.rules
        ? (opts.rules.split(",").map((s) => s.trim()) as RuleId[])
        : undefined;

      const { findings, skippedRules } = await run({
        cwd: opts.cwd,
        rules: ruleIds,
      });

      if (skippedRules.length > 0 && opts.output === "pretty") {
        process.stderr.write(
          `note: skipped unregistered rule(s): ${skippedRules.join(", ")}\n`,
        );
      }

      const out = renderOutput(opts.output, findings);
      process.stdout.write(out + "\n");

      const hasErrors = findings.some((f) => f.severity === "error");
      process.exit(hasErrors ? 1 : 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pz-check: ${message}\n`);
      process.exit(2);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`pz-check: ${message}\n`);
  process.exit(2);
});

function renderOutput(format: string, findings: Finding[]): string {
  switch (format) {
    case "json":
      return formatJson(findings);
    case "sarif":
      return formatSarif(findings);
    case "pretty":
    default:
      return formatPretty(findings);
  }
}
