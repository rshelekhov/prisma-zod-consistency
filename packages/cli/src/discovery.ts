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
import { dirname, isAbsolute, relative, resolve } from "node:path";
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

  // Nit #1 (0.9.0): when the default schema path is missing, scan the project
  // for candidate `**/schema.prisma` files (excluding node_modules / dist /
  // build / .next / .git) and surface the list in the error so first-run users
  // in monorepos see exactly where the schema actually lives. Without this
  // hint they only learn that `prisma/schema.prisma` does not exist — which
  // is true on every monorepo that keeps its schema under `packages/db/...`.
  const loaded = await loadSchemaSource(schemaPath).catch(async (err: unknown) => {
    if (err instanceof DiscoveryError && /^schema\.prisma not found at /.test(err.message)) {
      const candidates = await findSchemaCandidates(config.rootDir);
      throw new DiscoveryError(formatMissingSchemaError(schemaPath, candidates, config.rootDir));
    }
    throw err;
  });

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
    provider: detectProvider(loaded.schemaSource, loaded.files, loaded.primaryFile, config.rootDir),
    sourceFiles,
    zodMode,
    namingPrefixes: config.namingPrefixes,
  };
}

/**
 * Scan the project root for any `**\/schema.prisma` files outside of common
 * generated/dependency directories. Returns absolute paths sorted shortest
 * first so the user sees the most likely real schema first.
 *
 * Used by `discover()` to enrich the "schema.prisma not found at <path>"
 * error with a list of candidates the user can copy into `schemaPath`.
 */
export async function findSchemaCandidates(rootDir: string): Promise<string[]> {
  const matches = await glob(["**/schema.prisma", "**/*.prisma"], {
    cwd: rootDir,
    absolute: true,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/.git/**",
      "**/coverage/**",
      "**/generated/**",
    ],
    dot: false,
  }).catch(() => [] as string[]);
  // Prefer files literally named `schema.prisma`, then any `.prisma` files
  // (covers multi-file setups where the entry might be named `main.prisma`
  // or similar). Within each group, sort by path depth (closest first).
  const schemaFirst = matches
    .filter((p) => p.endsWith("/schema.prisma"))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const otherPrisma = matches
    .filter((p) => !p.endsWith("/schema.prisma"))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return [...schemaFirst, ...otherPrisma].slice(0, 8);
}

function formatMissingSchemaError(
  attemptedPath: string,
  candidates: string[],
  rootDir: string,
): string {
  if (candidates.length === 0) {
    return `schema.prisma not found at ${attemptedPath}.\nNo .prisma files were found anywhere under ${rootDir}. Pass --cwd to point at your project root, or set "schemaPath" in .prismazodrc.json.`;
  }
  const list = candidates.map((p) => `  - ${relative(rootDir, p) || p}`).join("\n");
  return `schema.prisma not found at ${attemptedPath}.\nFound these candidates:\n${list}\nSet "schemaPath" in .prismazodrc.json (or pass --cwd to a sub-package).`;
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

function detectProvider(
  schemaSource: string,
  schemaFiles: readonly string[],
  primaryFile: string,
  rootDir: string,
): ProjectContext["provider"] {
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
    case undefined:
      // Nit #3 (0.9.0): missing datasource block is the most common shape of
      // this error — the user pointed `schemaPath` at a directory that has
      // `.prisma` files (so loadSchemaSource succeeded) but none of those
      // files contain a `datasource` block. Multi-file Prisma schemas keep
      // the datasource in the *entry* file; sub-directories typically hold
      // only model fragments. Surface the entry-file fix instead of leaking
      // the parser-level "<none>" sentinel that means nothing to a new user.
      throw new DiscoveryError(formatMissingDatasourceError(schemaFiles, primaryFile, rootDir));
    default:
      throw new DiscoveryError(`Unsupported datasource provider: ${provider}`);
  }
}

function formatMissingDatasourceError(
  schemaFiles: readonly string[],
  primaryFile: string,
  rootDir: string,
): string {
  const rel = (p: string) => relative(rootDir, p) || p;
  if (schemaFiles.length <= 1) {
    return `No \`datasource\` block found in ${rel(primaryFile)}.\nEvery Prisma schema needs exactly one \`datasource db { provider = "..."; url = ... }\` block. If your schema is split across multiple files, point \`schemaPath\` at the entry file that owns the datasource.`;
  }
  const list = schemaFiles
    .slice(0, 6)
    .map((f) => `  - ${rel(f)}`)
    .join("\n");
  return `No \`datasource\` block found in any of the .prisma files loaded from \`${rel(primaryFile)}\` and its directory:\n${list}\nMulti-file schemas (Prisma 5.15+ \`prismaSchemaFolder\`) load every \`.prisma\` sibling, but the \`datasource\` block must live in the entry file you point at. Set \`schemaPath\` to the file that contains \`datasource db { ... }\` (often \`schema.prisma\` at the project root or under \`prisma/\`).`;
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
