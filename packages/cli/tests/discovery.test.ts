/**
 * Discovery-layer tests:
 *   - Bug #4 (0.8.0): `from "zod/v4"` and `from "zod/v3"` imports must trigger
 *     the `generated` → `hybrid` upgrade just like the bare `zod` import.
 *   - Bug #1 (0.8.0): multi-file Prisma schema support — `schemaPath` may
 *     point at a file, with sibling `*.prisma` files folded in, OR at a
 *     directory containing `*.prisma` files.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { discover } from "../src/discovery.js";
import { run } from "../src/runner.js";
import {
  loadSchemaSource,
  mapCombinedLine,
  stripTopLevelBlocks,
} from "../src/schema/load-schema.js";

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pz-discovery-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

const POSTGRES_DATASOURCE = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
`;

const ZOD_PRISMA_TYPES_GENERATOR = `generator zod {
  provider = "zod-prisma-types"
  output   = "./generated/zod"
}
`;

describe("Bug #4 — hybrid promotion recognises zod/v3 and zod/v4 imports", () => {
  it("upgrades generated → hybrid when a source file imports from `zod`", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${POSTGRES_DATASOURCE}\n${ZOD_PRISMA_TYPES_GENERATOR}`,
      "src/schemas/extra.ts": `import { z } from "zod";\nexport const s = z.object({});\n`,
    });
    try {
      const config = await loadConfig(tmp);
      const ctx = await discover(config);
      expect(ctx.zodMode.kind).toBe("hybrid");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("upgrades generated → hybrid when a source file imports from `zod/v3`", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${POSTGRES_DATASOURCE}\n${ZOD_PRISMA_TYPES_GENERATOR}`,
      "src/schemas/extra.ts": `import { z } from "zod/v3";\nexport const s = z.object({});\n`,
    });
    try {
      const config = await loadConfig(tmp);
      const ctx = await discover(config);
      expect(ctx.zodMode.kind).toBe("hybrid");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("upgrades generated → hybrid when a source file imports from `zod/v4`", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${POSTGRES_DATASOURCE}\n${ZOD_PRISMA_TYPES_GENERATOR}`,
      "src/schemas/extra.ts": `import * as z from "zod/v4";\nexport const s = z.object({});\n`,
    });
    try {
      const config = await loadConfig(tmp);
      const ctx = await discover(config);
      expect(ctx.zodMode.kind).toBe("hybrid");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('recognises type-only imports too (`import type { z } from "zod/v4"`)', async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${POSTGRES_DATASOURCE}\n${ZOD_PRISMA_TYPES_GENERATOR}`,
      "src/schemas/extra.ts": `import type { z } from "zod/v4";\nexport type Z = typeof z;\n`,
    });
    try {
      const config = await loadConfig(tmp);
      const ctx = await discover(config);
      expect(ctx.zodMode.kind).toBe("hybrid");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("stays in generated mode when no source file imports zod at all", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${POSTGRES_DATASOURCE}\n${ZOD_PRISMA_TYPES_GENERATOR}`,
      "src/util.ts": `export const greeting = "hello";\n`,
    });
    try {
      const config = await loadConfig(tmp);
      const ctx = await discover(config);
      expect(ctx.zodMode.kind).toBe("generated");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not match unrelated suffixes (`zod-form-data`, `zodios`)", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${POSTGRES_DATASOURCE}\n${ZOD_PRISMA_TYPES_GENERATOR}`,
      "src/util.ts": `import { zfd } from "zod-form-data";\nimport { Zodios } from "@zodios/core";\nexport { zfd, Zodios };\n`,
    });
    try {
      const config = await loadConfig(tmp);
      const ctx = await discover(config);
      // Neither import targets the real `zod` package — must not be promoted.
      expect(ctx.zodMode.kind).toBe("generated");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("Bug #1 — multi-file Prisma schema support", () => {
  it("concatenates sibling .prisma files when schemaPath points at the entry file", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${POSTGRES_DATASOURCE}`,
      "prisma/user.prisma": `model User {
  id    String @id
  posts Post[]
}
`,
      "prisma/post.prisma": `model Post {
  id       String @id
  authorId String
  author   User   @relation(fields: [authorId], references: [id])
}
`,
    });
    try {
      const loaded = await loadSchemaSource(resolve(tmp, "prisma/schema.prisma"));
      expect(loaded.multiFile).toBe(true);
      expect(loaded.files).toHaveLength(3);
      expect(loaded.schemaSource).toContain("model User");
      expect(loaded.schemaSource).toContain("model Post");
      expect(loaded.schemaSource).toContain("datasource db");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("treats schemaPath as a directory and discovers every *.prisma inside", async () => {
    const tmp = await makeTempProject({
      "prisma/datasource.prisma": `${POSTGRES_DATASOURCE}`,
      "prisma/user.prisma": `model User {
  id String @id
}
`,
      "prisma/team.prisma": `model Team {
  id String @id
}
`,
    });
    try {
      const loaded = await loadSchemaSource(resolve(tmp, "prisma"));
      expect(loaded.multiFile).toBe(true);
      expect(loaded.files).toHaveLength(3);
      // datasource.prisma sorts first alphabetically, so it becomes the entry.
      expect(loaded.primaryFile).toContain("datasource.prisma");
      expect(loaded.schemaSource).toMatch(/datasource db/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("strips duplicate datasource/generator blocks from non-entry files", async () => {
    // Both files declare `datasource` — the second copy must be removed,
    // otherwise @mrleebo/prisma-ast will reject the input.
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${POSTGRES_DATASOURCE}`,
      "prisma/extra.prisma": `${POSTGRES_DATASOURCE}\nmodel User {
  id String @id
}
`,
    });
    try {
      const loaded = await loadSchemaSource(resolve(tmp, "prisma/schema.prisma"));
      const datasourceCount = (loaded.schemaSource.match(/datasource db/g) ?? []).length;
      expect(datasourceCount).toBe(1);
      expect(loaded.schemaSource).toContain("model User");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("preserves source-line origins so R02 reports against the original file", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${POSTGRES_DATASOURCE}`,
      "prisma/user.prisma": `model User {
  id    String @id
  posts Post[]
}
`,
      "prisma/post.prisma": `model Post {
  id       String @id
  authorId String
  author   User   @relation(fields: [authorId], references: [id])
}
`,
      "src/dummy.ts": "export const x = 1;\n",
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R02"] });
      expect(findings).toHaveLength(1);
      const finding = findings[0];
      expect(finding).toBeDefined();
      // The relation lives in post.prisma, line 4 (`author User @relation...`).
      expect(finding?.location.file.endsWith("post.prisma")).toBe(true);
      expect(finding?.location.line).toBe(4);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("end-to-end run: R01 sees models from every .prisma file, not just the entry", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${POSTGRES_DATASOURCE}`,
      "prisma/user.prisma": `model User {
  id    String @id
  count Int
}
`,
      "src/schemas.ts": `
import { z } from "zod";
export const userSchema = z.object({
  id: z.string(),
  count: z.number(),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R01"] });
      // count Int + z.number() (no .int()) → R01 must fire only when User
      // model is actually visible (proves the multi-file glue works).
      const intMissing = findings.find((f) => f.message.includes("count"));
      expect(intMissing).toBeDefined();
      expect(intMissing?.message).toContain(".int()");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to single-file behavior with identity line mapping", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${POSTGRES_DATASOURCE}\nmodel User {\n  id String @id\n}\n`,
    });
    try {
      const loaded = await loadSchemaSource(resolve(tmp, "prisma/schema.prisma"));
      expect(loaded.multiFile).toBe(false);
      // Identity map: combined line N must trace back to file line N.
      const lines = loaded.schemaSource.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const origin = mapCombinedLine(i + 1, loaded.schemaSourceMap, loaded.primaryFile);
        expect(origin.file).toBe(loaded.primaryFile);
        expect(origin.line).toBe(i + 1);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("throws DiscoveryError when the directory contains no .prisma files", async () => {
    const tmp = await makeTempProject({ "prisma/.keep": "" });
    try {
      await expect(loadSchemaSource(resolve(tmp, "prisma"))).rejects.toThrow(/no \.prisma files/i);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("stripTopLevelBlocks helper", () => {
  it("removes a top-level datasource block and tracks the surviving line numbers", () => {
    const source = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id String @id
}
`;
    const { text, lineMap } = stripTopLevelBlocks(source, ["datasource"]);
    expect(text).not.toContain("datasource db");
    expect(text).toContain("model User");
    // The surviving lines start where `model User` begins (original line 6).
    const idxOfModel = text.split("\n").findIndex((l) => l.startsWith("model User"));
    expect(lineMap[idxOfModel]).toBe(6);
  });

  it("removes both datasource and generator blocks", () => {
    const source = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

model User {
  id String @id
}
`;
    const { text } = stripTopLevelBlocks(source, ["datasource", "generator"]);
    expect(text).not.toContain("generator");
    expect(text).not.toContain("datasource");
    expect(text).toContain("model User");
  });

  it("leaves other top-level blocks (model, enum) alone", () => {
    const source = `model A {
  id String @id
}

model B {
  id String @id
}
`;
    const { text } = stripTopLevelBlocks(source, ["datasource", "generator"]);
    expect(text).toContain("model A");
    expect(text).toContain("model B");
  });
});
