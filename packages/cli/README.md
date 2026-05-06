# prisma-zod-consistency (CLI)

Deterministic static analysis for Prisma + Zod + TypeScript projects. Run it in CI to gate PRs against schema/Zod drift, run it locally as a codebase audit, or use it from a Claude Code / Codex skill for context-aware reviews.

## Status

Initial release (0.x). Eight rules implemented: R01-R05 (static), R07-R09 (live DB on **PostgreSQL, MySQL/MariaDB, and SQLite**). R06/R10/R11 are skill-only by design. See [the rule catalog](../checks/rules) for the full list.

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

### Optional database drivers

The static rules (R01–R05) need no extra dependencies. To run the live-DB rules (R07/R08/R09 with `--db`), install the driver for your provider — they are declared as optional peer dependencies:

| Provider              | Install                                      |
|-----------------------|----------------------------------------------|
| PostgreSQL            | `pnpm add -D postgres`                       |
| MySQL / MariaDB       | `pnpm add -D mysql2`                         |
| SQLite                | `pnpm add -D better-sqlite3`                 |

If you don't run `--db` you don't need any of them. Running `--db` without the matching driver fails with an error that names the install command.

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
| `--db` | off | Snapshot the live database for Group B rules (R07/R08/R09). Without this flag, those rules are silently skipped. Supported providers: PostgreSQL, MySQL/MariaDB, SQLite. |
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
      "framework": "auto"           // hono | trpc | next | auto | off
    },

    // Group B (live DB)
    "R07": { "severity": "info" },
    "R08": {
      "severity": "info",
      "minRowCount": 1000,          // skip tables smaller than this
      "ignoreIndexes": ["_pkey$"],  // regex patterns
      "includeUnique": false        // audit unique non-PK indexes too (false by default — Postgres/MySQL don't bump idx_scan on constraint enforcement)
    },
    "R09": {
      "severity": "warning",
      "ignoreTables": ["_prisma_migrations"],
      "ignoreColumns": ["^legacy_"]
    },
    "R09b": {                       // type drift: @db.VarChar(100) ↔ varchar(255), Int ↔ bigint, …
      "severity": "warning",
      "ignoreTables": ["_prisma_migrations"],
      "ignoreColumns": ["^legacy_"]
      // SQLite is skipped automatically via DbCapabilities.typeDriftAccurate=false.
    },
    "R09c": {                       // FK constraints drift: missing/extra/action
      "severity": "warning",
      "ignoreTables": ["_prisma_migrations"],
      "ignoreRelations": ["^Audit\\."]  // regex matched against `Model.field`
    },
    "R09d": {                       // default-value drift: @default("draft") ↔ DB DEFAULT 'pending'
      "severity": "warning",
      "ignoreTables": ["_prisma_migrations"],
      "ignoreColumns": ["^created_at$", "^updated_at$"]
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

For Group B in CI you typically want a separate job that has DB access. Examples per provider:

```yaml
# PostgreSQL — full Group B coverage
- run: |
    DATABASE_URL=postgres://user:pass@host:5432/dbname \
      prisma-zod-consistency --rules R07,R08,R09,R09b,R09c,R09d --db --output json \
      > pzc-db-findings.json

# MySQL / MariaDB — full Group B coverage
- run: |
    DATABASE_URL=mysql://user:pass@host:3306/dbname \
      prisma-zod-consistency --rules R07,R08,R09,R09b,R09c,R09d --db --output json \
      > pzc-db-findings.json

# SQLite (R08 and R09b silently skipped — provider doesn't track index usage
# or precise column types; R07/R09/R09c/R09d run normally)
- run: |
    DATABASE_URL=file:./prisma/dev.db \
      prisma-zod-consistency --rules R07,R09,R09c,R09d --db --output json \
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

Findings appear in the **Security** tab of the repo and as inline annotations on PRs. Severity maps as `error`→`error`, `warning`→`warning`, `info`→`note`. Each rule's `helpUri` points at its spec on GitHub. Live-DB findings (R07/R08/R09/R09b/R09c/R09d) emit a generic repository annotation (no file/line) since they're not anchored to source.

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

Scope: only TS/TSX files (R01, R03, R04, R05). Findings in `schema.prisma` (R02) and live-DB findings (R07/R08/R09/R09b/R09c/R09d) are not affected by these comments — Prisma's comment syntax differs and is not yet supported.

To hard-gate a rule for compliance — ignore suppression comments entirely and always report — set `suppressionsEnabled: false` per rule in your config (see below).

## Rules

| ID | Rule | Severity (default) | Surface | Auto-fix |
|---|---|---|---|---|
| R01 | Zod ↔ Prisma field drift (R01a / R01b / R01c) | error / warning | CLI + skill | partial |
| R02 | `@relation` without explicit `onDelete` | warning | CLI + skill | — |
| R03 | Enum sync (Prisma ↔ Zod) | error | CLI + skill | partial |
| R04 | Nullability mismatch | error | CLI + skill | — |
| R05 | API boundary bypass (Hono, tRPC, Next.js) | warning | CLI + skill | — |
| R06 | Missing index for `where`/`orderBy` | info | skill only | — |
| R07 | Redundant indexes (DB) | info | CLI `--db` (Postgres + MySQL + SQLite) + skill | — |
| R08 | Unused indexes (DB) | info | CLI `--db` (Postgres + MySQL; skipped on SQLite) + skill | — |
| R09 | Schema drift vs live DB | warning | CLI `--db` (Postgres + MySQL + SQLite) + skill | — |
| R09b | Type drift vs live DB | warning | CLI `--db` (Postgres + MySQL; skipped on SQLite) + skill | — |
| R09c | FK constraints drift vs live DB | warning | CLI `--db` (Postgres + MySQL + SQLite) + skill | — |
| R09d | Default-value drift vs live DB | warning | CLI `--db` (Postgres + MySQL + SQLite) + skill | — |
| R10 | N+1 queries | info | skill only | — |
| R11 | `select: { id: true }` for existence checks | info | skill only | — |

Full per-rule specs (with examples and config keys): [`packages/checks/rules/`](../checks/rules).

## License

MIT
