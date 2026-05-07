/**
 * Tests for bug #7 — Prisma `@map()` and `@@map()` extraction.
 *
 * Pre-0.8.1 the schema-loader only understood positional `@map("col")`. The
 * named-arg form `@map(name: "col")` (used heavily by formbricks and several
 * other production codebases) silently fell back to the field name, which
 * caused R09/R09c/R09d to report 200+ false positives on snake_case-in-DB
 * conventions.
 *
 * This file pins the column- and table-name resolution at the schema-loader
 * level, plus an end-to-end check against R09 diff that the false positive
 * really goes away on a fixture that mirrors the formbricks pattern.
 */

import { describe, expect, it } from "vitest";
import { diffPrismaVsDb } from "../src/rules/r09-schema-drift-vs-db.js";
import { parsePrismaRegistry } from "../src/schema/prisma-models.js";
import { extractExpectedForeignKeys } from "../src/schema/prisma-relations.js";

const HEADER = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
generator client {
  provider = "prisma-client-js"
}
`;

describe("schema-loader @map() extraction (bug #7)", () => {
  it('positional form: @map("created_at") populates field.columnName', () => {
    const reg = parsePrismaRegistry(`${HEADER}
      model User {
        id        String   @id @default(cuid())
        createdAt DateTime @default(now()) @map("created_at")
      }
    `);
    const user = reg.models.get("User");
    const f = user?.fields.find((x) => x.name === "createdAt");
    expect(f?.columnName).toBe("created_at");
  });

  it('named-arg form: @map(name: "created_at") populates field.columnName', () => {
    const reg = parsePrismaRegistry(`${HEADER}
      model User {
        id        String   @id @default(cuid())
        createdAt DateTime @default(now()) @map(name: "created_at")
      }
    `);
    const user = reg.models.get("User");
    const f = user?.fields.find((x) => x.name === "createdAt");
    expect(f?.columnName).toBe("created_at");
  });

  it("absent @map: columnName falls back to field name", () => {
    const reg = parsePrismaRegistry(`${HEADER}
      model User {
        id        String @id
        firstName String
      }
    `);
    const user = reg.models.get("User");
    expect(user?.fields.find((x) => x.name === "firstName")?.columnName).toBe("firstName");
  });

  it('@@map("users") populates model.tableName (positional)', () => {
    const reg = parsePrismaRegistry(`${HEADER}
      model User {
        id String @id
        @@map("users")
      }
    `);
    expect(reg.models.get("User")?.tableName).toBe("users");
  });

  it('@@map(name: "users") populates model.tableName (named-arg)', () => {
    const reg = parsePrismaRegistry(`${HEADER}
      model User {
        id String @id
        @@map(name: "users")
      }
    `);
    expect(reg.models.get("User")?.tableName).toBe("users");
  });
});

describe("R09: zero findings when @map matches DB column (bug #7 acceptance)", () => {
  // Fixture mirrors the minimal repro from 0.8.1-bugs-fix-session-prompt.md.
  const dbColumns = [
    {
      schemaName: "public",
      tableName: "User",
      columnName: "id",
      dataType: "text",
      udtName: "text",
      isNullable: false,
      characterMaximumLength: null,
      columnDefault: null,
    },
    {
      schemaName: "public",
      tableName: "User",
      columnName: "created_at",
      dataType: "timestamp without time zone",
      udtName: "timestamp",
      isNullable: false,
      characterMaximumLength: null,
      columnDefault: "now()",
    },
  ];

  it('0 findings on positional @map("created_at")', () => {
    const reg = parsePrismaRegistry(`${HEADER}
      model User {
        id        String   @id @default(cuid())
        createdAt DateTime @default(now()) @map("created_at")
      }
    `);
    const findings = diffPrismaVsDb(reg, dbColumns, { severity: "warning", config: {} });
    expect(findings).toEqual([]);
  });

  it('0 findings on named-arg @map(name: "created_at")', () => {
    const reg = parsePrismaRegistry(`${HEADER}
      model User {
        id        String   @id @default(cuid())
        createdAt DateTime @default(now()) @map(name: "created_at")
      }
    `);
    const findings = diffPrismaVsDb(reg, dbColumns, { severity: "warning", config: {} });
    expect(findings).toEqual([]);
  });

  it("still detects real drift on @map'd field when DB column actually missing", () => {
    // Schema says created_at exists; DB only has id (column renamed to creation_date).
    const reg = parsePrismaRegistry(`${HEADER}
      model User {
        id        String   @id @default(cuid())
        createdAt DateTime @map("created_at")
      }
    `);
    const dbColsRenamed = [dbColumns[0]!, { ...dbColumns[1]!, columnName: "creation_date" }];
    const findings = diffPrismaVsDb(reg, dbColsRenamed, { severity: "warning", config: {} });
    // Two findings expected: missing-in-db for User.createdAt, plus creation_date orphan.
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const missing = findings.find((f) => f.message.includes("created_at"));
    expect(missing?.message).toContain("missing in the database");
  });
});

describe("R09c: FK column resolved via scalar field @map (bug #7 acceptance)", () => {
  it("scalar FK field with @map provides the right physical column to extractExpectedForeignKeys", () => {
    const reg = parsePrismaRegistry(`${HEADER}
      model User {
        id    String @id
        posts Post[]
      }
      model Post {
        id     String  @id
        userId String? @map("user_id")
        user   User?   @relation(fields: [userId], references: [id], onDelete: Cascade)
      }
    `);
    const expected = extractExpectedForeignKeys(reg);
    const postFk = expected.find((e) => e.modelName === "Post" && e.relationFieldName === "user");
    // The whole point of the bug: pre-0.8.1 columns came back as ["userId"]
    // (Prisma identifier) instead of ["user_id"] (physical DB column).
    expect(postFk?.columns).toEqual(["user_id"]);
    expect(postFk?.referencedColumns).toEqual(["id"]);
    expect(postFk?.onDelete).toBe("cascade");
  });

  it("named-arg form on scalar FK field works the same way", () => {
    const reg = parsePrismaRegistry(`${HEADER}
      model User {
        id    String @id
        posts Post[]
      }
      model Post {
        id     String  @id
        userId String? @map(name: "user_id")
        user   User?   @relation(fields: [userId], references: [id], onDelete: Cascade)
      }
    `);
    const expected = extractExpectedForeignKeys(reg);
    const postFk = expected.find((e) => e.modelName === "Post" && e.relationFieldName === "user");
    expect(postFk?.columns).toEqual(["user_id"]);
  });
});
