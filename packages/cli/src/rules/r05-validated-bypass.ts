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
 *   - Next.js — Route Handlers (`app/* /route.ts`), Server Actions (file- or
 *              inline-level `'use server'`), and Pages Router API
 *              (`pages/api/*`). See ./r05/next.ts.
 *
 * The `framework` config selects the active detector(s):
 *   - "auto" (default) — every detector whose import (or path signature) is
 *     present runs. A project that uses both Hono and Next gets both walkers.
 *   - "hono" / "trpc" / "next" — force-enable that detector regardless of
 *     imports / paths. Useful for projects with non-standard layouts.
 *   - "off" — disable the rule entirely.
 *
 * See: packages/checks/rules/R05-validated-bypass.md
 */

import { Project } from "ts-morph";
import type { Finding, ProjectContext, Rule, RuleOptions } from "../types.js";
import { findHonoBypasses, hasHonoFile } from "./r05/hono.js";
import { findNextBypasses, hasNextFile } from "./r05/next.js";
import { findTrpcBypasses, hasTrpcFile } from "./r05/trpc.js";

interface R05Config {
  framework?: "hono" | "trpc" | "next" | "auto" | "off";
  /** Globs of files to exclude from this rule (in addition to the auto-detection). */
  excludeFiles?: string[];
  /** Additional method names that count as validated readers. Default: ["valid"]. */
  validatedReaderNames?: string[];
}

export const r05: Rule = {
  id: "R05",
  name: "API boundary bypass",
  description:
    "Detects request handlers that accept client input without going through a Zod-validated boundary (Hono, tRPC, Next.js).",
  helpUri:
    "https://github.com/rshelekhov/prisma-zod-consistency/blob/main/packages/checks/rules/R05-validated-bypass.md",
  defaultSeverity: "warning",

  async run(ctx: ProjectContext, options: RuleOptions): Promise<Finding[]> {
    const config = options.config as R05Config;
    const framework = config.framework ?? "auto";
    if (framework === "off") return [];

    const wantHono = framework === "hono" || (framework === "auto" && (await hasHonoFile(ctx)));
    const wantTrpc = framework === "trpc" || (framework === "auto" && (await hasTrpcFile(ctx)));
    const wantNext = framework === "next" || (framework === "auto" && (await hasNextFile(ctx)));
    if (!wantHono && !wantTrpc && !wantNext) return [];

    const project = new Project({
      useInMemoryFileSystem: false,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: false, noEmit: true },
    });

    const findings: Finding[] = [];
    if (wantHono) findings.push(...(await findHonoBypasses(ctx, project, options)));
    if (wantTrpc) findings.push(...(await findTrpcBypasses(ctx, project, options)));
    if (wantNext) findings.push(...(await findNextBypasses(ctx, project, options)));
    return findings;
  },
};
