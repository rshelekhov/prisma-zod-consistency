# prisma-zod-consistency

> Static + live-DB linter for Prisma schemas, Zod schemas, and your TypeScript code — finds drift before prod does.

```text
$ npx prisma-zod-consistency
info: live-DB rules skipped (pass --db to enable): R07, R08, R09, R09b, R09c, R09d

[R01] (2)
  error src/zod/links.ts:4
    Field `shortLink` is `@db.VarChar(400)` in Prisma; `LinkSchema` has no `.max()` to enforce that limit.
    → Add `.max(400)` to `shortLink`.
  error src/zod/users.ts:4
    Field `email` is `@db.VarChar(255)` in Prisma; `UserSchema` has no `.max()` to enforce that limit.
    → Add `.max(255)` to `email`.

[R02] (1)
  warn prisma/schema.prisma:20
    Relation Link.user is missing explicit onDelete.
    → Add `onDelete: <action>` to the @relation arguments.

[R03] (1)
  error src/zod/users.ts:5
    Enum `role` does not match Prisma enum `Role` — missing in Zod: ADMIN, USER; extra in Zod: admin, user.
    → Sync values: Prisma enum `Role` is { ADMIN, USER }.

[R04] (1)
  error src/zod/users.ts:6
    Field `bio` is optional in Prisma (`String?`) but `UserSchema` requires a non-null, non-undefined value.
    → Add `.nullable()` (for DB reads) or `.optional()` (to allow omitted keys).

4 errors, 1 warning, 0 info
```

## Quick start

```bash
npx prisma-zod-consistency
```

That's it. Without flags it runs the static checks against `prisma/schema.prisma` and `src/**/*.ts`.

In a monorepo, point it at the schema and your TS sources:

```jsonc
// .prismazodrc.json
{
  "schemaPath": "packages/db/prisma/schema.prisma",
  "include": ["apps/**/*.ts", "packages/**/*.ts"]
}
```

## Use as a Claude Code skill

Available in the official [Claude Code Plugin Directory](https://claude.com/plugins). Install from inside Claude Code:

```
/plugin marketplace add rshelekhov/prisma-zod-consistency
/plugin install prisma-zod-consistency
```

Then in any Prisma + Zod project say "check Prisma/Zod consistency" (or `проверь согласованность`) — the skill auto-engages, runs the CLI under the hood, and returns a contextual report with suggested fixes. Adds the R06 missing-index review and R10/R11 pattern checks that the CLI intentionally doesn't ship.

## What it catches

Real drift cases from open-source TypeScript repos.

**R01 — `@db.VarChar(N)` with no `.max()` in Zod.** A 401-char string passes Zod, then your DB rejects it with a truncation error and the API returns 500 instead of 400. *Found in `dub`:*

```prisma
model Link { shortLink String @unique @db.VarChar(400) }
```
```ts
// apps/web/lib/zod/schemas/links.ts
shortLink: z.string()  // no .max(400)
```

**R03 — Zod enum drift from Prisma.** Common case: lowercase Zod values, uppercase Prisma values. The two are silently incompatible until something refactors. *Found in `documenso`:*

```prisma
enum Role { ADMIN  USER }
```
```ts
role: z.enum(["admin", "user"])  // case mismatch
```

**R09c — FK action drift between Prisma and the live DB.** Prisma says `onUpdate: NoAction`, but the actual database has `ON UPDATE CASCADE` from a hand-written migration that never got back-ported. `prisma migrate diff` doesn't surface this; running with `--db` does. *Found in `formbricks`, `Membership.organization`.*

[Full rule catalog →](packages/checks/README.md) covers R01-R05 (static), R07-R09d (live DB on Postgres + MySQL + SQLite).

## CI integration

```yaml
- name: Prisma+Zod consistency
  run: |
    pnpm exec prisma-zod-consistency --output sarif > pzc.sarif
- name: Upload SARIF
  if: always()
  uses: github/codeql-action/upload-sarif@v3
  with: { sarif_file: pzc.sarif }
```

Findings appear in the **Security** tab of the repo and as inline annotations on PRs. Exit code 1 if any `error`-severity finding, exit 2 on misconfig (missing schema, no Zod files matched). See [`packages/cli/README.md`](packages/cli/README.md) for the full flag reference, suppression comments, `--db` configuration, and the auto-fix subcommand.

## CLI + skill — two surfaces, one source of truth

The same rule definitions in `packages/checks` ship as:

- **CLI** ([`prisma-zod-consistency` on npm](https://www.npmjs.com/package/prisma-zod-consistency)) — deterministic, low-noise, designed to gate CI.
- **Claude Code skill** ([Plugin Directory](https://claude.com/plugins)) — adds context-aware analysis: reads service-layer code, suggests fixes, runs the R06 missing-index review.
- **Codex agent** (`packages/skill-codex/AGENTS.md`) — same playbook for the Codex CLI.

## Status

11 rules implemented across the static and live-DB families. Pre-1.0; semver respected from 0.7.0 onward. Recent changes: see [CHANGELOG.md](packages/cli/CHANGELOG.md).

## License

MIT
