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
  rules?: Partial<Record<RuleId, RuleConfig>>;
}

export interface RuleConfig {
  severity?: Severity | "off";
  /** Rule-specific options; passed through unchanged. */
  [key: string]: unknown;
}

export interface ResolvedConfig extends Required<Pick<UserConfig, "schemaPath" | "include" | "exclude" | "rules">> {
  /** Absolute path to the directory containing the config file (or cwd if none). */
  rootDir: string;
}

const DEFAULTS = {
  schemaPath: "prisma/schema.prisma",
  include: ["src/**/*.ts", "src/**/*.tsx"],
  exclude: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**", "**/dist/**"],
} satisfies Pick<UserConfig, "schemaPath" | "include" | "exclude">;

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
    rules: userConfig.rules ?? {},
    rootDir,
  };
}
