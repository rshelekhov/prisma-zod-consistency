import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/runner.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixturesRoot = resolve(here, "../../checks/examples/R01c");

describe("R01c — derived hand-written schemas weakening generated", () => {
  it("flags .passthrough() on direct-imported generated schema as error", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "bad"),
      rules: ["R01"],
    });

    const messages = result.findings.map((f) => f.message);
    expect(result.findings.every((f) => f.ruleId === "R01")).toBe(true);

    // 1. createUserInputSchema = UserSchema.passthrough() (direct import).
    const direct = result.findings.find(
      (f) => f.message.includes("createUserInputSchema") && f.message.includes("passthrough"),
    );
    expect(direct).toBeDefined();
    expect(direct?.severity).toBe("error");

    // 2. updateUserInputSchema = RexportedUserSchema.passthrough() through barrel.
    //    The transitive resolution should still trace back into outputDir.
    expect(
      messages.some((m) => m.includes("updateUserInputSchema") && m.includes("passthrough")),
    ).toBe(true);

    // Both passthrough findings should carry the origin schema name in the
    // message so users know which generated schema they're weakening.
    const passthroughFindings = result.findings.filter((f) => f.message.includes("passthrough"));
    expect(passthroughFindings.length).toBeGreaterThanOrEqual(2);
    for (const f of passthroughFindings) {
      expect(f.message).toContain("UserSchema");
    }

    // R01c does NOT propose mechanical fixes — `.passthrough()` is a deliberate
    // call by the developer, the right replacement (.pick? .omit? .extend?)
    // depends on intent.
    expect(passthroughFindings.every((f) => f.fix === undefined)).toBe(true);
  });

  it("does not flag .pick().extend() with stricter rules", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "good"),
      rules: ["R01"],
    });

    expect(result.findings).toEqual([]);
  });
});
