/**
 * Strip Prisma-specific DATABASE_URL params before passing the connection
 * string to the underlying driver (`postgres`, `mysql2`).
 *
 * Prisma's connection string format embeds ORM-layer config as query params
 * (e.g. `?schema=public`, `?connection_limit=5`, `?pool_timeout=30`). The npm
 * drivers we use don't recognize those names. In postgres.js the unknown keys
 * are passed verbatim as Postgres protocol *startup parameters* — and the
 * server rejects them: `unrecognized configuration parameter "schema"`. This
 * is the symptom that motivated bug #6 (smoke on formbricks, 2026-05-07).
 *
 * Behaviour:
 *  - returns a cleaned URL safe to pass to the driver;
 *  - for postgres, also extracts `?schema=` so callers can set the effective
 *    schema for downstream `WHERE n.nspname = ...` queries.
 *
 * The cleaning is a *strict allow-list of params we strip*, not a strip-all:
 * SSL params that the driver natively understands (postgres.js: `sslmode`,
 * `sslrootcert`; mysql2: `ssl-mode`) are preserved. Prisma-only SSL aliases
 * (`sslcert` as a file path, `sslaccept`, `sslidentity`, `sslpassword`) are
 * stripped because the drivers expect a different shape (an `ssl: {...}`
 * config object, not URL params).
 *
 * Non-URL inputs (e.g. SQLite `file:./db.sqlite`) are returned unchanged.
 */

/** Prisma-specific Postgres URL params that postgres.js does NOT understand. */
const POSTGRES_PRISMA_ONLY: ReadonlySet<string> = new Set([
  "schema",
  "connection_limit",
  "pool_timeout",
  "connect_timeout",
  "socket_timeout",
  "pgbouncer",
  "statement_cache_size",
  "options", // Prisma's `options=` string; not the same as Postgres `options` startup param
  // Prisma-only SSL aliases — different shape from postgres.js native `ssl: {...}`.
  "sslcert",
  "sslidentity",
  "sslpassword",
  "sslaccept",
]);

/** Prisma-specific MySQL URL params that mysql2 does NOT understand. */
const MYSQL_PRISMA_ONLY: ReadonlySet<string> = new Set([
  "connection_limit",
  "pool_timeout",
  "connect_timeout",
  "socket_timeout",
  // Prisma-only SSL aliases. mysql2 takes SSL via `ssl: {...}` in createPool config.
  "sslcert",
  "sslca",
  "sslidentity",
  "sslpassword",
  "sslaccept",
]);

export interface SanitizedUrl {
  /** Connection string with Prisma-only params removed. Safe to pass to the driver. */
  url: string;
  /**
   * For postgres: value of `?schema=` if present, otherwise null.
   * Callers should resolve effective schema as
   *   `opts.schema ?? searchPath ?? "public"`.
   */
  searchPath: string | null;
}

export function sanitizePrismaUrl(rawUrl: string, provider: "postgresql" | "mysql"): SanitizedUrl {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    // Not a parseable URL (raw path, file: scheme, socket form). Pass through;
    // the driver will surface its own error if it can't handle the input.
    return { url: rawUrl, searchPath: null };
  }

  let searchPath: string | null = null;
  if (provider === "postgresql") {
    const v = u.searchParams.get("schema");
    if (v != null && v !== "") searchPath = v;
  }

  const denyList = provider === "postgresql" ? POSTGRES_PRISMA_ONLY : MYSQL_PRISMA_ONLY;
  for (const key of denyList) u.searchParams.delete(key);

  return { url: u.toString(), searchPath };
}
