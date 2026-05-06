/**
 * UX bug #5 (0.8.0): the runner now attaches a discovery summary to
 * zero-findings runs of static Zod-aware rules, and the pretty formatter
 * surfaces it. Disambiguates "tool ran clean" from "tool didn't see what
 * the user expected".
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatPretty } from "../src/output/pretty.js";
import { run } from "../src/runner.js";

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pz-summary-"));
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

describe("UX bug #5 — runner attaches summary on static-rule runs", () => {
  it("returns a summary with model + schema counts when R01 runs cleanly", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
model User {
  id   String @id
  name String
}
`,
      "src/schemas.ts": `
import { z } from "zod";
export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
});
`,
    });
    try {
      const result = await run({ cwd: tmp, rules: ["R01"] });
      expect(result.findings).toEqual([]);
      expect(result.summary).toBeDefined();
      expect(result.summary?.prismaModelCount).toBe(1);
      expect(result.summary?.zodSchemaCount).toBe(1);
      expect(result.summary?.matchedSchemaCount).toBe(1);
      expect(result.summary?.namingPrefixes).toEqual(["Z"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("reports matchedSchemaCount === 0 when no Zod schemas line up with models", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
model User {
  id String @id
}
`,
      "src/schemas.ts": `
import { z } from "zod";
export const paginationSchema = z.object({
  page: z.number(),
  limit: z.number(),
});
`,
    });
    try {
      const result = await run({ cwd: tmp, rules: ["R01"] });
      expect(result.findings).toEqual([]);
      expect(result.summary?.zodSchemaCount).toBe(1);
      expect(result.summary?.matchedSchemaCount).toBe(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not attach a summary when only R02 ran (R02 doesn't touch Zod)", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
model User {
  id String @id
}
`,
    });
    try {
      const result = await run({ cwd: tmp, rules: ["R02"] });
      expect(result.findings).toEqual([]);
      expect(result.summary).toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("UX bug #5 — pretty output uses summary on zero findings", () => {
  it("falls back to bare `✓ no findings` when no summary is provided", () => {
    const out = formatPretty([], "/cwd");
    expect(out).toContain("no findings");
    expect(out).not.toContain("Prisma model");
  });

  it("appends a parenthesised count line when summary is provided", () => {
    const out = formatPretty([], "/cwd", {
      prismaModelCount: 47,
      zodSchemaCount: 12,
      matchedSchemaCount: 8,
      namingPrefixes: ["Z"],
    });
    expect(out).toContain("47 Prisma model");
    expect(out).toContain("12 Zod schema");
    expect(out).toContain("8 matched");
  });

  it("emits an actionable warning when zodSchemaCount > 0 but matchedSchemaCount === 0", () => {
    const out = formatPretty([], "/cwd", {
      prismaModelCount: 36,
      zodSchemaCount: 488,
      matchedSchemaCount: 0,
      namingPrefixes: ["Z"],
    });
    // Strip ANSI for stable assertions.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences match by design.
    const stripped = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).toContain("no Zod schemas matched");
    expect(stripped).toContain("488 Zod schema");
    expect(stripped).toContain("namingPrefixes");
    // Mentions the active prefixes so the user knows what's in effect.
    expect(stripped).toContain('"Z"');
  });

  it("does not emit the warning shape when matched > 0 even if matched < zodSchemaCount", () => {
    const out = formatPretty([], "/cwd", {
      prismaModelCount: 36,
      zodSchemaCount: 100,
      matchedSchemaCount: 5,
      namingPrefixes: ["Z"],
    });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences match by design.
    const stripped = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(stripped).not.toContain("no Zod schemas matched");
    expect(stripped).toContain("no findings");
  });
});
