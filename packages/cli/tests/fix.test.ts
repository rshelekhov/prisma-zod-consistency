import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyFixes } from "../src/fix/apply.js";
import { run } from "../src/runner.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const fixturesRoot = resolve(here, "../../checks/examples");

describe("pz-fix end-to-end", () => {
  it("R01 fix: appends .max(N), .int(), and rewrites looser .max(M)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pz-fix-r01-"));
    try {
      await cp(resolve(fixturesRoot, "R01/bad"), tmp, { recursive: true });

      const { findings } = await run({ cwd: tmp, rules: ["R01"] });
      const fixable = findings.filter((f) => f.fix !== undefined);

      // The bad fixture has 4 R01 findings. 3 of them are mechanically fixable:
      // missing .max(255) on email, looser .max(500) on name, missing .int() on age.
      // The array drift on `tags` is not mechanically fixed.
      expect(fixable.length).toBe(3);

      const report = await applyFixes(fixable, { write: true });
      expect(report.totalEditsApplied).toBe(3);
      expect(report.totalEditsSkipped).toBe(0);

      const updated = await readFile(join(tmp, "src/schemas/user.ts"), "utf8");
      expect(updated).toContain("email: z.string().max(255)");
      expect(updated).toContain("name: z.string().max(100)");
      expect(updated).toContain("age: z.number().int()");
      // Untouched array drift remains:
      expect(updated).toContain("tags: z.string()");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("R03 fix: replaces z.string() with z.nativeEnum and adds the import when missing", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pz-fix-r03-"));
    try {
      await cp(resolve(fixturesRoot, "R03/bad"), tmp, { recursive: true });

      const { findings } = await run({ cwd: tmp, rules: ["R03"] });
      const fixable = findings.filter((f) => f.fix !== undefined);

      // R03/bad has one field-level drift (booking.status is z.string()).
      // The two top-level enum value mismatches don't ship a fix yet.
      expect(fixable.length).toBeGreaterThanOrEqual(1);

      await applyFixes(fixable, { write: true });

      const updated = await readFile(join(tmp, "src/schemas/booking.ts"), "utf8");
      expect(updated).toContain("z.nativeEnum(BookingStatus)");
      expect(updated).toContain('import { BookingStatus } from "@prisma/client"');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("dry-run does not modify files", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "pz-fix-dry-"));
    try {
      await cp(resolve(fixturesRoot, "R01/bad"), tmp, { recursive: true });
      const before = await readFile(join(tmp, "src/schemas/user.ts"), "utf8");

      const { findings } = await run({ cwd: tmp, rules: ["R01"] });
      const fixable = findings.filter((f) => f.fix !== undefined);
      await applyFixes(fixable, { write: false });

      const after = await readFile(join(tmp, "src/schemas/user.ts"), "utf8");
      expect(after).toBe(before);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
