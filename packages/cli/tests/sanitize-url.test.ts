/**
 * Tests for db/sanitize-url.ts — the helper that strips Prisma-only DATABASE_URL
 * params before passing the connection string to the underlying npm drivers.
 *
 * Motivated by bug #6 (smoke on formbricks, 2026-05-07): Prisma's stock
 * `?schema=public` URL was being forwarded verbatim to postgres.js, which
 * then sent it as a Postgres protocol startup parameter, and the server
 * rejected it with `unrecognized configuration parameter "schema"`.
 *
 * Coverage:
 *  - postgres provider strips Prisma params and surfaces searchPath
 *  - mysql provider strips its own Prisma param set, never reports searchPath
 *  - non-Prisma params (sslmode, application_name) are preserved
 *  - non-URL inputs pass through unchanged
 */

import { describe, expect, it } from "vitest";
import { sanitizePrismaUrl } from "../src/db/sanitize-url.js";

describe("sanitizePrismaUrl — postgres", () => {
  it("strips ?schema= and surfaces it via searchPath", () => {
    const r = sanitizePrismaUrl("postgres://u:p@localhost:5432/db?schema=public", "postgresql");
    expect(r.searchPath).toBe("public");
    // Either the trailing ? is dropped or the param disappears; both are valid.
    expect(r.url).not.toMatch(/[?&]schema=/);
    expect(r.url.startsWith("postgres://u:p@localhost:5432/db")).toBe(true);
  });

  it("strips Prisma-only pool/timeout params, leaves driver-meaningful params alone", () => {
    const r = sanitizePrismaUrl(
      "postgres://u:p@h:5432/db?schema=app&connection_limit=5&pool_timeout=30&sslmode=require&application_name=svc",
      "postgresql",
    );
    expect(r.searchPath).toBe("app");
    // All four Prisma-only keys gone.
    expect(r.url).not.toMatch(
      /[?&](schema|connection_limit|pool_timeout|pgbouncer|statement_cache_size)=/,
    );
    // Driver-meaningful keys preserved.
    expect(r.url).toMatch(/[?&]sslmode=require/);
    expect(r.url).toMatch(/[?&]application_name=svc/);
  });

  it("strips Prisma sslcert/sslidentity/sslpassword/sslaccept aliases", () => {
    const r = sanitizePrismaUrl(
      "postgres://u:p@h/db?sslcert=/tmp/c.pem&sslidentity=/tmp/i.p12&sslpassword=secret&sslaccept=accept_invalid_certs",
      "postgresql",
    );
    expect(r.url).not.toMatch(/[?&]sslcert=/);
    expect(r.url).not.toMatch(/[?&]sslidentity=/);
    expect(r.url).not.toMatch(/[?&]sslpassword=/);
    expect(r.url).not.toMatch(/[?&]sslaccept=/);
  });

  it("returns null searchPath when ?schema= is absent", () => {
    const r = sanitizePrismaUrl("postgres://u:p@h/db", "postgresql");
    expect(r.searchPath).toBeNull();
    // URL passes through (whatwg-URL may add a trailing slash on .toString(); both forms acceptable).
    expect(r.url.startsWith("postgres://u:p@h")).toBe(true);
  });

  it("treats empty ?schema= as no override", () => {
    const r = sanitizePrismaUrl("postgres://u:p@h/db?schema=", "postgresql");
    expect(r.searchPath).toBeNull();
  });

  it("passes through non-URL inputs unchanged", () => {
    const r = sanitizePrismaUrl("not://a valid url::", "postgresql");
    expect(r.url).toBe("not://a valid url::");
    expect(r.searchPath).toBeNull();
  });

  it("is a no-op when there are no Prisma-only params (URL stable, searchPath null)", () => {
    const input = "postgres://u:p@h:5432/db?application_name=svc&sslmode=require";
    const r = sanitizePrismaUrl(input, "postgresql");
    expect(r.searchPath).toBeNull();
    // Either exact equality or just the meaningful params preserved.
    expect(r.url).toMatch(/^postgres:\/\/u:p@h:5432\/db\?/);
    expect(r.url).toMatch(/application_name=svc/);
    expect(r.url).toMatch(/sslmode=require/);
  });
});

describe("sanitizePrismaUrl — mysql", () => {
  it("strips Prisma pool/timeout params from a mysql URL", () => {
    const r = sanitizePrismaUrl(
      "mysql://u:p@h:3306/db?connection_limit=10&pool_timeout=30&sslmode=disabled",
      "mysql",
    );
    expect(r.url).not.toMatch(
      /[?&](connection_limit|pool_timeout|connect_timeout|socket_timeout)=/,
    );
    // sslmode is mysql2-meaningful (`ssl-mode` is the canonical spelling, but
    // we keep both — mysql2 ignores unknown keys silently rather than failing).
    expect(r.url).toMatch(/[?&]sslmode=disabled/);
  });

  it("never reports searchPath for mysql (mysql has no `?schema=` concept)", () => {
    const r = sanitizePrismaUrl("mysql://u:p@h/db?schema=app", "mysql");
    // We don't strip ?schema= from mysql URLs (it's not in the Prisma mysql param
    // set), and we definitely don't mistakenly treat it as a search_path.
    expect(r.searchPath).toBeNull();
  });

  it("strips Prisma-only SSL aliases", () => {
    const r = sanitizePrismaUrl(
      "mysql://u:p@h/db?sslcert=/c.pem&sslca=/ca.pem&sslidentity=/i&sslpassword=x&sslaccept=strict",
      "mysql",
    );
    expect(r.url).not.toMatch(/[?&]sslcert=/);
    expect(r.url).not.toMatch(/[?&]sslca=/);
    expect(r.url).not.toMatch(/[?&]sslidentity=/);
    expect(r.url).not.toMatch(/[?&]sslpassword=/);
    expect(r.url).not.toMatch(/[?&]sslaccept=/);
  });
});
