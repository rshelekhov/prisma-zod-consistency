# prisma-zod-consistency

> Static + live-DB linter for Prisma schemas, Zod schemas, and your TypeScript code — finds drift before prod does.

<!-- GIF placeholder — to be replaced in next pre-launch pass with a 30s screencast -->
<!-- ![demo](docs/assets/demo.gif) -->

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
