---
"prisma-zod-consistency": minor
---

Enterprise-readiness pack — SARIF output + suppression comments.

- **`--output sarif`** emits a SARIF 2.1.0 document conforming to the OASIS-TCS schema. Feed it to `github/codeql-action/upload-sarif@v3` for inline PR annotations and a Security-tab dashboard. Severity maps as `error`→`error`, `warning`→`warning`, `info`→`note`. Each rule's `helpUri` points at its spec on GitHub. Live-DB findings emit a generic repository annotation since they aren't anchored to source.

- **Suppression comments** silence individual findings without disabling a rule globally. Familiar `// pz-disable-next-line`, `// pz-disable` … `// pz-enable` syntax with optional rule lists, wildcards, and ESLint-style trailing reasons (`-- because X`). Scope: TS/TSX files for R01, R03, R04, R05. Per-rule hard-gate via `R0X.suppressionsEnabled: false`.

Also: `--version` now reports the actual published CLI version (was hardcoded to `0.0.0`).
