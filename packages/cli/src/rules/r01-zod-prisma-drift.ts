/**
 * R01 — Zod ↔ Prisma field drift.
 *
 * Three sub-modes, dispatched per-schema (not per-project) by
 * `classifySchema`:
 *
 *   - R01a: hand-written `z.object({...})` → compare to Prisma model.
 *   - R01b: schema declared inside the generator `outputDir` → sanity-check
 *     generator config against Prisma.
 *   - R01c: derived chain (`SomeSchema.passthrough()`, `.partial()`, etc.)
 *     where `SomeSchema` resolves into `outputDir` → weakening check.
 *
 * Background on the per-schema dispatch design (vs picking a single mode
 * for the whole project) lives in
 * `project_r01_dispatch_design.md` and is summarized in the rule spec.
 *
 * See: packages/checks/rules/R01-zod-prisma-field-drift.md
 */

import { dirname, isAbsolute, resolve } from "node:path";
import {
  type FieldInfo,
  type PrismaModelRegistry,
  parsePrismaRegistry,
} from "../schema/prisma-models.js";
import type { Finding, ProjectContext, Rule, RuleOptions } from "../types.js";
import { classifySchema } from "../zod/classify.js";
import {
  type DriftDirection,
  type LooseMaxIssue,
  type MissingIntIssue,
  type MissingMaxIssue,
  type SchemaIssue,
  compareModelToSchemaShape,
} from "../zod/compare.js";
import { type ZodSchemaInfo, discoverZodSchemas } from "../zod/discover.js";
import { loadGeneratedRegistry } from "../zod/generated-registry.js";
import { matchSchemasToModels } from "../zod/match.js";
import { detectWeakening } from "../zod/weaken.js";

/**
 * R01 directionality mode (0.8.0).
 *
 * - `"strict"` (default): every detected drift fires at the rule's normal
 *   severity. Backwards-compatible with 0.7.x.
 * - `"actionable"`: `zod-stricter` issues drop to `info` severity (intent,
 *   not bug); `zod-weaker` and `type-mismatch` keep their full severity.
 *   Recommended for marketing-rollout users — drops the false-positive
 *   noise on `z.email()`/`z.url()`/`z.array()` patterns.
 * - `"off-stricter"`: filter `zod-stricter` issues out entirely. For
 *   shops who never want to be reminded about intentional refinements.
 *
 * Switching the default to `"actionable"` is planned for 1.0.0; for now we
 * prefer not to perturb the report counts of users on green-CI 0.7.x.
 */
type R01DirectionalityMode = "strict" | "actionable" | "off-stricter";

interface R01Config {
  ignoreModels?: string[];
  directionalityMode?: R01DirectionalityMode;
}

export const r01: Rule = {
  id: "R01",
  name: "Zod ↔ Prisma field drift",
  description:
    "Detects mismatches between Zod schema fields and the corresponding Prisma model fields (type, string length, integer constraints) for hand-written, generated, and hybrid Zod setups.",
  helpUri:
    "https://github.com/rshelekhov/prisma-zod-consistency/blob/main/packages/checks/rules/R01-zod-prisma-field-drift.md",
  defaultSeverity: "error",

  async run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]> {
    const config = options.config as R01Config;
    const ignoreModels = new Set(config.ignoreModels ?? []);
    const directionalityMode: R01DirectionalityMode = config.directionalityMode ?? "strict";

    const registry = parsePrismaRegistry(ctx.schemaSource);
    // Pair each finding with its drift direction so the post-processing pass
    // can downgrade or filter `zod-stricter` issues without losing the rest.
    const tagged: Array<{ finding: Finding; direction: DriftDirection }> = [];

    const outputDirAbs = resolveOutputDir(ctx);
    const generatedRegistry =
      outputDirAbs !== undefined
        ? await loadGeneratedRegistry(ctx.zodMode, outputDirAbs, registry.models.keys())
        : undefined;

    // Discover user schemas with the generator output loaded as resolution
    // context — so derived chains can trace base identifiers across barrels.
    const generatedFiles = generatedRegistry?.files ?? [];
    const userSchemas = await discoverZodSchemas({
      files: ctx.sourceFiles,
      ...(generatedFiles.length > 0 ? { resolutionContext: generatedFiles } : {}),
      ...(outputDirAbs ? { outputDir: outputDirAbs } : {}),
    });

    // R01a / R01c — iterate user schemas, dispatch per-schema.
    const objectMatches = matchSchemasToModels(
      userSchemas.filter((s) => s.shape.kind === "object"),
      registry,
      ctx.namingPrefixes,
    );
    const modelByName = new Map(objectMatches.map((m) => [m.zod.name, m.modelName]));

    for (const schema of userSchemas) {
      const classification = classifySchema(schema, {
        ...(outputDirAbs ? { outputDir: outputDirAbs } : {}),
      });

      if (classification === "r01a") {
        const modelName = modelByName.get(schema.name);
        if (!modelName) continue;
        if (ignoreModels.has(modelName)) continue;
        const model = registry.models.get(modelName);
        if (!model) continue;
        const issues = compareModelToSchemaShape(model.fields, schema, registry);
        for (const issue of issues) {
          tagged.push({ finding: formatR01aFinding(issue, options), direction: issue.direction });
        }
      } else if (classification === "r01c") {
        if (schema.shape.kind !== "derived" || !schema.shape.origin) continue;
        const weak = detectWeakening(schema);
        for (const issue of weak) {
          // R01c findings (`.passthrough()`, `.nonstrict()`) are by definition
          // weakening of the generated origin — not refinements.
          tagged.push({
            finding: formatR01cFinding(issue, options),
            direction: "zod-weaker",
          });
        }
      }
      // r01b is handled below over generated schemas, not user schemas.
      // skip — no finding.
    }

    // R01b — iterate generated model schemas (declared inside outputDir).
    if (generatedRegistry) {
      for (const [modelName, schema] of generatedRegistry.modelSchemas) {
        if (ignoreModels.has(modelName)) continue;
        const model = registry.models.get(modelName);
        if (!model) continue;
        const issues = compareModelToSchemaShape(model.fields, schema, registry);
        for (const issue of issues) {
          tagged.push({
            finding: formatR01bFinding(issue, options, generatedRegistry.generator),
            direction: issue.direction,
          });
        }
      }
    }

    return applyDirectionalityMode(tagged, directionalityMode);
  },
};

/**
 * Post-process tagged findings according to the configured directionality
 * mode. See `R01DirectionalityMode` for semantics.
 */
function applyDirectionalityMode(
  tagged: ReadonlyArray<{ finding: Finding; direction: DriftDirection }>,
  mode: R01DirectionalityMode,
): Finding[] {
  if (mode === "strict") {
    return tagged.map((t) => t.finding);
  }
  const out: Finding[] = [];
  for (const { finding, direction } of tagged) {
    if (direction !== "zod-stricter") {
      out.push(finding);
      continue;
    }
    if (mode === "off-stricter") {
      continue; // drop entirely
    }
    // mode === "actionable": downgrade severity to info, but keep the
    // diagnostic so the user can review.
    out.push({ ...finding, severity: "info" });
  }
  return out;
}

/**
 * R01a finding: hand-written Zod drifted from Prisma. Severity from options
 * (typically `error`), and we attach `pz-fix` edits where safe.
 */
function formatR01aFinding(issue: SchemaIssue, options: RuleOptions): Finding {
  const { prismaField, zodField, zod } = issue;
  const base = {
    ruleId: "R01" as const,
    severity: options.severity,
    location: { file: zod.file, line: zodField.line },
    scope: { model: zod.name, field: prismaField.name },
  };

  switch (issue.kind) {
    case "type-mismatch":
      return {
        ...base,
        message: `Field \`${prismaField.name}\` is \`${prismaField.type}\` in Prisma but \`z.${issue.actual}()\` in \`${zod.name}\`.`,
        suggestion: `Use ${issue.expected.map((t) => `\`z.${t}()\``).join(" or ")} to match the Prisma type.`,
      };
    case "array-mismatch":
      return {
        ...base,
        message: `Field \`${prismaField.name}\` is \`${prismaField.type}[]\` in Prisma but \`z.${issue.actual}()\` in \`${zod.name}\`.`,
        suggestion: `Use \`z.array(z.${issue.expectedInner[0] ?? "unknown"}())\` to match the Prisma array type.`,
      };
    case "missing-int":
      return {
        ...base,
        message: `Field \`${prismaField.name}\` is \`Int\` in Prisma but the Zod schema in \`${zod.name}\` uses \`z.number()\` without \`.int()\`.`,
        suggestion: "Add `.int()` to the chain so non-integer numerics are rejected.",
        fix: insertEditFix(issue, `Append .int() to ${zod.name}.${prismaField.name}`, ".int()"),
      };
    case "missing-max":
      return {
        ...base,
        message: `Field \`${prismaField.name}\` is \`@db.${issue.dbKind}(${issue.dbSize})\` in Prisma; \`${zod.name}\` has no \`.max()\` to enforce that limit.`,
        suggestion: `Add \`.max(${issue.dbSize})\` to \`${zodField.name}\`.`,
        fix: insertEditFix(
          issue,
          `Append .max(${issue.dbSize}) to ${zod.name}.${prismaField.name}`,
          `.max(${issue.dbSize})`,
        ),
      };
    case "loose-max":
      return {
        ...base,
        message: `Field \`${prismaField.name}\` allows \`.max(${issue.zodMax})\` in Zod but the database is \`@db.${issue.dbKind}(${issue.dbSize})\`.`,
        suggestion: `Lower the Zod \`.max()\` to \`${issue.dbSize}\` (or relax the Prisma column).`,
        ...looseMaxFix(issue),
      };
  }
}

/**
 * R01b finding: generator output drifted from Prisma. Different message,
 * lower default severity (warning), and *no* fix attached — the user can't
 * auto-edit a regenerated file. The actionable change lives in the
 * generator config (e.g. `@zod.string.max(N)` annotation) or in the Prisma
 * schema itself; we point at both as suggestions.
 */
function formatR01bFinding(issue: SchemaIssue, options: RuleOptions, generator: string): Finding {
  const { prismaField, zodField, zod } = issue;
  // R01b severity defaults to warning when the host rule's severity is `error`,
  // because much of what we flag here is generator config (intentional
  // narrowing), not a real bug. When the user explicitly raised severity to
  // error in config, honor that.
  const severity = options.severity === "error" ? "warning" : options.severity;

  const base = {
    ruleId: "R01" as const,
    severity,
    location: { file: zod.file, line: zodField.line },
    scope: { model: zod.name, field: prismaField.name },
  };
  const generatorTag = `(${generator})`;

  switch (issue.kind) {
    case "type-mismatch":
      return {
        ...base,
        message: `Generated schema \`${zod.name}\` ${generatorTag} field \`${prismaField.name}\` is \`z.${issue.actual}()\`, but Prisma declares \`${prismaField.type}\`.`,
        suggestion: `Review your generator config (\`@zod.import\`/\`@zod.custom.*\`) — the emitted type doesn't match Prisma's \`${prismaField.type}\`.`,
      };
    case "array-mismatch":
      return {
        ...base,
        message: `Generated schema \`${zod.name}\` ${generatorTag} field \`${prismaField.name}\` is \`z.${issue.actual}()\`, but Prisma declares \`${prismaField.type}[]\`.`,
        suggestion: "Verify the generator emitted `z.array(...)` for this field.",
      };
    case "missing-int":
      return {
        ...base,
        message: `Generated schema \`${zod.name}\` ${generatorTag} field \`${prismaField.name}\` is \`z.number()\` without \`.int()\`, but Prisma declares \`Int\`.`,
        suggestion:
          "Some generators omit `.int()` by default. Check your generator config or pin to a version that emits it.",
      };
    case "missing-max":
      return {
        ...base,
        message: `Generated schema \`${zod.name}\` ${generatorTag} field \`${prismaField.name}\` has no \`.max()\`, but Prisma declares \`@db.${issue.dbKind}(${issue.dbSize})\`.`,
        suggestion: `Add a \`@zod.string.max(${issue.dbSize})\` annotation to the field in \`schema.prisma\`, or use a \`/// @zod\` import override.`,
      };
    case "loose-max":
      return {
        ...base,
        message: `Generated schema \`${zod.name}\` ${generatorTag} field \`${prismaField.name}\` has \`.max(${issue.zodMax})\`, but Prisma declares \`@db.${issue.dbKind}(${issue.dbSize})\`.`,
        suggestion: `Your \`@zod.string.max\` annotation contradicts the column size. Reconcile them — either tighten the annotation to ${issue.dbSize} or widen the column.`,
      };
  }
}

/**
 * R01c finding: derived schema weakens its generated origin.
 */
function formatR01cFinding(
  issue: ReturnType<typeof detectWeakening>[number],
  options: RuleOptions,
): Finding {
  const { zod, call } = issue;

  if (issue.kind === "passthrough") {
    return {
      ruleId: "R01",
      // `.passthrough()` on a generated origin is almost always a mistake —
      // unknown keys flow through to prisma.create(). Always error,
      // regardless of options.severity easing it elsewhere.
      severity: options.severity === "info" ? "info" : "error",
      message: `\`${zod.name}\` calls \`.passthrough()\` on \`${issue.originExportName}\`; unknown keys will flow into Prisma.`,
      location: { file: zod.file, line: lineFromCallStart(zod, call.callStart) },
      suggestion:
        "Use `.pick({...})`, `.omit({...})`, or `.extend({...})` to deliberately shape the schema. `.passthrough()` lets through any field a caller sends.",
      scope: { model: zod.name },
    };
  }

  // nonstrict
  return {
    ruleId: "R01",
    severity: options.severity,
    message: `\`${zod.name}\` calls \`.nonstrict()\` on \`${issue.originExportName}\`, escaping the generator's strict-by-default contract.`,
    location: { file: zod.file, line: lineFromCallStart(zod, call.callStart) },
    suggestion:
      "Drop `.nonstrict()` or replace it with an explicit `.strip()`/`.passthrough()` decision.",
    scope: { model: zod.name },
  };
}

function insertEditFix(
  issue: MissingIntIssue | MissingMaxIssue,
  description: string,
  newText: string,
): Finding["fix"] {
  return {
    description,
    edits: [{ file: issue.zod.file, start: issue.insertPos, end: issue.insertPos, newText }],
  };
}

function looseMaxFix(issue: LooseMaxIssue): Pick<Finding, "fix"> {
  if (!issue.maxArgRange) return {};
  return {
    fix: {
      description: `Lower .max(${issue.zodMax}) to .max(${issue.dbSize}) on ${issue.zod.name}.${issue.prismaField.name}`,
      edits: [
        {
          file: issue.zod.file,
          start: issue.maxArgRange.start,
          end: issue.maxArgRange.end,
          newText: String(issue.dbSize),
        },
      ],
    },
  };
}

function lineFromCallStart(zod: ZodSchemaInfo, _callStart: number): number {
  // Falling back to the schema declaration line — call-site source maps
  // require re-parsing the file, which we already did, but the SourceFile
  // object isn't on the schema. Future improvement: track call line during
  // discovery so suppression and SARIF anchor exactly at the offending line.
  return zod.line;
}

/**
 * Resolve the configured outputDir to an absolute path, mirroring Prisma's
 * own anchoring rules: relative paths anchor at the schema directory.
 */
function resolveOutputDir(ctx: ProjectContext): string | undefined {
  if (ctx.zodMode.kind === "hand-written") return undefined;
  const od = ctx.zodMode.outputDir;
  if (isAbsolute(od)) return od;
  if (od.startsWith(".")) return resolve(dirname(ctx.schemaPath), od);
  return resolve(ctx.rootDir, od);
}

// Exported for unused-import bookkeeping in case downstream tools want it.
export type { FieldInfo, PrismaModelRegistry };
