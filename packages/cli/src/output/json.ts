import type { Finding } from "../types.js";

interface JsonReport {
  schemaVersion: 1;
  findings: Finding[];
  summary: {
    total: number;
    error: number;
    warning: number;
    info: number;
  };
}

export function formatJson(findings: Finding[]): string {
  const report: JsonReport = {
    schemaVersion: 1,
    findings,
    summary: {
      total: findings.length,
      error: findings.filter((f) => f.severity === "error").length,
      warning: findings.filter((f) => f.severity === "warning").length,
      info: findings.filter((f) => f.severity === "info").length,
    },
  };
  return JSON.stringify(report, null, 2);
}
