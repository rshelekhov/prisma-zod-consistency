/**
 * R01 directionality classification (0.8.0).
 *
 * Smoke on dub showed ~13/55 R01 findings were "Zod stricter than Prisma":
 *   z.email() on String, z.url() on String, z.array(...) on Json — Zod
 * refines, doesn't drift. The new `R01.directionalityMode` config lets
 * teams either downgrade those to `info` or drop them entirely.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/runner.js";

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pz-r01-direction-"));
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

describe("R01 directionality — strict (default) mode", () => {
  it("flags z.email() on a plain String field as error (backwards compat)", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
model User {
  id    String @id
  email String
}
`,
      "src/schemas.ts": `
import { z } from "zod";
export const userSchema = z.object({
  id: z.string(),
  email: z.email(),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R01"] });
      const emailFinding = findings.find((f) => /email/.test(f.message));
      expect(emailFinding).toBeDefined();
      expect(emailFinding?.severity).toBe("error");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("flags z.array() on a Json field as error (backwards compat)", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
model Webhook {
  id      String @id
  payload Json
}
`,
      "src/schemas.ts": `
import { z } from "zod";
export const webhookSchema = z.object({
  id: z.string(),
  payload: z.array(z.string()),
});
`,
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R01"] });
      const finding = findings.find((f) => /payload/.test(f.message));
      expect(finding).toBeDefined();
      expect(finding?.severity).toBe("error");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("R01 directionality — actionable mode", () => {
  it("downgrades z.email() on String from error to info", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
model User {
  id    String @id
  email String
}
`,
      "src/schemas.ts": `
import { z } from "zod";
export const userSchema = z.object({
  id: z.string(),
  email: z.email(),
});
`,
      ".prismazodrc.json": JSON.stringify({
        rules: { R01: { directionalityMode: "actionable" } },
      }),
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R01"] });
      const emailFinding = findings.find((f) => /email/.test(f.message));
      expect(emailFinding).toBeDefined();
      expect(emailFinding?.severity).toBe("info");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("keeps zod-weaker issues at full severity (missing-int still error)", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
model Item {
  id    String @id
  count Int
}
`,
      "src/schemas.ts": `
import { z } from "zod";
export const itemSchema = z.object({
  id: z.string(),
  count: z.number(),
});
`,
      ".prismazodrc.json": JSON.stringify({
        rules: { R01: { directionalityMode: "actionable" } },
      }),
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R01"] });
      const intFinding = findings.find(
        (f) => /count/.test(f.message) && /\.int\(\)/.test(f.message),
      );
      expect(intFinding).toBeDefined();
      expect(intFinding?.severity).toBe("error");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("downgrades z.url() on String from error to info", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
model Link {
  id  String @id
  url String
}
`,
      "src/schemas.ts": `
import { z } from "zod";
export const linkSchema = z.object({
  id: z.string(),
  url: z.url(),
});
`,
      ".prismazodrc.json": JSON.stringify({
        rules: { R01: { directionalityMode: "actionable" } },
      }),
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R01"] });
      const urlFinding = findings.find((f) => /url/.test(f.message));
      expect(urlFinding).toBeDefined();
      expect(urlFinding?.severity).toBe("info");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("R01 directionality — off-stricter mode", () => {
  it("drops z.email() on String findings entirely", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
model User {
  id    String @id
  email String
}
`,
      "src/schemas.ts": `
import { z } from "zod";
export const userSchema = z.object({
  id: z.string(),
  email: z.email(),
});
`,
      ".prismazodrc.json": JSON.stringify({
        rules: { R01: { directionalityMode: "off-stricter" } },
      }),
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R01"] });
      const emailFinding = findings.find((f) => /email/.test(f.message));
      expect(emailFinding).toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("preserves zod-weaker issues even in off-stricter mode", async () => {
    const tmp = await makeTempProject({
      "prisma/schema.prisma": `${PRISMA_HEADER}
model Item {
  id    String @id
  count Int
}
`,
      "src/schemas.ts": `
import { z } from "zod";
export const itemSchema = z.object({
  id: z.string(),
  count: z.number(),
});
`,
      ".prismazodrc.json": JSON.stringify({
        rules: { R01: { directionalityMode: "off-stricter" } },
      }),
    });
    try {
      const { findings } = await run({ cwd: tmp, rules: ["R01"] });
      const intFinding = findings.find((f) => /count/.test(f.message));
      expect(intFinding).toBeDefined();
      expect(intFinding?.severity).toBe("error");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
