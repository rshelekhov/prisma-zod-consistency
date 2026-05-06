/**
 * R09c — foreign-key constraints drift between Prisma `@relation` and live DB.
 *
 * Two layers of testing here:
 *   1. `extractExpectedForeignKeys` — parses `@relation(...)` from a real
 *      Prisma source (via parsePrismaRegistry, no fixture stub). Validates
 *      that we honor `@map`/`@@map`, default actions, and multi-column FKs.
 *   2. `diffForeignKeys` — operates on synthetic ExpectedForeignKey[] +
 *      DbForeignKey[] data, exercising every finding class without parsing.
 */

import { describe, expect, it } from "vitest";
import type { DbForeignKey } from "../src/db/types.js";
import { diffForeignKeys } from "../src/rules/r09c-fk-constraints-drift.js";
import { parsePrismaRegistry } from "../src/schema/prisma-models.js";
import {
  type ExpectedForeignKey,
  extractExpectedForeignKeys,
  prismaActionToCanonical,
} from "../src/schema/prisma-relations.js";

describe("prismaActionToCanonical — Prisma keyword → SQL-standard text", () => {
  it("maps every documented keyword", () => {
    expect(prismaActionToCanonical("Cascade")).toBe("cascade");
    expect(prismaActionToCanonical("Restrict")).toBe("restrict");
    expect(prismaActionToCanonical("NoAction")).toBe("no action");
    expect(prismaActionToCanonical("SetNull")).toBe("set null");
    expect(prismaActionToCanonical("SetDefault")).toBe("set default");
  });

  it("falls back to 'no action' for unknown keywords", () => {
    expect(prismaActionToCanonical("Unexpected")).toBe("no action");
    expect(prismaActionToCanonical("")).toBe("no action");
  });
});

describe("extractExpectedForeignKeys — parsing @relation", () => {
  it("extracts single-column FK with explicit actions and physical column names via @map", () => {
    const source = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id   Int @id @map("user_id")
  name String
  memberships Membership[]
}

model Membership {
  id      Int  @id
  user    User @relation(fields: [userId], references: [id], onDelete: Cascade, onUpdate: Restrict)
  userId  Int  @map("user_id_fk")

  @@map("memberships")
}
`;
    const registry = parsePrismaRegistry(source);
    const fks = extractExpectedForeignKeys(registry);
    expect(fks).toHaveLength(1);
    const fk = fks[0];
    expect(fk?.modelName).toBe("Membership");
    expect(fk?.relationFieldName).toBe("user");
    expect(fk?.tableName).toBe("memberships"); // @@map honored
    expect(fk?.columns).toEqual(["user_id_fk"]); // @map on FK column
    expect(fk?.referencedTable).toBe("User");
    expect(fk?.referencedColumns).toEqual(["user_id"]); // @map on referenced field
    expect(fk?.onDelete).toBe("cascade");
    expect(fk?.onUpdate).toBe("restrict");
  });

  it("defaults onDelete / onUpdate to 'no action' when keywords are absent", () => {
    const source = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id          Int          @id
  memberships Membership[]
}
model Membership {
  id     Int  @id
  user   User @relation(fields: [userId], references: [id])
  userId Int
}
`;
    const registry = parsePrismaRegistry(source);
    const fks = extractExpectedForeignKeys(registry);
    expect(fks[0]?.onDelete).toBe("no action");
    expect(fks[0]?.onUpdate).toBe("no action");
  });

  it("extracts multi-column FK preserving column order", () => {
    const source = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Org {
  id1 Int
  id2 Int
  members Membership[]

  @@id([id1, id2])
}
model Membership {
  id     Int @id
  org    Org @relation(fields: [orgId1, orgId2], references: [id1, id2], onDelete: Cascade)
  orgId1 Int
  orgId2 Int
}
`;
    const registry = parsePrismaRegistry(source);
    const fks = extractExpectedForeignKeys(registry);
    expect(fks).toHaveLength(1);
    expect(fks[0]?.columns).toEqual(["orgId1", "orgId2"]);
    expect(fks[0]?.referencedColumns).toEqual(["id1", "id2"]);
  });

  it("skips back-references and implicit M-N relations (no fields/references)", () => {
    const source = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id          Int          @id
  memberships Membership[]
}
model Membership {
  id     Int @id
  user   User @relation(fields: [userId], references: [id])
  userId Int
}

// Implicit M-N: no fields / references — skipped.
model Tag {
  id    Int    @id
  posts Post[]
}
model Post {
  id   Int   @id
  tags Tag[]
}
`;
    const registry = parsePrismaRegistry(source);
    const fks = extractExpectedForeignKeys(registry);
    // Only the Membership.user FK should appear. User.memberships is a
    // back-reference. Tag↔Post is implicit M-N.
    expect(fks).toHaveLength(1);
    expect(fks[0]?.modelName).toBe("Membership");
  });
});

describe("diffForeignKeys — finding generation", () => {
  it("flags missing FK in DB (Prisma declares it, DB doesn't)", () => {
    const expected: ExpectedForeignKey[] = [
      fk({ relationFieldName: "org", columns: ["org_id"], referencedTable: "org" }),
    ];
    const findings = diffForeignKeys(expected, [], opts());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("missing in the database");
    expect(findings[0]?.message).toContain("Membership.org");
  });

  it("flags orphan FK in DB (DB has it, Prisma doesn't)", () => {
    const actual: DbForeignKey[] = [
      dbFk({ tableName: "membership", constraintName: "membership_org_fkey", columns: ["org_id"] }),
    ];
    const findings = diffForeignKeys([], actual, opts());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("not declared in schema.prisma");
    expect(findings[0]?.message).toContain("membership_org_fkey");
  });

  it("flags action drift when columns match but onDelete differs", () => {
    const expected: ExpectedForeignKey[] = [
      fk({ relationFieldName: "org", columns: ["org_id"], onDelete: "cascade" }),
    ];
    const actual: DbForeignKey[] = [
      dbFk({ tableName: "membership", columns: ["org_id"], onDelete: "no action" }),
    ];
    const findings = diffForeignKeys(expected, actual, opts());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("action drift");
    expect(findings[0]?.message).toContain("onDelete=cascade");
    expect(findings[0]?.message).toContain("onDelete=no action");
  });

  it("flags reference shape drift (different referenced table or columns)", () => {
    const expected: ExpectedForeignKey[] = [
      fk({
        relationFieldName: "org",
        columns: ["org_id"],
        referencedTable: "org",
        referencedColumns: ["id"],
      }),
    ];
    const actual: DbForeignKey[] = [
      dbFk({
        tableName: "membership",
        columns: ["org_id"],
        referencedTable: "different_org",
        referencedColumns: ["id"],
      }),
    ];
    const findings = diffForeignKeys(expected, actual, opts());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("references");
    expect(findings[0]?.message).toContain("different_org");
  });

  it("matches multi-column FKs by sorted column key (declaration order doesn't matter for matching)", () => {
    // Expected and actual use different declaration orders; columns/refs
    // checked per-position only after the (table, sorted(columns)) match.
    const expected: ExpectedForeignKey[] = [
      fk({
        relationFieldName: "org",
        columns: ["org_id1", "org_id2"],
        referencedColumns: ["id1", "id2"],
      }),
    ];
    const actual: DbForeignKey[] = [
      dbFk({
        tableName: "membership",
        columns: ["org_id2", "org_id1"], // different declaration order
        referencedColumns: ["id2", "id1"],
      }),
    ];
    // Match on sorted columns ✓; per-position comparison fails on
    // referencedColumns ordering — flagged as reference drift.
    const findings = diffForeignKeys(expected, actual, opts());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("references");
  });

  it("does not flag matched FKs with identical actions", () => {
    const expected: ExpectedForeignKey[] = [
      fk({ relationFieldName: "org", columns: ["org_id"], onDelete: "cascade" }),
    ];
    const actual: DbForeignKey[] = [
      dbFk({ tableName: "membership", columns: ["org_id"], onDelete: "cascade" }),
    ];
    expect(diffForeignKeys(expected, actual, opts())).toEqual([]);
  });

  it("respects ignoreRelations regex (Model.field)", () => {
    const expected: ExpectedForeignKey[] = [fk({ relationFieldName: "org", columns: ["org_id"] })];
    const findings = diffForeignKeys(expected, [], {
      severity: "warning",
      config: { ignoreRelations: ["^Membership\\.org$"] },
    });
    expect(findings).toEqual([]);
  });

  it("respects ignoreTables for both expected and actual sides", () => {
    const expected: ExpectedForeignKey[] = [
      fk({ tableName: "_prisma_migrations", columns: ["x"] }),
    ];
    const actual: DbForeignKey[] = [dbFk({ tableName: "_prisma_migrations", columns: ["y"] })];
    const findings = diffForeignKeys(expected, actual, {
      severity: "warning",
      config: { ignoreTables: ["_prisma_migrations"] },
    });
    expect(findings).toEqual([]);
  });
});

// ---- helpers ----

function fk(p: Partial<ExpectedForeignKey>): ExpectedForeignKey {
  return {
    modelName: "Membership",
    relationFieldName: "rel",
    tableName: "membership",
    columns: ["x"],
    referencedTable: "org",
    referencedColumns: ["id"],
    onDelete: "no action",
    onUpdate: "no action",
    ...p,
  };
}

function dbFk(p: Partial<DbForeignKey>): DbForeignKey {
  return {
    schemaName: "public",
    tableName: "membership",
    constraintName: "fkey",
    columns: ["x"],
    referencedTable: "org",
    referencedColumns: ["id"],
    onDelete: "no action",
    onUpdate: "no action",
    ...p,
  };
}

function opts() {
  return { severity: "warning" as const, config: {} };
}
