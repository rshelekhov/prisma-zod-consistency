import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/runner.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixturesRoot = resolve(here, "../../checks/examples/R03");

describe("R03 — enum sync", () => {
  it("flags missing/extra values, case mismatch, and field-level enum drift in the bad fixture", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "bad"),
      rules: ["R03"],
    });

    const messages = result.findings.map((f) => f.message);

    // 1. bookingStatusSchema: missing COMPLETED, extra REFUNDED.
    expect(
      messages.some(
        (m) =>
          m.includes("bookingStatusSchema") &&
          m.includes("missing in Zod: COMPLETED") &&
          m.includes("extra in Zod: REFUNDED"),
      ),
    ).toBe(true);

    // 2. userRoleSchema: case mismatch (admin vs ADMIN).
    expect(
      messages.some(
        (m) =>
          m.includes("userRoleSchema") &&
          m.includes("missing in Zod: ADMIN, MANAGER, CLIENT") &&
          m.includes("extra in Zod: admin, manager, client"),
      ),
    ).toBe(true);

    // 3. bookingDtoSchema.status: should use enum, not z.string().
    expect(
      messages.some(
        (m) =>
          m.includes("status") &&
          m.includes("BookingStatus") &&
          m.includes("z.string()"),
      ),
    ).toBe(true);

    expect(result.findings.every((f) => f.ruleId === "R03")).toBe(true);
  });

  it("emits zero findings for the good fixture", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "good"),
      rules: ["R03"],
    });

    expect(result.findings).toEqual([]);
  });
});
