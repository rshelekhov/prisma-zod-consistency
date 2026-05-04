/**
 * Discovery phase: figure out what we're looking at before any rule runs.
 *
 * Outputs a fully resolved ProjectContext: schema path, datasource provider,
 * source file list, and the Zod-generation mode that drives R01 sub-mode
 * selection.
 *
 * Pre-alpha: implementation is intentionally minimal. The Prisma parse pass
 * and Zod generator detection land alongside the first real rule run.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { glob } from "tinyglobby";
import type { ResolvedConfig } from "./config.js";
import type { KnownZodGenerator, ProjectContext, ZodMode } from "./types.js";

const KNOWN_GENERATORS: KnownZodGenerator[] = [
  "zod-prisma-types",
  "prisma-zod-generator",
  "zod-prisma",
];

export async function discover(config: ResolvedConfig): Promise<ProjectContext> {
  const schemaPath = isAbsolute(config.schemaPath)
    ? config.schemaPath
    : resolve(config.rootDir, config.schemaPath);

  const schemaSource = await readFile(schemaPath, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      throw new DiscoveryError(`schema.prisma not found at ${schemaPath}`);
    }
    throw err;
  });

  const sourceFiles = await glob(config.include, {
    cwd: config.rootDir,
    absolute: true,
    ignore: config.exclude,
    dot: false,
  });

  return {
    rootDir: config.rootDir,
    schemaPath,
    provider: detectProvider(schemaSource),
    sourceFiles,
    zodMode: detectZodMode(schemaSource),
  };
}

function detectProvider(schemaSource: string): ProjectContext["provider"] {
  // Naive substring scan; a real impl will use @mrleebo/prisma-ast.
  const match = schemaSource.match(/datasource\s+\w+\s*\{[^}]*provider\s*=\s*"([^"]+)"/m);
  const provider = match?.[1];
  switch (provider) {
    case "postgresql":
    case "mysql":
    case "sqlite":
    case "sqlserver":
    case "mongodb":
    case "cockroachdb":
      return provider;
    default:
      throw new DiscoveryError(
        `Unsupported or missing datasource provider: ${provider ?? "<none>"}`,
      );
  }
}

function detectZodMode(schemaSource: string): ZodMode {
  // Naive substring scan; replace with prisma-ast generator block walker.
  const generatorBlocks = schemaSource.matchAll(/generator\s+\w+\s*\{([^}]*)\}/gm);
  for (const block of generatorBlocks) {
    const body = block[1] ?? "";
    const providerMatch = body.match(/provider\s*=\s*"([^"]+)"/);
    const provider = providerMatch?.[1];
    if (!provider) continue;

    const known = KNOWN_GENERATORS.find((g) => provider === g || provider.endsWith(`/${g}`));
    if (!known) continue;

    const outputMatch = body.match(/output\s*=\s*"([^"]+)"/);
    const outputDir = outputMatch?.[1] ?? "./generated/zod";
    return { kind: "generated", generator: known, outputDir };
  }

  return { kind: "hand-written" };
}

export class DiscoveryError extends Error {
  override readonly name = "DiscoveryError";
}
