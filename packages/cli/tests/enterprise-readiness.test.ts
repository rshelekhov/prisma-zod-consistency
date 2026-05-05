/**
 * "Enterprise-readiness" pack — SARIF output (A3) + suppression comments (A4).
 *
 * SARIF tests use synthetic Finding[] and the real Rule registry so we cover
 * the formatter in isolation without depending on a live discovery run.
 */

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv-draft-04";
import addFormats from "ajv-formats";
import { afterAll, describe, expect, it } from "vitest";
import { formatSarif } from "../src/output/sarif.js";
import { allRules } from "../src/rules/index.js";
import { run } from "../src/runner.js";
import { buildSuppressionMap } from "../src/suppression.js";
import type { Finding, Rule, RuleId } from "../src/types.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const schemaPath = resolve(here, "fixtures/sarif-schema.json");
const sarifSchema = JSON.parse(readFileSync(schemaPath, "utf-8"));

function ruleByIdOrThrow(id: RuleId): Rule {
  const r = allRules().find((x) => x.id === id);
  if (!r) throw new Error(`Rule ${id} not registered`);
  return r;
}

const ROOT = "/repo";

const FINDINGS: Finding[] = [
  {
    ruleId: "R01",
    severity: "error",
    message: "Field `email` is `@db.VarChar(255)` but Zod has no .max(...).",
    location: { file: "/repo/src/schemas/user.ts", line: 12, column: 5 },
    scope: { model: "userSchema", field: "email" },
  },
  {
    ruleId: "R02",
    severity: "warning",
    message: "Relation `Booking.user` has no explicit onDelete.",
    location: { file: "/repo/prisma/schema.prisma", line: 47 },
    scope: { model: "Booking", relation: "user" },
  },
  {
    ruleId: "R09",
    severity: "info",
    message: "Column `legacy_flag` exists in DB but not in Prisma model `User`.",
    location: { file: "<live-db>", line: 1 },
    scope: { model: "User", field: "legacy_flag" },
  },
];

const RAN_RULES: Rule[] = [ruleByIdOrThrow("R01"), ruleByIdOrThrow("R02"), ruleByIdOrThrow("R09")];

describe("A3 — SARIF output", () => {
  const sarifText = formatSarif(FINDINGS, { rootDir: ROOT, rules: RAN_RULES });
  // biome-ignore lint/suspicious/noExplicitAny: SARIF document parsed as JSON for shape assertions.
  const sarif: any = JSON.parse(sarifText);

  it("emits a SARIF 2.1.0 document with the expected top-level shape", () => {
    expect(sarif.version).toBe("2.1.0");
    expect(typeof sarif.$schema).toBe("string");
    expect(Array.isArray(sarif.runs)).toBe(true);
    expect(sarif.runs).toHaveLength(1);

    const driver = sarif.runs[0].tool.driver;
    expect(driver.name).toBe("prisma-zod-consistency");
    expect(driver.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(driver.informationUri).toMatch(/^https?:\/\//);
  });

  it("maps severity → SARIF level (error→error, warning→warning, info→note)", () => {
    const byRule = Object.fromEntries(
      // biome-ignore lint/suspicious/noExplicitAny: parsed JSON.
      sarif.runs[0].results.map((r: any) => [r.ruleId, r.level]),
    );
    expect(byRule.R01).toBe("error");
    expect(byRule.R02).toBe("warning");
    expect(byRule.R09).toBe("note");
  });

  it("populates tool.driver.rules from the rules that actually ran", () => {
    const rules = sarif.runs[0].tool.driver.rules;
    // biome-ignore lint/suspicious/noExplicitAny: parsed JSON.
    expect(rules.map((r: any) => r.id).sort()).toEqual(["R01", "R02", "R09"]);

    // biome-ignore lint/suspicious/noExplicitAny: parsed JSON.
    for (const r of rules as any[]) {
      expect(r.name).toBeTruthy();
      expect(r.shortDescription.text).toBeTruthy();
      expect(r.helpUri).toMatch(/^https:\/\/github\.com\/.+\.md$/);
      expect(["error", "warning", "note"]).toContain(r.defaultConfiguration.level);
    }
  });

  it("relativizes file paths inside the project root and preserves region", () => {
    // biome-ignore lint/suspicious/noExplicitAny: parsed JSON.
    const r01 = sarif.runs[0].results.find((r: any) => r.ruleId === "R01");
    const loc = r01.locations[0].physicalLocation;
    expect(loc.artifactLocation.uri).toBe("src/schemas/user.ts");
    expect(loc.region.startLine).toBe(12);
    expect(loc.region.startColumn).toBe(5);
  });

  it("emits live-DB findings with a synthetic artifact and no region", () => {
    // biome-ignore lint/suspicious/noExplicitAny: parsed JSON.
    const r09 = sarif.runs[0].results.find((r: any) => r.ruleId === "R09");
    const loc = r09.locations[0].physicalLocation;
    expect(loc.artifactLocation.uri).toBe("live-db");
    expect(loc.region).toBeUndefined();
  });

  it("validates against the official SARIF 2.1.0 JSON Schema (oasis-tcs)", () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(sarifSchema);
    const ok = validate(sarif);
    // If validation fails, surface ajv errors via the assertion message so
    // regressions in the formatter are diagnosable from test output without
    // needing console.* calls (which biome's recommended preset flags).
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// A4 — suppression comments
// ─────────────────────────────────────────────────────────────────────

describe("A4 — buildSuppressionMap (parser unit tests)", () => {
  it("disable-next-line without rule ids silences every rule on the next line", () => {
    const m = buildSuppressionMap("// pz-disable-next-line\nz.string()\nrest\n");
    expect(m.isSuppressed(2, "R03")).toBe(true);
    expect(m.isSuppressed(2, "R04")).toBe(true);
    // The line after the targeted line is unaffected.
    expect(m.isSuppressed(3, "R03")).toBe(false);
  });

  it("disable-next-line R03 silences only R03 on the next line", () => {
    const m = buildSuppressionMap("// pz-disable-next-line R03\nfoo\n");
    expect(m.isSuppressed(2, "R03")).toBe(true);
    expect(m.isSuppressed(2, "R04")).toBe(false);
  });

  it("pz-disable / pz-enable block silences findings inside the range across rules", () => {
    const src = ["before", "// pz-disable", "inA", "inB", "// pz-enable", "after"].join("\n");
    const m = buildSuppressionMap(src);
    expect(m.isSuppressed(1, "R03")).toBe(false);
    expect(m.isSuppressed(3, "R03")).toBe(true);
    expect(m.isSuppressed(4, "R04")).toBe(true);
    expect(m.isSuppressed(6, "R03")).toBe(false);
  });

  it("rule-specific block disable is closed only by a matching pz-enable", () => {
    const src = [
      "// pz-disable R03", // 1
      "x", // 2
      "// pz-enable R04", // 3 — wrong key, must NOT close R03
      "y", // 4
      "// pz-enable R03", // 5
      "z", // 6
    ].join("\n");
    const m = buildSuppressionMap(src);
    expect(m.isSuppressed(2, "R03")).toBe(true);
    expect(m.isSuppressed(4, "R03")).toBe(true);
    expect(m.isSuppressed(6, "R03")).toBe(false);
    // R04 was never block-disabled.
    expect(m.isSuppressed(2, "R04")).toBe(false);
  });

  it("ignores eslint-style trailing reasons after ` -- `", () => {
    const m = buildSuppressionMap(
      "// pz-disable-next-line R03 -- legacy import we'll fix in Q3\nx\n",
    );
    expect(m.isSuppressed(2, "R03")).toBe(true);
    expect(m.isSuppressed(2, "R04")).toBe(false);
  });
});

describe("A4 — integration: suppression interacts with the runner", () => {
  const tmpDirs: string[] = [];
  afterAll(async () => {
    for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  });

  async function makeFixture(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pz-suppress-"));
    tmpDirs.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf-8");
    }
    return root;
  }

  // Minimal Prisma schema with one enum-typed field — enough to make R03
  // light up on a `z.string()` field in the matching Zod object.
  const SCHEMA = `generator client {
  provider = "prisma-client-js"
}
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}
enum BookingStatus {
  PENDING
  CONFIRMED
}
model Booking {
  id Int @id @default(autoincrement())
  status BookingStatus
}
`;

  const ZOD_NO_SUPPRESSION = `import { z } from "zod";

export const bookingSchema = z.object({
  id: z.number().int(),
  status: z.string(),
});
`;

  const ZOD_WITH_SUPPRESSION = `import { z } from "zod";

export const bookingSchema = z.object({
  id: z.number().int(),
  // pz-disable-next-line R03
  status: z.string(),
});
`;

  it("baseline: R03 reports the enum-typed field that uses z.string()", async () => {
    const root = await makeFixture({
      "prisma/schema.prisma": SCHEMA,
      "src/booking.ts": ZOD_NO_SUPPRESSION,
    });
    const res = await run({ cwd: root, rules: ["R03"] });
    const onStatus = res.findings.find((f) => f.ruleId === "R03" && f.message.includes("status"));
    expect(onStatus).toBeDefined();
  });

  it("// pz-disable-next-line R03 silences the same finding", async () => {
    const root = await makeFixture({
      "prisma/schema.prisma": SCHEMA,
      "src/booking.ts": ZOD_WITH_SUPPRESSION,
    });
    const res = await run({ cwd: root, rules: ["R03"] });
    const onStatus = res.findings.find((f) => f.ruleId === "R03" && f.message.includes("status"));
    expect(onStatus).toBeUndefined();
  });

  it("R03.suppressionsEnabled = false makes the runner ignore the comment", async () => {
    const root = await makeFixture({
      "prisma/schema.prisma": SCHEMA,
      "src/booking.ts": ZOD_WITH_SUPPRESSION,
      ".prismazodrc.json": JSON.stringify({
        rules: { R03: { suppressionsEnabled: false } },
      }),
    });
    const res = await run({ cwd: root, rules: ["R03"] });
    const onStatus = res.findings.find((f) => f.ruleId === "R03" && f.message.includes("status"));
    expect(onStatus).toBeDefined();
  });
});
