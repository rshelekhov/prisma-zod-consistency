import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/runner.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixturesRoot = resolve(here, "../../checks/examples/R01b");

describe("R01b — generator output ↔ Prisma sanity check", () => {
  it("flags loose-max, missing-max, and missing-int in generator output", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "bad"),
      rules: ["R01"],
    });

    expect(result.findings.length).toBeGreaterThanOrEqual(3);
    expect(result.findings.every((f) => f.ruleId === "R01")).toBe(true);

    const messages = result.findings.map((f) => f.message);

    // 1. email: zod .max(500) > Prisma @db.VarChar(255)
    expect(
      messages.some(
        (m) => m.includes("Generated schema") && m.includes("email") && m.includes("max(500)"),
      ),
    ).toBe(true);

    // 2. name: missing .max() despite @db.VarChar(100)
    expect(
      messages.some(
        (m) => m.includes("Generated schema") && m.includes("name") && m.includes("no `.max()`"),
      ),
    ).toBe(true);

    // 3. age: Int without .int()
    expect(
      messages.some(
        (m) => m.includes("Generated schema") && m.includes("age") && m.includes(".int()"),
      ),
    ).toBe(true);

    // R01b severity defaults to warning (because much of what we flag here
    // is generator config — narrowing — not real bugs).
    expect(result.findings.every((f) => f.severity === "warning")).toBe(true);

    // R01b never attaches mechanical fixes — the user can't auto-edit a
    // regenerated file; the actionable change is in generator config or
    // schema.prisma.
    expect(result.findings.every((f) => f.fix === undefined)).toBe(true);

    // Every finding mentions the detected generator name so users know
    // where to go look (zod-prisma-types config in this case).
    expect(messages.every((m) => m.includes("zod-prisma-types"))).toBe(true);
  });

  it("emits zero findings when generator output matches Prisma", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "good"),
      rules: ["R01"],
    });

    expect(result.findings).toEqual([]);
  });
});
