# prisma-zod-consistency (CLI)

Deterministic static analysis for Prisma + Zod + TypeScript projects. Run it in CI to gate PRs against schema/Zod drift, run it locally as a codebase audit, or use it from a Claude Code / Codex skill for context-aware reviews.

## Status

Initial release (0.x). Eight rules implemented: R01-R05 (static), R07-R09 (live DB). R06/R10/R11 are skill-only by design. See [the rule catalog](../checks/rules) for the full list.

## Install

```bash
pnpm add -D prisma-zod-consistency
# or: npm install --save-dev prisma-zod-consistency
# or: yarn add -D prisma-zod-consistency

# Try it without installing:
npx prisma-zod-consistency

# During development, link a local checkout:
cd /path/to/prisma-zod-consistency
pnpm install && pnpm build
cd packages/cli && pnpm link --global
# Then `prisma-zod-consistency` is on PATH everywhere.
```

The package installs two equivalent binaries:

- **`prisma-zod-consistency`** — canonical name. Use in CI scripts and docs.
- **`pz-check`** — short alias for interactive use.

Both point to the same entry. Pick whichever you prefer; examples below mix them.

## Commands

Two subcommands. `check` is the default — `prisma-zod-consistency` and `prisma-zod-consistency check` are identical.

### `check` — find consistency drift

```bash
prisma-zod-consistency [check] [options]
```

| Flag | Default | What it does |
|---|---|---|
| `--cwd <path>` | `process.cwd()` | Project root. Looks for `schema.prisma` at `<cwd>/prisma/schema.prisma` (overridable in config). |
| `--rules <ids>` | all registered rules | Comma-separated subset, e.g. `R01,R03,R05`. Unknown rule ids are skipped with a stderr note. |
| `--output <format>` | `pretty` | `pretty` (human) / `json` (machine) / `sarif` (SARIF 2.1.0 for GitHub Code Scanning). |
| `--db` | off | Snapshot the live database for Group B rules (R07/R08/R09). Without this flag, those rules are silently skipped. |
| `--database-url <url>` | `process.env.DATABASE_URL` | Override `DATABASE_URL` for `--db`. |

### `fix` — apply mechanical codemods

```bash
prisma-zod-consistency fix [options]
```

| Flag | Default | What it does |
|---|---|---|
| `--cwd <path>` | `process.cwd()` | Project root. |
| `--rules <ids>` | all registered rules | Limit to specific rules (typically `R01,R03` — the ones with codemods). |
| `--apply` | off (dry-run) | Write changes to disk. Without it, prints a diff and exits 0. |

What gets fixed (only the safe subset):

- **R01** (R01a only — hand-written `z.object({...})`): appends `.max(N)` when `@db.VarChar(N)` and Zod has none, appends `.int()` for `Int` fields, lowers a looser `.max(M)` to match `@db.VarChar(N)`. R01b (generator output ↔ Prisma) and R01c (derived schemas weakening generated) emit findings but never apply mechanical fixes — the right change is in generator config or developer intent.
- **R03**: replaces field-level `z.string()` (or other non-enum base) with `z.nativeEnum(EnumName)` when the Prisma field is an enum. Auto-imports `EnumName` from `@prisma/client` if missing.

What is **not** auto-fixed (deliberately):

- `schema.prisma` is never touched — schema changes imply migrations.
- R03 enum value mismatches (removing a value from `z.enum([...])` could break compile-time references elsewhere).
- R02, R04, R05 — no safe mechanical fix; the right action is contextual.

## Output

The CLI writes to **stdout only**. No log files, no implicit reports — you control where the output goes via shell redirection.

```bash
# Just look at it in the terminal (default pretty format):
prisma-zod-consistency

# Save the JSON report:
prisma-zod-consistency --output json > audit.json

# Pretty-print for humans, also save to file:
prisma-zod-consistency | tee audit.txt

# Filter with jq:
prisma-zod-consistency --output json | jq '.findings[] | select(.severity == "error")'

# Only fail CI on errors (warnings/info don't matter):
prisma-zod-consistency --output json | jq -e '.summary.error == 0' > /dev/null
```

### JSON shape

```jsonc
{
  "schemaVersion": 1,
  "findings": [
    {
      "ruleId": "R01" | "R02" | ...,
      "severity": "error" | "warning" | "info",
      "message": "Field `email` is `@db.VarChar(255)` ...",
      "location": { "file": "abs/path", "line": 9 },
      "suggestion": "Add `.max(255)` to `email`.",     // optional
      "fix": { "description": "..." },                  // present if pz-fix can apply
      "scope": { "model": "userSchema", "field": "email" }
    }
  ],
  "summary": { "total": 4, "error": 4, "warning": 0, "info": 0 }
}
```

## Exit codes

- **`0`** — no findings at `error` severity. CI passes.
- **`1`** — at least one `error` finding. CI fails.
- **`2`** — bad CLI invocation, missing config, missing schema.prisma, DATABASE_URL not set when `--db` was passed, etc.

`warning` and `info` findings never affect the exit code on their own. Use `jq` if you want to gate on those too.

## Configuration

Pick one of:

- `.prismazodrc.json` (or `.prismazodrc.js`, `.prismazodrc.cjs`, `.prismazodrc.mjs`)
- `prismazod.config.{js,cjs,mjs}`
- `"prisma-zod-consistency"` field in `package.json`

Loaded via [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) — searches up from `--cwd`.

```jsonc
{
  "schemaPath": "prisma/schema.prisma",
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "exclude": ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**"],

  "rules": {
    // Per-rule severity override + rule-specific options.

    "R01": {
      "severity": "error",
      "ignoreModels": ["AuditLog"],
      "suppressionsEnabled": true            // honour `// pz-disable-next-line` comments (default)
    },
    "R02": {
      "severity": "warning",
      "requireOnUpdate": false,
      "ignoreRelations": ["User.organization"]
    },
    "R03": {
      "severity": "error",
      "preferNativeEnum": false,
      "ignoreEnums": []
    },
    "R04": {
      "severity": "error",
      "ignoreSchemaSuffixes": ["Update", "Patch"]
    },
    "R05": {
      "severity": "warning",
      "framework": "auto"           // hono | trpc | auto | off
    },

    // Group B (live DB)
    "R07": { "severity": "info" },
    "R08": {
      "severity": "info",
      "minRowCount": 1000,          // skip tables smaller than this
      "ignoreIndexes": ["_pkey$"]   // regex patterns
    },
    "R09": {
      "severity": "warning",
      "ignoreTables": ["_prisma_migrations"],
      "ignoreColumns": ["^legacy_"]
    },

    // Disable a rule entirely:
    "R02": { "severity": "off" }
  }
}
```

Per-rule options are documented in each rule's spec under [`packages/checks/rules/`](../checks/rules).

## CI integration

Minimal GitHub Actions step:

```yaml
- name: Prisma+Zod consistency
  run: pnpm exec prisma-zod-consistency --output json > pzc-findings.json

- if: failure()
  run: |
    echo "::group::Errors"
    jq '.findings[] | select(.severity == "error")' pzc-findings.json
    echo "::endgroup::"
```

For Group B in CI you typically want a separate job that has DB access:

```yaml
- run: |
    DATABASE_URL=postgres://... \
      prisma-zod-consistency --rules R07,R08,R09 --db --output json \
      > pzc-db-findings.json
```

### SARIF output for GitHub Code Scanning

```yaml
- name: Prisma+Zod consistency
  run: pnpm exec prisma-zod-consistency --output sarif > pzc.sarif

- name: Upload SARIF
  if: always()
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: pzc.sarif
```

Findings appear in the **Security** tab of the repo and as inline annotations on PRs. Severity maps as `error`→`error`, `warning`→`warning`, `info`→`note`. Each rule's `helpUri` points at its spec on GitHub. Live-DB findings (R07/R08/R09) emit a generic repository annotation (no file/line) since they're not anchored to source.

## Suppression comments

Silence individual findings in TS/TSX files without disabling the rule globally. Standard syntax (familiar from ESLint, Biome, prisma-lint):

```typescript
// pz-disable-next-line R03
status: z.string(), // intentional: legacy public API contract

// Multiple rules:
// pz-disable-next-line R03,R04
status: z.string().nullable(),

// All rules on the next line:
// pz-disable-next-line
foo: z.unknown(),

// Block form — silence from here until pz-enable (or end of file):
// pz-disable R05
webhookHandler.post("/square", async (c) => {
  const body = await c.req.json(); // signature-verified webhook
  // ...
});
// pz-enable R05

// ESLint-style trailing reason is permitted and ignored:
// pz-disable-next-line R03 -- legacy import we'll fix in Q3
status: z.string(),
```

Scope: only TS/TSX files (R01, R03, R04, R05). Findings in `schema.prisma` (R02) and live-DB findings (R07/R08/R09) are not affected by these comments — Prisma's comment syntax differs and is not yet supported.

To hard-gate a rule for compliance — ignore suppression comments entirely and always report — set `suppressionsEnabled: false` per rule in your config (see below).

## Rules

| ID | Rule | Severity (default) | Surface | Auto-fix |
|---|---|---|---|---|
| R01 | Zod ↔ Prisma field drift (R01a / R01b / R01c) | error / warning | CLI + skill | partial |
| R02 | `@relation` without explicit `onDelete` | warning | CLI + skill | — |
| R03 | Enum sync (Prisma ↔ Zod) | error | CLI + skill | partial |
| R04 | Nullability mismatch | error | CLI + skill | — |
| R05 | API boundary bypass (Hono, tRPC) | warning | CLI + skill | — |
| R06 | Missing index for `where`/`orderBy` | info | skill only | — |
| R07 | Redundant indexes (DB) | info | CLI `--db` + skill | — |
| R08 | Unused indexes (DB) | info | CLI `--db` + skill | — |
| R09 | Schema drift vs live DB | warning | CLI `--db` + skill | — |
| R10 | N+1 queries | info | skill only | — |
| R11 | `select: { id: true }` for existence checks | info | skill only | — |

Full per-rule specs (with examples and config keys): [`packages/checks/rules/`](../checks/rules).

## License

MIT
