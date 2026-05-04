import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/runner.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixturesRoot = resolve(here, "../../checks/examples/R01");

describe("R01 — Zod ↔ Prisma drift (R01a scope)", () => {
  it("flags type mismatch, missing .int(), missing .max(), looser .max(), and array drift in the bad fixture", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "bad"),
      rules: ["R01"],
    });

    const messages = result.findings.map((f) => f.message);

    // 1. email: missing .max(255) for @db.VarChar(255)
    expect(messages.some((m) => m.includes("email") && m.includes(".max()"))).toBe(true);

    // 2. name: Zod .max(500) > Prisma @db.VarChar(100)
    expect(
      messages.some((m) => m.includes("name") && m.includes("max(500)") && m.includes("100")),
    ).toBe(true);

    // 3. age: Int without .int()
    expect(messages.some((m) => m.includes("age") && m.includes(".int()"))).toBe(true);

    // 4. tags: Prisma String[] but Zod is z.string() — should be z.array(...)
    expect(messages.some((m) => m.includes("tags") && m.includes("String[]"))).toBe(true);

    expect(result.findings.every((f) => f.ruleId === "R01")).toBe(true);
  });

  it("emits zero findings for the good fixture", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "good"),
      rules: ["R01"],
    });

    expect(result.findings).toEqual([]);
  });
});
