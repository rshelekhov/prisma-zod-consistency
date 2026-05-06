/**
 * Discovery phase: figure out what we're looking at before any rule runs.
 *
 * Outputs a fully resolved ProjectContext: schema path, datasource provider,
 * source file list, and the Zod-generation mode that drives R01 sub-mode
 * selection.
 *
 * Multi-file Prisma schemas (Prisma 5.15+ `prismaSchemaFolder`, default in 6.x)
 * are flattened by `loadSchemaSource` into one logical source plus a per-line
 * origin map, so rules can report findings against the original `.prisma` file.
 */

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { glob } from "tinyglobby";
import type { ResolvedConfig } from "./config.js";
import { DiscoveryError } from "./discovery-error.js";
import { loadSchemaSource } from "./schema/load-schema.js";
import type { KnownZodGenerator, ProjectContext, ZodMode } from "./types.js";

export { DiscoveryError };

const KNOWN_GENERATORS: KnownZodGenerator[] = [
  "zod-prisma-types",
  "prisma-zod-generator",
  "zod-prisma",
];

export async function discover(config: ResolvedConfig): Promise<ProjectContext> {
  const schemaPath = isAbsolute(config.schemaPath)
    ? config.schemaPath
    : resolve(config.rootDir, config.schemaPath);

  const loaded = await loadSchemaSource(schemaPath);

  const sourceFiles = await glob(config.include, {
    cwd: config.rootDir,
    absolute: true,
    ignore: config.exclude,
    dot: false,
  });

  const initialMode = detectZodMode(loaded.schemaSource);
  const zodMode = await maybeUpgradeToHybrid(initialMode, {
    schemaPath: loaded.primaryFile,
    rootDir: config.rootDir,
    sourceFiles,
  });

  return {
    rootDir: config.rootDir,
    schemaPath: loaded.primaryFile,
    schemaSource: loaded.schemaSource,
    schemaSourceMap: loaded.schemaSourceMap,
    schemaFiles: loaded.files,
    provider: detectProvider(loaded.schemaSource),
    sourceFiles,
    zodMode,
    namingPrefixes: config.namingPrefixes,
  };
}

/**
 * `detectZodMode` reads only the Prisma schema, so it can't tell whether the
 * project also has hand-written schemas alongside the generator output.
 * After the source-file glob runs, we promote `generated` to `hybrid` if any
 * scanned TS/TSX file outside the `outputDir` imports `zod` — meaning the
 * project legitimately has both surfaces and R01c can fire.
 */
async function maybeUpgradeToHybrid(
  mode: ZodMode,
  args: { schemaPath: string; rootDir: string; sourceFiles: string[] },
): Promise<ZodMode> {
  if (mode.kind !== "generated") return mode;

  const outputDirAbs = resolveOutputDir(mode.outputDir, args.schemaPath, args.rootDir);

  for (const file of args.sourceFiles) {
    if (isPathInside(file, outputDirAbs)) continue;
    const source = await readFile(file, "utf8").catch(() => undefined);
    if (source === undefined) continue;
    if (/from\s+["']zod(\/v[34])?["']/.test(source)) {
      return { kind: "hybrid", generator: mode.generator, outputDir: mode.outputDir };
    }
  }

  return mode;
}

/**
 * Generators write `output = "..."` relative to the `schema.prisma` file.
 * Mirror Prisma's own behavior: relative paths anchor at the schema's
 * directory, absolute paths are honored as-is.
 */
function resolveOutputDir(outputDir: string, schemaPath: string, rootDir: string): string {
  if (isAbsolute(outputDir)) return outputDir;
  if (outputDir.startsWith(".")) return resolve(dirname(schemaPath), outputDir);
  // Bare paths (rare) fall back to project root.
  return resolve(rootDir, outputDir);
}

function isPathInside(candidate: string, dir: string): boolean {
  const c = resolve(candidate);
  const d = resolve(dir);
  if (c === d) return true;
  const prefix = d.endsWith("/") ? d : `${d}/`;
  return c.startsWith(prefix);
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
