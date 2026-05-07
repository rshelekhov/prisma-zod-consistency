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
import { getRule } from "./rules/index.js";
import { type RunResult, run } from "./runner.js";
import type { Rule, RuleId } from "./types.js";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("prisma-zod-consistency")
  .description("Consistency checks for Prisma + Zod + TypeScript stacks.")
  .version(VERSION);

program
  .command("check", { isDefault: true })
  .description("Run consistency checks against the current project.")
  .option("--cwd <path>", "Project root (defaults to process.cwd())")
  .option("--rules <ids>", "Comma-separated rule ids to run (e.g. R01,R02)")
  .option(
    "--output <format>",
    "Output format: pretty | json | sarif (SARIF 2.1.0 for GitHub Code Scanning)",
    "pretty",
  )
  .option("--db", "Enable Group B rules (R07/R08/R09) by snapshotting the live DB.", false)
  .option("--database-url <url>", "Override DATABASE_URL for --db.")
  .action(
    async (opts: {
      cwd?: string;
      rules?: string;
      output: string;
      db?: boolean;
      databaseUrl?: string;
    }) => {
      try {
        const ruleIds = opts.rules
          ? (opts.rules.split(",").map((s) => s.trim()) as RuleId[])
          : undefined;

        const result = await run({
          cwd: opts.cwd,
          rules: ruleIds,
          db: opts.db,
          databaseUrl: opts.databaseUrl,
        });

        // Surface adapter-level warnings (e.g. R08 skipped because the
        // provider can't deliver index usage stats) before the report.
        // These appear regardless of output format — the human watching
        // stderr wants them, machine consumers (json/sarif on stdout) are
        // unaffected.
        for (const w of result.warnings) {
          process.stderr.write(`warning: ${w}\n`);
        }

        if (result.skippedRules.length > 0 && opts.output === "pretty") {
          process.stderr.write(
            `note: skipped unregistered or unsatisfied rule(s): ${result.skippedRules.join(", ")}\n`,
          );
        }

        const out = renderOutput(opts.output, result);
        process.stdout.write(`${out}\n`);

        const hasErrors = result.findings.some((f) => f.severity === "error");

        // Nit #2 (0.9.0): "lint did not run" leaky bucket. When R01/R03/R04
        // were requested but the include glob captured zero Zod schemas in a
        // project that does have Prisma models, the run is technically clean
        // but only because nothing got compared. Fail with exit=2 (bad
        // invocation) so CI surfaces the misconfig instead of merging green.
        // To opt out, disable the static rules in config:
        //   { "rules": { "R01": { "severity": "off" }, ... } }
        const lintDidNotRun =
          result.summary !== undefined &&
          result.summary.zodSchemaCount === 0 &&
          result.summary.prismaModelCount > 0;

        if (lintDidNotRun) {
          process.exit(2);
        }
        process.exit(hasErrors ? 1 : 0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`prisma-zod-consistency: ${message}\n`);
        process.exit(2);
      }
    },
  );

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
        process.stdout.write(`${formatDiff(report.files, opts.cwd)}\n`);
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

function renderOutput(format: string, result: RunResult): string {
  switch (format) {
    case "json":
      return formatJson(result.findings);
    case "sarif": {
      const rules = result.ranRules
        .map((id) => getRule(id))
        .filter((r): r is Rule => r !== undefined);
      return formatSarif(result.findings, { rootDir: result.rootDir, rules });
    }
    default:
      return formatPretty(result.findings, undefined, result.summary);
  }
}
