/**
 * 0.10.1 — `RunResult.skippedRules` reports a structured reason per skipped
 * rule, so the CLI can split the old generic "skipped unregistered or
 * unsatisfied rule(s)" note into three actionable cases:
 *
 *   - `unknown`   — typo in `--rules`; CLI exits with 2 (bad invocation).
 *   - `needs-db`  — live-DB rule without `--db`; CLI emits info note.
 *   - `disabled`  — `severity: "off"` in config; CLI stays silent.
 *
 * Fixes the 0.9.0 follow-up where `--rules R99` slipped through with
 * exit=0 because typos and "needs --db" looked identical in stderr.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/runner.js";
import type { RuleId } from "../src/types.js";

const POSTGRES_DATASOURCE = `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
generator client {
  provider = "prisma-client-js"
}
`;

async function makeProject(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pz-skip-reasons-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

const minimalProject = {
  "prisma/schema.prisma": `${POSTGRES_DATASOURCE}
model User {
  id Int @id @default(autoincrement())
}
`,
  "src/schemas/user.ts": `import { z } from "zod";
export const UserSchema = z.object({ id: z.number().int() });
`,
};

describe("RunResult.skippedRules — reason: unknown", () => {
  it("typo in --rules surfaces as reason=unknown, not in ranRules", async () => {
    const dir = await makeProject(minimalProject);
    const result = await run({ cwd: dir, rules: ["R01", "R99" as RuleId] });
    const unknown = result.skippedRules.filter((s) => s.reason === "unknown");
    expect(unknown.map((s) => s.id)).toEqual(["R99"]);
    expect(result.ranRules).toContain("R01");
    expect(result.ranRules).not.toContain("R99");
  });

  it("non-existent rule id keeps the raw id string in skippedRules (not normalized)", async () => {
    const dir = await makeProject(minimalProject);
    const result = await run({ cwd: dir, rules: ["rXX-typo" as RuleId] });
    const unknown = result.skippedRules.find((s) => s.reason === "unknown");
    expect(unknown?.id).toBe("rXX-typo");
  });
});

describe("RunResult.skippedRules — reason: needs-db", () => {
  it("live-DB rules without --db are reported as needs-db", async () => {
    const dir = await makeProject(minimalProject);
    // R07-R09d are live-DB. Without --db (default), they should all skip
    // as `needs-db`, not as `unknown`.
    const result = await run({
      cwd: dir,
      rules: ["R07", "R08", "R09", "R09b", "R09c", "R09d"] as RuleId[],
    });
    const needsDb = result.skippedRules
      .filter((s) => s.reason === "needs-db")
      .map((s) => s.id)
      .sort();
    expect(needsDb).toEqual(["R07", "R08", "R09", "R09b", "R09c", "R09d"].sort());
    expect(result.skippedRules.some((s) => s.reason === "unknown")).toBe(false);
  });

  it("default run (no --rules, no --db) reports all live-DB rules as needs-db", async () => {
    const dir = await makeProject(minimalProject);
    const result = await run({ cwd: dir });
    const reasons = new Set(result.skippedRules.map((s) => s.reason));
    expect(reasons).toContain("needs-db");
    expect(reasons).not.toContain("unknown");
  });
});

describe("RunResult.skippedRules — reason: disabled", () => {
  it("severity: off in config surfaces as reason=disabled", async () => {
    const dir = await makeProject({
      ...minimalProject,
      ".prismazodrc.json": JSON.stringify(
        {
          rules: {
            R03: { severity: "off" },
          },
        },
        null,
        2,
      ),
    });
    const result = await run({ cwd: dir, rules: ["R01", "R03"] });
    const disabled = result.skippedRules.find((s) => s.reason === "disabled");
    expect(disabled?.id).toBe("R03");
    expect(result.ranRules).toContain("R01");
    expect(result.ranRules).not.toContain("R03");
  });
});

describe("RunResult.skippedRules — mixed reasons in one run", () => {
  it("groups unknown / needs-db / disabled correctly when all three are requested at once", async () => {
    const dir = await makeProject({
      ...minimalProject,
      ".prismazodrc.json": JSON.stringify({ rules: { R04: { severity: "off" } } }),
    });
    const result = await run({
      cwd: dir,
      rules: ["R01", "R04", "R07", "R99" as RuleId],
    });

    const byReason = (reason: string): string[] =>
      result.skippedRules
        .filter((s) => s.reason === reason)
        .map((s) => s.id)
        .sort();

    expect(byReason("unknown")).toEqual(["R99"]);
    expect(byReason("needs-db")).toEqual(["R07"]);
    expect(byReason("disabled")).toEqual(["R04"]);
    expect(result.ranRules).toContain("R01");
  });
});
