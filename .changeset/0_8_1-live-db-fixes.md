---
"prisma-zod-consistency": patch
---

Fix two critical bugs in live-DB rules (R09 / R09b / R09c / R09d) discovered during the 0.8.0 smoke validation on formbricks (Part B):

- **`DATABASE_URL` parsing (bug #6).** Prisma-specific URL params (`?schema=public`, `?connection_limit=`, `?pool_timeout=`, `?pgbouncer=`, `?statement_cache_size=`, `?sslcert=`/`?sslidentity=`/`?sslpassword=`/`?sslaccept=`) were forwarded verbatim to the underlying drivers. With `postgres.js` this caused `unrecognized configuration parameter "schema"` and the live-DB run aborted before reaching any rule. They are now stripped before connecting; for PostgreSQL the value of `?schema=` is honoured as the introspected schema (mirrors Prisma's behaviour). Driver-meaningful params (`sslmode`, `application_name`) are preserved.

- **`@map()` handling (bug #7).** The schema-loader only understood the positional form `@map("col_name")`. The named-arg form `@map(name: "col_name")` (used heavily by formbricks and several other production codebases) silently fell back to the field name, so R09 / R09b / R09c / R09d emitted hundreds of false positives on every snake_case-in-DB convention. `@map()` and `@@map()` now resolve via a single shared extractor that accepts both forms; field column names are computed once at load time and exposed as `field.columnName`. R09c also resolves FK source columns through scalar-field `@map()` correctly.

- **CLI driver-missing error (bug #8).** A missing `postgres` peer now produces the same actionable "install with `pnpm add -D postgres`" message that the `mysql2` and `better-sqlite3` adapters already emitted, instead of a raw `Cannot find package` stack trace. README also documents the install lines per provider and the supported `DATABASE_URL` formats explicitly.

No new features, no breaking changes. All 197 existing unit tests continue to pass; +20 targeted tests added (10 for URL sanitization, 10 for `@map()` extraction and downstream R09 / R09c behaviour).
