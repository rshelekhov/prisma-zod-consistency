/**
 * Resolves the CLI's published version at runtime by reading the sibling
 * package.json. Used for `--version` output and for SARIF tool.driver.version.
 *
 * In dev (vitest, ts-node) `import.meta.url` points at `src/version.ts`, so
 * `../package.json` resolves to the CLI package's own package.json.
 * In production `import.meta.url` points at `dist/version.js` and the same
 * relative path holds.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };

export const VERSION: string = pkg.version;
