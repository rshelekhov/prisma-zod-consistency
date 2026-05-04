import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/runner.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixturesRoot = resolve(here, "../../checks/examples/R02");

describe("R02 — onDelete explicit", () => {
  it("flags @relation without onDelete in the bad fixture", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "bad"),
      rules: ["R02"],
    });

    // The bad fixture has Conversation.user with no onDelete/onUpdate.
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.every((f) => f.ruleId === "R02")).toBe(true);
    expect(result.findings.some((f) => f.message.includes("onDelete"))).toBe(true);
  });

  it("emits zero findings for the good fixture", async () => {
    const result = await run({
      cwd: resolve(fixturesRoot, "good"),
      rules: ["R02"],
    });

    expect(result.findings).toEqual([]);
  });
});
