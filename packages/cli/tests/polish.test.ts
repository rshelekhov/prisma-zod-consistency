/**
 * Tests for the 0.1.1 "polish for launch" pass:
 *   - B6: R03 skips already-valid pipe-chains.
 *   - B7: R01 inserts .int() before .nullable()/.optional()/.nullish().
 *   - B2: R03 fix merges into an existing @prisma/client named import
 *         instead of producing a second one.
 *   - B1: R02 reports real source line numbers (not the previous fallback
 *         of `:1` for every finding).
 *   - B5: pz-fix's diff is a real Myers-based unified diff — unchanged
 *         lines outside the edit window do not appear with +/- markers.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyFixes } from "../src/fix/apply.js";
import { formatDiff } from "../src/fix/diff.js";
import { run } from "../src/runner.js";

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pz-polish-"));
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

describe("B6 — R03 skips already-valid pipe-chains", () => {
  it("does not flag z.string().transform(...).pipe(z.nativeEnum(Foo)) when Foo matches", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
enum Channel {
  EMAIL
  SMS
  WHATSAPP
}

model Conversation {
  id      String  @id
  channel Channel
}
`,
      "src/schemas/conversation.ts": `
import { z } from "zod";
import { Channel } from "@prisma/client";
export const conversationSchema = z.object({
  id: z.string(),
  channel: z
    .string()
    .transform((v) => v.toUpperCase())
    .pipe(z.nativeEnum(Channel)),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R03"] });
      const channelFindings = findings.filter((f) => f.scope?.field === "channel");
      expect(channelFindings).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not flag .pipe(<knownEnumSchema>) when the schema is bound to the matching Prisma enum", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
enum Channel {
  EMAIL
  SMS
}

model Conversation {
  id      String  @id
  channel Channel
}
`,
      "src/schemas/conversation.ts": `
import { z } from "zod";
import { Channel } from "@prisma/client";
export const channelSchema = z.nativeEnum(Channel);
export const conversationSchema = z.object({
  id: z.string(),
  channel: z.string().pipe(channelSchema),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R03"] });
      const channelFindings = findings.filter((f) => f.scope?.field === "channel");
      expect(channelFindings).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("still flags pipe-chains that target the wrong Prisma enum", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
enum Channel {
  EMAIL
  SMS
}

enum Priority {
  LOW
  HIGH
}

model Conversation {
  id      String  @id
  channel Channel
}
`,
      "src/schemas/conversation.ts": `
import { z } from "zod";
import { Priority } from "@prisma/client";
export const conversationSchema = z.object({
  id: z.string(),
  channel: z.string().pipe(z.nativeEnum(Priority)),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R03"] });
      const channelFindings = findings.filter((f) => f.scope?.field === "channel");
      expect(channelFindings.length).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("B7 — R01 inserts .int() before .nullable() modifiers", () => {
  it("places .int() ahead of .nullable() in the chain", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
model Item {
  id    String @id
  count Int?
}
`,
      "src/schemas/item.ts": `
import { z } from "zod";
export const itemSchema = z.object({
  id: z.string(),
  count: z.number().nullable(),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R01"] });
      const fixable = findings.filter((f) => f.fix !== undefined);
      expect(fixable.length).toBeGreaterThanOrEqual(1);

      await applyFixes(fixable, { write: true });

      const updated = await readFile(join(tmp, "src/schemas/item.ts"), "utf8");
      expect(updated).toContain("count: z.number().int().nullable()");
      expect(updated).not.toContain(".nullable().int()");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("B2 — R03 fix merges named imports into the existing @prisma/client import", () => {
  it('extends a single-line `import { Foo } from "@prisma/client"` instead of adding a second import', async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
enum BookingStatus {
  PENDING
  CONFIRMED
  CANCELLED
}

model Booking {
  id     String         @id
  status BookingStatus
}
`,
      "src/schemas/booking.ts": `
import { z } from "zod";
import { OtherSym } from "@prisma/client";

const _unused: OtherSym | undefined = undefined;
void _unused;

export const bookingSchema = z.object({
  id: z.string(),
  status: z.string(),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R03"] });
      const fixable = findings.filter((f) => f.fix !== undefined);
      expect(fixable.length).toBe(1);

      await applyFixes(fixable, { write: true });

      const updated = await readFile(join(tmp, "src/schemas/booking.ts"), "utf8");

      // Single combined import
      const importMatches = updated.match(/import .* from "@prisma\/client"/g) ?? [];
      expect(importMatches.length).toBe(1);
      expect(importMatches[0]).toContain("OtherSym");
      expect(importMatches[0]).toContain("BookingStatus");
      expect(updated).toContain("z.nativeEnum(BookingStatus)");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to a fresh import when @prisma/client is not yet imported", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
enum BookingStatus {
  PENDING
  CONFIRMED
}

model Booking {
  id     String         @id
  status BookingStatus
}
`,
      "src/schemas/booking.ts": `
import { z } from "zod";
export const bookingSchema = z.object({
  id: z.string(),
  status: z.string(),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R03"] });
      const fixable = findings.filter((f) => f.fix !== undefined);
      expect(fixable.length).toBe(1);

      await applyFixes(fixable, { write: true });
      const updated = await readFile(join(tmp, "src/schemas/booking.ts"), "utf8");
      expect(updated).toContain('import { BookingStatus } from "@prisma/client"');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("B1 — R02 reports the real line of the relation field", () => {
  it("locates the relation declaration in the source instead of falling back to line 1", async () => {
    const schemaSource = `${PRISMA_HEADER}
model User {
  id    String @id
  posts Post[]
}

model Post {
  id       String @id
  authorId String
  author   User   @relation(fields: [authorId], references: [id])
}
`;
    const tmp = await makeTempProject({ "prisma/schema.prisma": schemaSource });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R02"] });
      expect(findings.length).toBe(1);
      const finding = findings[0];
      expect(finding).toBeDefined();
      // Compute expected line dynamically from the source.
      const expectedLine =
        schemaSource.split("\n").findIndex((l) => /^\s*author\s+User\s+@relation/.test(l)) + 1;
      expect(finding?.location.line).toBe(expectedLine);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("B5 — pz-fix diff is a real unified diff", () => {
  it("does not surface unchanged lines as +/- markers", () => {
    const oldContent = "line one\nline two\nline three\nline four\nline five\n";
    const newContent = "line one\nline two\nLINE THREE CHANGED\nline four\nline five\n";

    const out = formatDiff(
      [
        {
          file: "/abs/foo.ts",
          oldContent,
          newContent,
          applied: 1,
          skipped: 0,
        },
      ],
      "/abs",
    );

    // Strip ANSI escape codes for the structural assertions below.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escape sequences requires the ESC byte by definition.
    const stripped = out.replace(/\x1b\[[0-9;]*m/g, "");
    const lines = stripped.split("\n");

    // Real edit lines: a single `-line three` and a single `+LINE THREE CHANGED`.
    // The `--- file` / `+++ file` headers start with three chars, so they're filtered out.
    const minus = lines.filter((l) => l.startsWith("-") && !l.startsWith("---"));
    const plus = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(minus).toEqual(["-line three"]);
    expect(plus).toEqual(["+LINE THREE CHANGED"]);

    // Hunk header is present.
    expect(stripped).toMatch(/@@/);
  });
});
