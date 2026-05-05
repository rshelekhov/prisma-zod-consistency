import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "../src/runner.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixturesRoot = resolve(here, "../../checks/examples/R05");

// Helper for tests that need a custom .prismazodrc — the file fixtures don't
// carry one because we want them to exercise the default ("auto") config.
const tmpDirs: string[] = [];
afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

async function makeFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pz-r05-trpc-"));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf-8");
  }
  return root;
}

const MIN_PRISMA = `generator client {
  provider = "prisma-client-js"
}
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
model User {
  id String @id @default(cuid())
}
`;

describe("R05 — tRPC procedures missing .input(...)", () => {
  it("flags all three bypass variants in the bad fixture", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "trpc/bad"),
      rules: ["R05"],
    });

    expect(result.findings.length).toBe(3);
    expect(result.findings.every((f) => f.ruleId === "R05")).toBe(true);
    expect(result.findings.every((f) => f.message.includes("tRPC"))).toBe(true);
    expect(result.findings.every((f) => f.severity === "warning")).toBe(true);

    const lines = result.findings.map((f) => f.location.line).sort((a, b) => a - b);
    // getUser: t.procedure.query(({ input }) => …)         → line 14
    // createUser: publicProcedure.mutation(({ input }) =>) → line 20
    // updateUser: protectedProcedure.mutation((input) =>)  → line 27
    expect(lines).toEqual([14, 20, 27]);

    // Sanity: at least one is a `.mutation(...)` finding (these are the
    // dangerous ones — input flows into prisma.create).
    expect(result.findings.some((f) => f.message.includes(".mutation"))).toBe(true);
    expect(result.findings.some((f) => f.message.includes(".query"))).toBe(true);
  });

  it("emits zero findings on the good fixture", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "trpc/good"),
      rules: ["R05"],
    });

    expect(result.findings).toEqual([]);
  });

  it("`.input(z.void())` counts as an explicit no-input declaration", async () => {
    const root = await makeFixture({
      "prisma/schema.prisma": MIN_PRISMA,
      "src/router.ts": `import { initTRPC } from "@trpc/server";
import { z } from "zod";

const t = initTRPC.create();

export const router = t.router({
  ping: t.procedure.input(z.void()).query(({ input }) => {
    void input;
    return "pong";
  }),
  noop: t.procedure.input(z.undefined()).mutation(({ input }) => {
    void input;
    return null;
  }),
});
`,
    });

    const res = await run({ cwd: root, rules: ["R05"] });
    expect(res.findings).toEqual([]);
  });

  it("handler with no parameters is not a bypass (pure GET)", async () => {
    const root = await makeFixture({
      "prisma/schema.prisma": MIN_PRISMA,
      "src/router.ts": `import { initTRPC } from "@trpc/server";

const t = initTRPC.create();

export const router = t.router({
  // No \`input\` parameter — nothing to validate, nothing to flag.
  listUsers: t.procedure.query(() => [{ id: "1" }]),
  ping: t.procedure.mutation(() => null),
});
`,
    });

    const res = await run({ cwd: root, rules: ["R05"] });
    expect(res.findings).toEqual([]);
  });

  it('framework: "off" disables the detector entirely', async () => {
    const root = await makeFixture({
      "prisma/schema.prisma": MIN_PRISMA,
      "src/router.ts": `import { initTRPC } from "@trpc/server";

const t = initTRPC.create();

export const router = t.router({
  getUser: t.procedure.query(({ input }) => ({ id: input })),
});
`,
      ".prismazodrc.json": JSON.stringify({
        rules: { R05: { framework: "off" } },
      }),
    });

    const res = await run({ cwd: root, rules: ["R05"] });
    expect(res.findings).toEqual([]);
  });

  it('framework: "trpc" explicit force-enables the detector', async () => {
    // Same router as above, but pinned framework. Sanity check that an
    // explicit setting works the same as auto when the import is present.
    const root = await makeFixture({
      "prisma/schema.prisma": MIN_PRISMA,
      "src/router.ts": `import { initTRPC } from "@trpc/server";

const t = initTRPC.create();

export const router = t.router({
  getUser: t.procedure.query(({ input }) => ({ id: input })),
});
`,
      ".prismazodrc.json": JSON.stringify({
        rules: { R05: { framework: "trpc" } },
      }),
    });

    const res = await run({ cwd: root, rules: ["R05"] });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].message).toContain("tRPC");
  });

  it('framework: "auto" picks up the detector when @trpc/server is imported', async () => {
    // No explicit framework config, no Hono import either — auto must
    // dispatch to tRPC purely on the import.
    const root = await makeFixture({
      "prisma/schema.prisma": MIN_PRISMA,
      "src/router.ts": `import { initTRPC } from "@trpc/server";

const t = initTRPC.create();

export const router = t.router({
  getUser: t.procedure.query(({ input }) => ({ id: input })),
});
`,
    });

    const res = await run({ cwd: root, rules: ["R05"] });
    expect(res.findings).toHaveLength(1);
  });

  it("does not flag .query()/.mutation() chains in non-tRPC files (import gate)", async () => {
    // A file that uses `.query(...)` but never imports @trpc/server (e.g. a
    // hand-written Mongo-style helper) must NOT trigger R05.
    const root = await makeFixture({
      "prisma/schema.prisma": MIN_PRISMA,
      "src/db.ts": `// No tRPC import — must be ignored.
const db = {
  collection: (_name: string) => ({
    query: (handler: (input: unknown) => unknown) => handler,
  }),
};

export const find = db.collection("users").query((input) => ({ found: input }));
`,
    });

    const res = await run({ cwd: root, rules: ["R05"] });
    expect(res.findings).toEqual([]);
  });
});
