/**
 * R05 — API boundary bypass.
 *
 * Detects request handlers that accept untyped client input without going
 * through a Zod-validated boundary. The rule is framework-aware and dispatches
 * to per-framework walkers:
 *
 *   - Hono   — `.req.json()` / `.req.parseBody()` / `.req.formData()` directly
 *              on the context. See ./r05/hono.ts.
 *   - tRPC   — `.query(handler)` / `.mutation(handler)` where the handler
 *              accepts `input` but the chain has no `.input(zodSchema)`.
 *              See ./r05/trpc.ts.
 *
 * The `framework` config selects the active detector(s):
 *   - "auto" (default) — every detector whose import is present runs. A
 *     project that uses both Hono and tRPC gets both walkers.
 *   - "hono" / "trpc"  — force-enable that detector regardless of imports.
 *   - "off"            — disable the rule entirely.
 *
 * See: packages/checks/rules/R05-validated-bypass.md
 */

import { Project } from "ts-morph";
import type { Finding, ProjectContext, Rule, RuleOptions } from "../types.js";
import { findHonoBypasses, hasHonoFile } from "./r05/hono.js";
import { findTrpcBypasses, hasTrpcFile } from "./r05/trpc.js";

interface R05Config {
  framework?: "hono" | "trpc" | "auto" | "off";
  /** Globs of files to exclude from this rule (in addition to the auto-detection). */
  excludeFiles?: string[];
  /** Additional method names that count as validated readers. Default: ["valid"]. */
  validatedReaderNames?: string[];
}

export const r05: Rule = {
  id: "R05",
  name: "API boundary bypass",
  description:
    "Detects request handlers that accept client input without going through a Zod-validated boundary (Hono and tRPC detectors).",
  helpUri:
    "https://github.com/rshelekhov/prisma-zod-consistency/blob/main/packages/checks/rules/R05-validated-bypass.md",
  defaultSeverity: "warning",

  async run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]> {
    const config = options.config as R05Config;
    const framework = config.framework ?? "auto";
    if (framework === "off") return [];

    const wantHono = framework === "hono" || (framework === "auto" && (await hasHonoFile(ctx)));
    const wantTrpc = framework === "trpc" || (framework === "auto" && (await hasTrpcFile(ctx)));
    if (!wantHono && !wantTrpc) return [];

    const project = new Project({
      useInMemoryFileSystem: false,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: false, noEmit: true },
    });

    const findings: Finding[] = [];
    if (wantHono) findings.push(...(await findHonoBypasses(ctx, project, options)));
    if (wantTrpc) findings.push(...(await findTrpcBypasses(ctx, project, options)));
    return findings;
  },
};
