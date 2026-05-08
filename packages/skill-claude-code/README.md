# prisma-zod-consistency — Claude Code skill

> Audit Prisma + Zod + TypeScript projects for cross-layer drift between the database schema, the Zod validation layer, and how they're used in route handlers.

This is the Claude Code plugin packaging of [prisma-zod-consistency](https://github.com/rshelekhov/prisma-zod-consistency). The deterministic checks run through the `prisma-zod-consistency` CLI; the plugin adds contextual analysis, recommendations, and the optional R06 (missing-index) review that the CLI cannot judge on its own.

## Install

```
/plugin marketplace add rshelekhov/prisma-zod-consistency
/plugin install prisma-zod-consistency
```

The CLI is a separate npm package — install it in the project you want to audit:

```bash
pnpm add -D prisma-zod-consistency
# or one-shot:
npx prisma-zod-consistency
```

## Triggers

The skill activates when you say one of:

- "check Prisma/Zod consistency"
- "audit my schemas"
- "проверь согласованность"
- After meaningful changes to `schema.prisma` (new model, removed/renamed field, modified `@db.*`, modified `@relation`, modified `enum`)
- During a release-readiness pass

It will not auto-engage on every Zod schema edit (too noisy).

## What it does

1. **Discovery** — figures out where your Prisma schema lives, which datasource provider, which generators (if any), where Zod schemas are written, and which HTTP layer (Hono/tRPC/Next/Express/Fastify) drives R05.
2. **CLI run** — invokes `prisma-zod-consistency --output json` and parses the findings.
3. **Contextual report** — groups findings by rule, adds 1-2 sentences of context per finding, calls out cases that look intentional and how to suppress them.
4. **Auto-fix offer** — surfaces the `pz-fix` subcommand for findings that have a `fix` field, but never runs `--apply` without your explicit go-ahead.
5. **R06 / R10 / R11 (optional)** — context-dependent checks (missing indexes, N+1, existence-check anti-patterns) that intentionally aren't in the CLI; the skill walks your service-layer code on request.
6. **Live-DB checks (opt-in)** — R07-R09d via `--db` flag; the skill always asks before opening a DB connection.

## Rules covered

| Rule | What |
|---|---|
| R01 | Zod ↔ Prisma field drift (e.g. `@db.VarChar(N)` without `.max()`) |
| R02 | Missing explicit `onDelete` on relations |
| R03 | Zod enum drift from Prisma enum |
| R04 | Nullability mismatch |
| R05 | Validated-input bypass in HTTP handlers |
| R06 | Missing index for hot `where`/`orderBy` (skill-only) |
| R07 | Redundant DB indexes (live-DB) |
| R08 | Unused DB indexes (live-DB) |
| R09 | Schema/nullability drift vs live DB |
| R09b | Type drift vs live DB |
| R09c | FK constraints drift vs live DB |
| R09d | Default values drift vs live DB |
| R10 | N+1 access pattern (skill-only) |
| R11 | Existence-check anti-pattern (skill-only) |

Full rule specs: [packages/checks/rules](https://github.com/rshelekhov/prisma-zod-consistency/tree/main/packages/checks/rules) in the project repo.

## Configuration

Drop a `.prismazodrc.json` in your project root to override defaults:

```jsonc
{
  "schemaPath": "packages/db/prisma/schema.prisma",
  "include": ["apps/**/*.ts", "packages/**/*.ts"],
  "namingPrefixes": ["Z"]
}
```

Per-line suppression in TS/TSX: `// pz-disable-next-line R01` or `// pz-disable R03` … `// pz-enable R03`. See the [CLI README](https://github.com/rshelekhov/prisma-zod-consistency/blob/main/packages/cli/README.md) for the full reference.

## License

MIT — see [LICENSE](https://github.com/rshelekhov/prisma-zod-consistency/blob/main/LICENSE).
