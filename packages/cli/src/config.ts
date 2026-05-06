/**
 * Config loading via cosmiconfig. Supports:
 *   - .prismazodrc, .prismazodrc.json, .prismazodrc.{js,cjs,mjs}
 *   - prismazod.config.{js,cjs,mjs}
 *   - "prisma-zod-consistency" field in package.json
 */

import { dirname } from "node:path";
import { cosmiconfig } from "cosmiconfig";
import type { RuleId, Severity } from "./types.js";

const MODULE_NAME = "prismazod";

export interface UserConfig {
  schemaPath?: string;
  include?: string[];
  exclude?: string[];
  /**
   * Single-character PascalCase prefixes to strip from Zod schema names when
   * matching them to Prisma models. The prefix is removed only when the next
   * character is uppercase (so "ZUser" → "User", but "Zone" stays "Zone").
   *
   * Default: `["Z"]` — covers the most common convention (formbricks,
   * t3-stack, zod-prisma codegens). Add `"T"` (type-prefix) or `"I"`
   * (interface-prefix) if your project uses them, or set to `[]` to disable.
   */
  namingPrefixes?: string[];
  rules?: Partial<Record<RuleId, RuleConfig>>;
}

export interface RuleConfig {
  severity?: Severity | "off";
  /** Rule-specific options; passed through unchanged. */
  [key: string]: unknown;
}

export interface ResolvedConfig
  extends Required<
    Pick<UserConfig, "schemaPath" | "include" | "exclude" | "namingPrefixes" | "rules">
  > {
  /** Absolute path to the directory containing the config file (or cwd if none). */
  rootDir: string;
}

const DEFAULTS = {
  schemaPath: "prisma/schema.prisma",
  include: ["src/**/*.ts", "src/**/*.tsx"],
  exclude: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**", "**/dist/**"],
  // The conservative default: only "Z" — the most widely used Z-schema
  // convention (formbricks, t3-stack, several Zod codegens). T/I require
  // explicit opt-in because they overlap with TypeScript generic-parameter
  // and interface-naming conventions and risk false matches in some domains.
  namingPrefixes: ["Z"],
} satisfies Pick<UserConfig, "schemaPath" | "include" | "exclude" | "namingPrefixes">;

export async function loadConfig(cwd: string = process.cwd()): Promise<ResolvedConfig> {
  const explorer = cosmiconfig(MODULE_NAME, {
    searchPlaces: [
      "package.json",
      `.${MODULE_NAME}rc`,
      `.${MODULE_NAME}rc.json`,
      `.${MODULE_NAME}rc.js`,
      `.${MODULE_NAME}rc.cjs`,
      `.${MODULE_NAME}rc.mjs`,
      `${MODULE_NAME}.config.js`,
      `${MODULE_NAME}.config.cjs`,
      `${MODULE_NAME}.config.mjs`,
    ],
    packageProp: "prisma-zod-consistency",
  });

  const result = await explorer.search(cwd);
  const userConfig: UserConfig = result?.config ?? {};
  const rootDir = result?.filepath ? dirname(result.filepath) : cwd;

  return {
    schemaPath: userConfig.schemaPath ?? DEFAULTS.schemaPath,
    include: userConfig.include ?? DEFAULTS.include,
    exclude: userConfig.exclude ?? DEFAULTS.exclude,
    namingPrefixes: userConfig.namingPrefixes ?? DEFAULTS.namingPrefixes,
    rules: userConfig.rules ?? {},
    rootDir,
  };
}
