/**
 * Bug #3 (0.8.0): R03 must understand the Zod 4 `z.enum(IDENT)` shorthand.
 * Previously the rule treated `IDENT` as if it were an empty array literal,
 * producing 38 false-positive findings on dub. With ts-morph + Prisma-registry
 * fallback, R03 should now:
 *
 *   - Compare values when the identifier resolves to a TS `enum X` or
 *     `const X = {...} as const` declaration.
 *   - Trust the binding when the identifier name matches the Prisma enum
 *     (the dub case: `import { PostbackReceiver } from "@dub/prisma/client"`).
 *   - Emit an info-level note when neither resolution path succeeds.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/runner.js";

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pz-r03-resolve-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

const PRISMA_HEADER = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
`;

const PRISMA_BOOKING = `
enum BookingStatus {
  PENDING
  CONFIRMED
  CANCELLED
}

model Booking {
  id     String        @id
  status BookingStatus
}
`;

describe("Bug #3 — R03 resolves Zod 4 z.enum(IDENT) shorthand", () => {
  it("trusts a Prisma-name match even when the identifier doesn't TS-resolve", async () => {
    // Mirrors the dub case: `z.enum(BookingStatus)` where BookingStatus is
    // re-exported through a monorepo path whose .d.ts isn't in the parse.
    // We don't actually create the @prisma/client file — so TS-side
    // resolution returns nothing — but the name matches the Prisma enum.
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}${PRISMA_BOOKING}`,
      "src/schemas.ts": `
import { z } from "zod";
import { BookingStatus } from "@prisma/client";
export const bookingSchema = z.object({
  id: z.string(),
  status: z.enum(BookingStatus),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R03"] });
      // Must NOT emit a "missing in Zod" drift finding for `status`.
      const drift = findings.find(
        (f) => f.scope?.field === "status" && /missing in Zod|extra in Zod/.test(f.message),
      );
      expect(drift).toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("compares values when the identifier resolves to a local TS enum (correct values → no finding)", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}${PRISMA_BOOKING}`,
      "src/schemas.ts": `
import { z } from "zod";
enum BookingStatus {
  PENDING = "PENDING",
  CONFIRMED = "CONFIRMED",
  CANCELLED = "CANCELLED",
}
export const bookingSchema = z.object({
  id: z.string(),
  status: z.enum(BookingStatus),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R03"] });
      expect(findings).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("flags a values mismatch when the local TS enum drifted from Prisma", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}${PRISMA_BOOKING}`,
      "src/schemas.ts": `
import { z } from "zod";
enum BookingStatus {
  PENDING = "PENDING",
  CONFIRMED = "CONFIRMED",
  // CANCELLED missing — drift!
  REFUNDED = "REFUNDED",  // also extra
}
export const bookingSchema = z.object({
  id: z.string(),
  status: z.enum(BookingStatus),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R03"] });
      const drift = findings.find((f) => /status.*BookingStatus/.test(f.message));
      expect(drift).toBeDefined();
      expect(drift?.message).toContain("missing in Zod: CANCELLED");
      expect(drift?.message).toContain("extra in Zod: REFUNDED");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("resolves a `const X = {...} as const` declaration", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}${PRISMA_BOOKING}`,
      "src/schemas.ts": `
import { z } from "zod";
const BookingStatus = {
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  CANCELLED: "CANCELLED",
} as const;
export const bookingSchema = z.object({
  id: z.string(),
  status: z.enum(BookingStatus),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R03"] });
      // No drift on status — values agree.
      expect(findings.filter((f) => /status/.test(f.message))).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("flags a wrong-name identifier even when it TS-resolves", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}${PRISMA_BOOKING}
enum Priority {
  LOW
  HIGH
}
`,
      "src/schemas.ts": `
import { z } from "zod";
enum Priority {
  LOW = "LOW",
  HIGH = "HIGH",
}
export const bookingSchema = z.object({
  id: z.string(),
  status: z.enum(Priority),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R03"] });
      const drift = findings.find(
        (f) =>
          f.scope?.field === "status" ||
          /Priority.*BookingStatus|BookingStatus.*Priority/.test(f.message),
      );
      expect(drift).toBeDefined();
      expect(drift?.message).toMatch(/Priority/);
      expect(drift?.message).toMatch(/BookingStatus/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("emits an info-level note when the identifier neither resolves nor name-matches", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}${PRISMA_BOOKING}`,
      "src/schemas.ts": `
import { z } from "zod";
import { SomeOtherName } from "./external";
export const bookingSchema = z.object({
  id: z.string(),
  status: z.enum(SomeOtherName),
});
`,
      "src/external.ts": `export const SomeOtherName = ['x', 'y'];\n`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R03"] });
      const note = findings.find((f) => /could not resolve/i.test(f.message));
      expect(note).toBeDefined();
      expect(note?.severity).toBe("info");
      expect(note?.message).toContain("SomeOtherName");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("preserves backwards compatibility for `z.enum([...literals])` array form", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}${PRISMA_BOOKING}`,
      "src/schemas.ts": `
import { z } from "zod";
export const bookingSchema = z.object({
  id: z.string(),
  status: z.enum(["PENDING", "CONFIRMED", "CANCELLED"]),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R03"] });
      expect(findings).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("flags drift on `z.enum([...literals])` when values diverge", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}${PRISMA_BOOKING}`,
      "src/schemas.ts": `
import { z } from "zod";
export const bookingSchema = z.object({
  id: z.string(),
  status: z.enum(["PENDING", "CONFIRMED"]),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R03"] });
      const drift = findings.find((f) => /missing in Zod: CANCELLED/.test(f.message));
      expect(drift).toBeDefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("top-level Z-prefix Zod 4 enum schema with name match passes silently", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
enum UserRole {
  ADMIN
  USER
}

model User {
  id   String   @id
  role UserRole
}
`,
      "src/schemas.ts": `
import { z } from "zod";
import { UserRole } from "@prisma/client";
export const ZUserRole = z.enum(UserRole);
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R03"] });
      expect(findings).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
