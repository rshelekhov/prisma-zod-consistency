# Contributing to `prisma-zod-consistency`

Thanks for considering a contribution. The fastest path to a merged PR is:
**reproduce a real drift case** (smaller is better), open an issue with the
schema/Zod fragments, and we'll discuss the fix shape before code.

## Local development

Requirements: **Node 20+** and **pnpm 9** (`corepack enable` will install the
right version automatically).

```bash
git clone https://github.com/rshelekhov/prisma-zod-consistency.git
cd prisma-zod-consistency
pnpm install
pnpm build       # compiles all packages; CLI dist lands in packages/cli/dist
pnpm test        # vitest, ~250 unit tests
pnpm typecheck
pnpm lint        # biome
```

Run the CLI from a built checkout against any project on disk:

```bash
node ./packages/cli/dist/index.js --cwd /path/to/some-project
```

## Repo layout

```
packages/
  checks/             # Source of truth for rule specs (markdown). No code.
  cli/                # The published `prisma-zod-consistency` npm package.
  skill-claude-code/  # Skill bundle for Claude Code.
  skill-codex/        # AGENTS.md instructions for Codex.
.changeset/           # Pending releases (one .md per change set).
docs/                 # Getting-started, design notes.
```

The CLI is the only published artifact. Skill bundles are repo-internal; they
ride along with git tags.

## Where rule code lives

Each rule has three things:

1. **Spec** — `packages/checks/rules/R0X-<name>.md`. One paragraph of intent,
   a "good" example, a "bad" example, and the config keys.
2. **Implementation** — `packages/cli/src/rules/r0X-<name>.ts`. Exports a
   `Rule` whose `run(ctx, options)` returns `Finding[]`.
3. **Tests** — `packages/cli/tests/r0X.test.ts`. Use the `makeTempProject`
   helper pattern from existing tests; aim for one passing case + one drift
   case + one obvious false-positive case you want to *not* fire on.

The runner is in `packages/cli/src/runner.ts`. Look at how an existing rule
(say R03) wires up to see the surface area.

## Opening a PR

1. Branch off `main`: `git checkout -b feat/<short-name>` or `fix/<short-name>`.
2. Make the change. Add or update tests in the same PR — drive-by changes
   without tests will be asked to add them before merge.
3. Run a changeset: `pnpm changeset`. Pick `patch` for bug fixes and internal
   tweaks, `minor` for user-visible behavior or new rules, `major` only for
   breaking API/CLI flag changes (we're pre-1.0; expect to default to
   `patch`/`minor`).
4. Push, open a PR. Link the related issue if there is one.

CI runs `pnpm lint`, `pnpm typecheck`, and `pnpm test` on every PR. Live-DB
tests for the unsupported sandbox case are auto-skipped.

## Reporting bugs

The most useful bug report:

- **Version**: `prisma-zod-consistency --version`.
- **Provider**: postgres / mysql / sqlite (matters for the live-DB rules).
- **Minimal repro**: a small `schema.prisma` fragment + the matching Zod
  schema fragment (or TS code for R05). Two-three lines is plenty for static
  rules; live-DB rules also need the SQL the DB has.
- **Command + observed output** vs **expected output**.

There's an issue form at <https://github.com/rshelekhov/prisma-zod-consistency/issues/new/choose>
that asks for exactly these.

If you suspect a false positive, please run with `--output json` and attach
the offending finding — that's much faster to diagnose than a screenshot.

## Releases

Releases go through `changesets`:

1. Each PR that should reach npm includes a `.changeset/*.md` file.
2. After merge, the `changesets/action` bot opens (or updates) a "Version
   Packages" PR that bumps `packages/cli/package.json` and updates
   `CHANGELOG.md`.
3. Merging that PR triggers `npm publish` from CI.

Maintainers don't run `npm publish` by hand. If a release looks stuck, check
the GitHub Actions run for the merge commit.

## Code style

We use **biome** for both formatting and linting. Run `pnpm lint:fix` before
committing. The configuration is in `biome.json`; please don't disable rules
locally without an explanation in the PR.

## License

By contributing you agree that your contributions are licensed under the
project's MIT license.
