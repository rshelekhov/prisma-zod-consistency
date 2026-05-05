import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "../src/runner.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixturesRoot = resolve(here, "../../checks/examples/R05");

const tmpDirs: string[] = [];
afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

async function makeFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pz-r05-next-"));
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

describe("R05 — Next.js bypass detector", () => {
  it("flags every surface in the bad fixture (Route Handler / Server Action / Pages API)", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "next/bad"),
      rules: ["R05"],
    });

    // Expected 5 findings:
    //   route.ts:6           — request.json() in Route Handler
    //   create-user.ts:8     — formData.get("name") in file-level Server Action
    //   create-user.ts:9     — formData.get("email") in file-level Server Action
    //   page.tsx:8           — formData.get("id") in inline Server Action
    //   login.ts:8           — req.body in Pages Router API
    expect(result.findings).toHaveLength(5);
    expect(result.findings.every((f) => f.ruleId === "R05")).toBe(true);
    expect(result.findings.every((f) => f.severity === "warning")).toBe(true);

    const messages = result.findings.map((f) => f.message);
    expect(messages.some((m) => m.includes("Route Handler"))).toBe(true);
    expect(messages.some((m) => m.includes("Server Action (file-level)"))).toBe(true);
    expect(messages.some((m) => m.includes("Server Action (inline)"))).toBe(true);
    expect(messages.some((m) => m.includes("Pages API"))).toBe(true);
  });

  it("emits zero findings on the good fixture (parse + suppression)", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "next/good"),
      rules: ["R05"],
    });
    expect(result.findings).toEqual([]);
  });

  it('framework: "off" disables every Next sub-detector', async () => {
    const root = await makeFixture({
      "prisma/schema.prisma": MIN_PRISMA,
      "src/app/api/users/route.ts": `export async function POST(request: Request) {
  const body = await request.json();
  return Response.json({ ok: true, body });
}
`,
      ".prismazodrc.json": JSON.stringify({ rules: { R05: { framework: "off" } } }),
    });

    const res = await run({ cwd: root, rules: ["R05"] });
    expect(res.findings).toEqual([]);
  });

  it('framework: "next" force-enables on a non-conventional path', async () => {
    // File doesn't sit at the canonical `app/.../route.ts` path, so auto
    // wouldn't pick it up via path detection. With explicit "next" the
    // walker runs anyway — we still need a Next signal (the Server Action
    // directive here) for the file to actually surface findings.
    const root = await makeFixture({
      "prisma/schema.prisma": MIN_PRISMA,
      "src/lib/some-action.ts": `"use server";

export async function submit(formData: FormData) {
  const name = formData.get("name");
  return { name };
}
`,
      ".prismazodrc.json": JSON.stringify({ rules: { R05: { framework: "next" } } }),
    });

    const res = await run({ cwd: root, rules: ["R05"] });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].message).toContain("Server Action");
  });

  it('framework: "auto" detects Next via app/* /route.ts path', async () => {
    const root = await makeFixture({
      "prisma/schema.prisma": MIN_PRISMA,
      "src/app/api/things/route.ts": `export async function POST(req: Request) {
  const body = await req.formData();
  return Response.json({ ok: true });
}
`,
    });

    const res = await run({ cwd: root, rules: ["R05"] });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].message).toContain("Route Handler");
    expect(res.findings[0].message).toContain("formData()");
  });

  it("Route Handler: supports `export const POST = async (req) => …` form", async () => {
    const root = await makeFixture({
      "prisma/schema.prisma": MIN_PRISMA,
      "src/app/api/things/route.ts": `export const POST = async (request: Request) => {
  const blob = await request.blob();
  return Response.json({ size: blob.size });
};
`,
    });

    const res = await run({ cwd: root, rules: ["R05"] });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].message).toContain(".blob()");
  });

  it("does NOT flag `request.text()` (webhooks / signature verification carve-out)", async () => {
    const root = await makeFixture({
      "prisma/schema.prisma": MIN_PRISMA,
      "src/app/api/webhook/route.ts": `export async function POST(request: Request) {
  const raw = await request.text();
  // pretend signature is verified here, then JSON.parse(raw)
  return Response.json({ raw: raw.length });
}
`,
    });

    const res = await run({ cwd: root, rules: ["R05"] });
    expect(res.findings).toEqual([]);
  });

  it("does NOT flag a Server Component without a `'use server'` directive", async () => {
    // <form action={...}> in a Server Component without a 'use server' is
    // either using a client function or referencing a Server Action defined
    // elsewhere. Either way, this file has no Action — no findings.
    const root = await makeFixture({
      "prisma/schema.prisma": MIN_PRISMA,
      "src/app/page.tsx": `async function readForm(formData: FormData) {
  // No 'use server' directive — this is just a helper, not an Action.
  return formData.get("x");
}

export default function Page() {
  return <form>{String(readForm)}</form>;
}
`,
    });

    const res = await run({ cwd: root, rules: ["R05"] });
    expect(res.findings).toEqual([]);
  });

  it("Server Action with `schema.parse(Object.fromEntries(formData))` is auto-skipped", async () => {
    const root = await makeFixture({
      "prisma/schema.prisma": MIN_PRISMA,
      "src/app/actions/safe.ts": `"use server";

import { z } from "zod";

const schema = z.object({ name: z.string() });

export async function submit(formData: FormData) {
  const data = schema.parse(Object.fromEntries(formData));
  return data;
}
`,
    });

    const res = await run({ cwd: root, rules: ["R05"] });
    expect(res.findings).toEqual([]);
  });

  it("does NOT flag bypass shapes outside Next surfaces (random src/ file)", async () => {
    // A file that's not in app/, not in pages/api/, and has no 'use server'
    // — even if it happens to contain a `formData.get(...)` — must not
    // produce findings from the Next walker.
    const root = await makeFixture({
      "prisma/schema.prisma": MIN_PRISMA,
      "src/lib/helpers.ts": `export function readField(formData: FormData) {
  return formData.get("x");
}
`,
    });

    const res = await run({ cwd: root, rules: ["R05"] });
    expect(res.findings).toEqual([]);
  });

  it("Pages API: skips files that already parse `req.body` through Zod", async () => {
    const root = await makeFixture({
      "prisma/schema.prisma": MIN_PRISMA,
      "src/pages/api/safe.ts": `import { z } from "zod";

const schema = z.object({ name: z.string() });

export default function handler(req: any, res: any) {
  const body = schema.parse(req.body);
  res.status(200).json(body);
}
`,
    });

    const res = await run({ cwd: root, rules: ["R05"] });
    expect(res.findings).toEqual([]);
  });

  it("skips files importing a known Server Action wrapper (next-safe-action)", async () => {
    const root = await makeFixture({
      "prisma/schema.prisma": MIN_PRISMA,
      "src/app/actions/wrapped.ts": `"use server";

import { createSafeActionClient } from "next-safe-action";
import { z } from "zod";

const action = createSafeActionClient();

export const submit = action
  .schema(z.object({ name: z.string() }))
  .action(async ({ parsedInput }) => {
    return parsedInput;
  });

// The file LOOKS like a Server Action with FormData reads, but the wrapper
// guarantees the parse — so we skip the whole file.
export async function rawHelper(formData: FormData) {
  return formData.get("debug");
}
`,
    });

    const res = await run({ cwd: root, rules: ["R05"] });
    expect(res.findings).toEqual([]);
  });
});
