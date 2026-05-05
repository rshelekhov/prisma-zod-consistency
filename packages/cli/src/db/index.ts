/**
 * Group B (live-DB) provider dispatch.
 *
 * Picks the right adapter based on the project's Prisma datasource provider
 * and calls it. Adapters live in sibling files (postgres.ts, mysql.ts,
 * sqlite.ts) and are loaded dynamically — keeping the underlying drivers
 * (`postgres`, `mysql2`, `better-sqlite3`) as optional peer dependencies.
 *
 * The set of supported providers is intentionally narrower than what Prisma
 * itself supports: we only target the three relational engines for which we
 * can deliver consistent R07/R08/R09 semantics. The runner refuses to attempt
 * --db on the rest (sqlserver / mongodb / cockroachdb) with a clear error.
 *
 * If a user requests --db but the relevant driver isn't installed, the adapter
 * raises a self-explanatory error that names the install command. We surface
 * those errors verbatim — no extra wrapping — so the CLI message stays
 * actionable.
 */

import type { ProjectContext } from "../types.js";
import type { DbConnectOptions, DbSnapshot } from "./types.js";

/** Providers for which we ship a Group B adapter. */
export type DbProvider = "postgresql" | "mysql" | "sqlite";

const SUPPORTED: ReadonlySet<ProjectContext["provider"]> = new Set([
  "postgresql",
  "mysql",
  "sqlite",
]);

/**
 * Type guard: is this Prisma datasource provider one we can introspect?
 *
 * Used by the runner to decide whether to attempt a snapshot or to reject the
 * --db request up front with a useful message.
 */
export function isDbProviderSupported(
  provider: ProjectContext["provider"],
): provider is DbProvider {
  return SUPPORTED.has(provider);
}

/**
 * Snapshot the live database for the given provider.
 *
 * Adapters are imported lazily so that the relevant native dependency is only
 * loaded when actually exercised. Errors thrown by adapters when their driver
 * is not installed are designed to be user-actionable and are re-thrown
 * unchanged.
 */
export async function snapshotDatabase(
  provider: DbProvider,
  opts: DbConnectOptions,
): Promise<DbSnapshot> {
  switch (provider) {
    case "postgresql": {
      const { snapshotPostgres } = await import("./postgres.js");
      return snapshotPostgres(opts);
    }
    case "mysql": {
      const { snapshotMysql } = await import("./mysql.js");
      return snapshotMysql(opts);
    }
    case "sqlite": {
      const { snapshotSqlite } = await import("./sqlite.js");
      return snapshotSqlite(opts);
    }
  }
}

// Re-export the public types so other modules don't need to know which file
// the shapes live in. The dispatcher is the canonical entry point.
export type {
  DbCapabilities,
  DbColumn,
  DbConnectOptions,
  DbIndex,
  DbIndexUsage,
  DbSnapshot,
} from "./types.js";
