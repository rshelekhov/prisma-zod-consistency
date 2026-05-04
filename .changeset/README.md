# Changesets

This directory holds [changesets](https://github.com/changesets/changesets) — small markdown files that describe what changed and which packages are affected. They drive version bumps and changelog generation for the npm-published packages.

The skill packages (`skill-claude-code`, `skill-codex`) and `checks` are private/internal and do **not** get versioned via changesets — they ride with the repo's git tags. Only `prisma-zod-consistency` (the CLI) is the publishable npm package, managed by changesets.

## Adding a changeset

```bash
pnpm changeset
```

Pick the affected packages, choose `patch` / `minor` / `major`, and write a one-line summary. Commit the resulting file alongside your code change.

## Releasing

CI runs `changeset version` to consume pending changesets and bump versions, then `changeset publish` to push to npm.
