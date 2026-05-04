import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/runner.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixturesRoot = resolve(here, "../../checks/examples/R04");

describe("R04 — nullability mismatch", () => {
  it("flags both directions of nullability drift in the bad fixture", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "bad"),
      rules: ["R04"],
    });

    const messages = result.findings.map((f) => f.message);

    // 1. email: required in Prisma + Zod .nullable() → API accepts null but DB rejects.
    expect(
      messages.some((m) => m.includes("email") && m.includes("required") && m.includes("null")),
    ).toBe(true);

    // 2. name: optional in Prisma + Zod has nothing → DB reads with NULL fail.
    expect(
      messages.some(
        (m) => m.includes("name") && m.includes("optional in Prisma") && m.includes("non-null"),
      ),
    ).toBe(true);

    // 3. bio: optional in Prisma + Zod .min(1) (no nullability).
    expect(
      messages.some(
        (m) => m.includes("bio") && m.includes("optional in Prisma") && m.includes("non-null"),
      ),
    ).toBe(true);

    expect(result.findings.every((f) => f.ruleId === "R04")).toBe(true);
  });

  it("emits zero findings for the good fixture", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "good"),
      rules: ["R04"],
    });

    expect(result.findings).toEqual([]);
  });
});
