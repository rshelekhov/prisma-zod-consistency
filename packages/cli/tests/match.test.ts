/**
 * Tests for `matchSchemasToModels` and `stripAffixes` — including the
 * Bug #2 (0.8.0) leading-prefix strip with PascalCase boundary check.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/runner.js";
import { parsePrismaRegistry } from "../src/schema/prisma-models.js";
import type { ZodSchemaInfo } from "../src/zod/discover.js";
import { matchSchemasToModels, stripAffixes } from "../src/zod/match.js";

const PRISMA_HEADER = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
`;

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pz-match-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

describe("stripAffixes — leading single-character prefix strip", () => {
  it("strips a leading `Z` when followed by uppercase (PascalCase boundary)", () => {
    expect(stripAffixes("ZUser", ["Z"])).toBe("User");
    expect(stripAffixes("ZTeam", ["Z"])).toBe("Team");
    expect(stripAffixes("ZApiKey", ["Z"])).toBe("ApiKey");
    expect(stripAffixes("ZOrganization", ["Z"])).toBe("Organization");
  });

  it("does NOT strip `Z` when followed by lowercase (e.g. `Zone`, `Zoo`)", () => {
    expect(stripAffixes("Zone", ["Z"])).toBe("Zone");
    expect(stripAffixes("Zoo", ["Z"])).toBe("Zoo");
    expect(stripAffixes("Zebra", ["Z"])).toBe("Zebra");
  });

  it("composes prefix strip with trailing affix strip in any order", () => {
    expect(stripAffixes("ZUserSchema", ["Z"])).toBe("User");
    expect(stripAffixes("ZUserCreateInput", ["Z"])).toBe("User");
    expect(stripAffixes("ZUserResponseDto", ["Z"])).toBe("User");
  });

  it("supports multiple prefixes (T, I) when the user opts in", () => {
    expect(stripAffixes("TUser", ["T", "I"])).toBe("User");
    expect(stripAffixes("IUser", ["T", "I"])).toBe("User");
    // Boundary still respected — `Tagline`/`Iframe` keep their leading char.
    expect(stripAffixes("Tagline", ["T", "I"])).toBe("Tagline");
    expect(stripAffixes("Iframe", ["T", "I"])).toBe("Iframe");
  });

  it("does nothing when `namingPrefixes` is empty", () => {
    expect(stripAffixes("ZUser", [])).toBe("ZUser");
    expect(stripAffixes("IUser", [])).toBe("IUser");
  });

  it('preserves the conservative default of `["Z"]` when prefix arg is omitted', () => {
    expect(stripAffixes("ZUser")).toBe("User");
    // T and I should NOT strip by default.
    expect(stripAffixes("TUser")).toBe("TUser");
    expect(stripAffixes("IUser")).toBe("IUser");
  });

  it("never strips a single-char `core` to the empty string", () => {
    // `ZSchema` → `Z` (after `Schema`), then prefix check rejects because
    // `core.length === prefix.length` is not strictly greater.
    expect(stripAffixes("ZSchema", ["Z"])).toBe("Z");
  });

  it("supports custom user-defined prefixes", () => {
    expect(stripAffixes("XUser", ["X"])).toBe("User");
  });
});

describe("matchSchemasToModels — Z-prefix integration with model registry", () => {
  it("matches ZUser/ZTeam/ZApiKey to User/Team/ApiKey models with default prefixes", () => {
    const registry = parsePrismaRegistry(`${PRISMA_HEADER}
model User {
  id String @id
}

model Team {
  id String @id
}

model ApiKey {
  id String @id
}
`);
    const schemas: ZodSchemaInfo[] = [
      mockObjectSchema("ZUser"),
      mockObjectSchema("ZTeam"),
      mockObjectSchema("ZApiKey"),
    ];
    const matches = matchSchemasToModels(schemas, registry);
    const names = matches.map((m) => `${m.zod.name}→${m.modelName}`).sort();
    expect(names).toEqual(["ZApiKey→ApiKey", "ZTeam→Team", "ZUser→User"]);
  });

  it("ignores the Z prefix when namingPrefixes is empty", () => {
    const registry = parsePrismaRegistry(`${PRISMA_HEADER}
model User {
  id String @id
}
`);
    const schemas: ZodSchemaInfo[] = [mockObjectSchema("ZUser")];
    const matches = matchSchemasToModels(schemas, registry, []);
    expect(matches).toEqual([]);
  });

  it("does not falsely match `Zone` to a hypothetical `One` model", () => {
    const registry = parsePrismaRegistry(`${PRISMA_HEADER}
model One {
  id String @id
}
`);
    const schemas: ZodSchemaInfo[] = [mockObjectSchema("Zone")];
    const matches = matchSchemasToModels(schemas, registry, ["Z"]);
    expect(matches).toEqual([]);
  });
});

describe("Bug #2 e2e — full run() against a Z-prefix project", () => {
  it("emits R01 findings for ZUser-style schemas with the default config", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
model User {
  id    String @id
  count Int
}
`,
      "src/schemas.ts": `
import { z } from "zod";
export const ZUser = z.object({
  id: z.string(),
  count: z.number(),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R01"] });
      // count is `Int` in Prisma but `z.number()` (no .int()) in Zod — R01 must catch it.
      const intMissing = findings.find((f) => f.message.includes("count"));
      expect(intMissing).toBeDefined();
      expect(intMissing?.message).toContain(".int()");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("emits zero R01 findings when namingPrefixes is set to []", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
model User {
  id    String @id
  count Int
}
`,
      "src/schemas.ts": `
import { z } from "zod";
export const ZUser = z.object({
  id: z.string(),
  count: z.number(),
});
`,
      ".prismazodrc.json": JSON.stringify({ namingPrefixes: [] }),
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R01"] });
      expect(findings).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("opts into T/I prefixes via config", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
model User {
  id    String @id
  count Int
}
`,
      "src/schemas.ts": `
import { z } from "zod";
export const TUser = z.object({
  id: z.string(),
  count: z.number(),
});
`,
      ".prismazodrc.json": JSON.stringify({ namingPrefixes: ["T"] }),
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R01"] });
      const intMissing = findings.find((f) => f.message.includes("count"));
      expect(intMissing).toBeDefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

function mockObjectSchema(name: string): ZodSchemaInfo {
  return {
    name,
    file: "/mock/file.ts",
    line: 1,
    shape: { kind: "object", fields: [] },
  };
}
