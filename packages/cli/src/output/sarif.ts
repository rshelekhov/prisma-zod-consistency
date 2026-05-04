/**
 * SARIF 2.1.0 output. Phase 2 — placeholder until the rule set stabilizes.
 *
 * Spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 * GitHub Code Scanning ingest: github/codeql-action/upload-sarif@v3
 */

import type { Finding } from "../types.js";

export function formatSarif(_findings: Finding[]): string {
  // TODO(Phase 2): emit a real SARIF document. For now we return a stub
  // that signals the format is recognized but unsupported.
  throw new Error("SARIF output is planned for Phase 2 and not yet implemented.");
}
