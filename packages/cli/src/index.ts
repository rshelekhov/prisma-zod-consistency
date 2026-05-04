#!/usr/bin/env node
/**
 * prisma-zod-consistency / pz-check — CLI entrypoint.
 */

import { Command } from "commander";
import pc from "picocolors";
import { applyFixes } from "./fix/apply.js";
import { formatDiff } from "./fix/diff.js";
import { formatJson } from "./output/json.js";
import { formatPretty } from "./output/pretty.js";
import { formatSarif } from "./output/sarif.js";
import { run } from "./runner.js";
import type { Finding, RuleId } from "./types.js";

const program = new Command();

program
  .name("prisma-zod-consistency")
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
      process.stderr.write(`prisma-zod-consistency: ${message}\n`);
      process.exit(2);
    }
  });

program
  .command("fix")
  .description("Apply mechanical fixes for findings that ship a safe codemod (R01 / R03 subsets).")
  .option("--cwd <path>", "Project root (defaults to process.cwd())")
  .option("--rules <ids>", "Comma-separated rule ids to run (e.g. R01,R03)")
  .option("--apply", "Write changes to disk. Without it, prints a dry-run diff and exits 0.", false)
  .action(async (opts: { cwd?: string; rules?: string; apply?: boolean }) => {
    try {
      const ruleIds = opts.rules
        ? (opts.rules.split(",").map((s) => s.trim()) as RuleId[])
        : undefined;

      const { findings } = await run({ cwd: opts.cwd, rules: ruleIds });
      const fixable = findings.filter((f) => f.fix !== undefined);

      if (fixable.length === 0) {
        process.stdout.write(pc.green("✓ no auto-fixable findings\n"));
        process.exit(0);
      }

      const report = await applyFixes(fixable, { write: Boolean(opts.apply) });

      if (opts.apply) {
        process.stdout.write(
          `${report.totalEditsApplied} edit(s) applied across ${report.files.filter((f) => f.applied > 0).length} file(s).\n`,
        );
        if (report.totalEditsSkipped > 0) {
          process.stdout.write(
            pc.yellow(`${report.totalEditsSkipped} edit(s) skipped due to overlap.\n`),
          );
        }
      } else {
        process.stdout.write(formatDiff(report.files, opts.cwd) + "\n");
        process.stdout.write(
          pc.dim(
            `${report.totalEditsApplied} edit(s) would be applied across ${report.files.filter((f) => f.applied > 0).length} file(s). Run with --apply to write them.\n`,
          ),
        );
      }

      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`prisma-zod-consistency: ${message}\n`);
      process.exit(2);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`prisma-zod-consistency: ${message}\n`);
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
