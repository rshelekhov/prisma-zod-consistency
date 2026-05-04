import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../src/runner.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixturesRoot = resolve(here, "../../checks/examples/R05");

describe("R05 — bypass validated() middleware", () => {
  it("flags both bypass calls in the bad fixture", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "bad"),
      rules: ["R05"],
    });

    expect(result.findings.length).toBeGreaterThanOrEqual(2);
    expect(result.findings.every((f) => f.ruleId === "R05")).toBe(true);
    expect(
      result.findings.every((f) => f.message.includes(".req.json()")),
    ).toBe(true);
  });

  it("emits zero findings for the good fixture (validator wrapper not flagged)", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "good"),
      rules: ["R05"],
    });

    expect(result.findings).toEqual([]);
  });
});
