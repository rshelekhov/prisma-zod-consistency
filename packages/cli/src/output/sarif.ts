/**
 * SARIF 2.1.0 output.
 *
 * Maps the CLI's internal Finding[] into a SARIF document that can be
 * uploaded to GitHub Code Scanning (or any other SARIF consumer) via
 * github/codeql-action/upload-sarif@v3.
 *
 * Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 *
 * Severity mapping:
 *   error   → "error"
 *   warning → "warning"
 *   info    → "note"
 *
 * Path normalization:
 *   - Findings inside `ctx.rootDir` get a project-relative URI (preferred by
 *     GitHub Code Scanning so PR annotations land on the right line).
 *   - Findings outside the root keep their absolute path.
 *   - Group B (live-DB) findings carry `location.file = "<live-db>"`. They
 *     emit a SARIF artifactLocation with `uri = "live-db"` and no region —
 *     valid SARIF, surfaces in Code Scanning as a generic repository
 *     annotation instead of a file-anchored one.
 */

import { relative } from "node:path";
import type { Log, Region, ReportingDescriptor, Result } from "sarif";
import type { Finding, Rule, RuleId, Severity } from "../types.js";
import { VERSION } from "../version.js";

const TOOL_NAME = "prisma-zod-consistency";
const INFORMATION_URI = "https://github.com/rshelekhov/prisma-zod-consistency";
const SCHEMA_URI =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json";

export interface SarifContext {
  /** Project root used to relativize file paths. */
  rootDir: string;
  /** Rules that actually ran in this invocation. Their metadata populates tool.driver.rules. */
  rules: Rule[];
}

export function formatSarif(findings: Finding[], context: SarifContext): string {
  const log: Log = {
    version: "2.1.0",
    $schema: SCHEMA_URI,
    runs: [
      {
        tool: {
          driver: {
            name: TOOL_NAME,
            version: VERSION,
            informationUri: INFORMATION_URI,
            rules: context.rules.map(toReportingDescriptor),
          },
        },
        results: findings.map((f) => toResult(f, context.rootDir)),
      },
    ],
  };

  return JSON.stringify(log, null, 2);
}

function toReportingDescriptor(rule: Rule): ReportingDescriptor {
  return {
    id: rule.id,
    name: rule.name,
    shortDescription: { text: rule.description },
    helpUri: rule.helpUri,
    defaultConfiguration: { level: severityToLevel(rule.defaultSeverity) },
  };
}

function toResult(finding: Finding, rootDir: string): Result {
  const result: Result = {
    ruleId: finding.ruleId,
    level: severityToLevel(finding.severity),
    message: { text: finding.message },
    locations: [
      {
        physicalLocation: buildPhysicalLocation(finding, rootDir),
      },
    ],
  };

  // Carry rule scope (model / field / relation) as SARIF properties so
  // downstream consumers that surface property bags (Code Scanning, sarif-
  // viewer) keep the structured context.
  if (finding.scope && Object.values(finding.scope).some((v) => v !== undefined)) {
    result.properties = { ...finding.scope };
  }

  return result;
}

function buildPhysicalLocation(
  finding: Finding,
  rootDir: string,
): {
  artifactLocation: { uri: string };
  region?: Region;
} {
  // Live-DB findings have a synthetic file marker; emit no region.
  if (finding.location.file === "<live-db>") {
    return { artifactLocation: { uri: "live-db" } };
  }

  const uri = relativizePath(finding.location.file, rootDir);
  const region: Region = { startLine: finding.location.line };
  if (finding.location.column !== undefined) {
    region.startColumn = finding.location.column;
  }
  return { artifactLocation: { uri }, region };
}

function relativizePath(absPath: string, rootDir: string): string {
  // Files inside the project root → posix-style relative. Outside → leave the
  // absolute path unchanged (rare; happens in tests where fixtures live in
  // a sibling package).
  const rel = relative(rootDir, absPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return absPath;
  }
  // SARIF specifies forward slashes for artifactLocation.uri regardless of OS.
  return rel.split(/[\\/]/).join("/");
}

function isAbsolute(p: string): boolean {
  // Posix abs path or Windows drive prefix (e.g. "C:\foo").
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

function severityToLevel(severity: Severity): "error" | "warning" | "note" {
  switch (severity) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "info":
      return "note";
  }
}

// Re-export RuleId so tests can import without pulling types.ts directly.
export type { RuleId };
