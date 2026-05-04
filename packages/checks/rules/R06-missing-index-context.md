# R06 — Missing index for `where`/`orderBy` (contextual)

| Field | Value |
|---|---|
| Severity (default) | info |
| Phase | 1 |
| Surface | skill only |
| Group | A (static + service-layer context) |
| Auto-fix | no — index decisions are policy |
| Implementation | skill-only by design (CLI never gets this rule) |

## What it checks

Scans Prisma calls in service / repository code for `where:`, `orderBy:`, `cursor:`, and `distinct:` usage on columns that have no covering index in `schema.prisma`. Flags only when the call site is "hot" — lives inside a request handler or a frequently-running job, not a one-off script or a migration.

This rule is intentionally not in the CLI because the "is this hot?" judgement requires context the CLI cannot reliably reconstruct. The skill has the surrounding code in view; the CLI doesn't.

## Why it matters

A missing index on a hot path is the most common cause of a slow dashboard / slow API endpoint that surfaces months after the feature shipped. Catching it pre-launch (or during audit) prevents the incident.

Catching it indiscriminately (every `where:` clause everywhere) is worse than not catching it — the noise drowns out signal, and you end up over-indexing, which costs writes (see R07/R08).

## Algorithm (for the skill)

1. **Read `schema.prisma`** through the CLI's discovery (or directly). Build a map: `model → columns → indexes that cover that column as leading or sole`. A column is "covered" if:
   - It is a primary key (`@id`)
   - It has `@unique`
   - It is the first column of any `@@index` or `@@unique`
2. **Walk the service layer.** Default paths to scan: `src/services/**/*.ts`, `src/repositories/**/*.ts`, `src/lib/**/*.ts`. For each Prisma call (`prisma.X.findMany`, `findFirst`, `findUnique`, `count`, `update`, `delete` — anything that takes a `where`):
   - Extract the columns referenced in `where:` and `orderBy:`.
   - Cross-reference against the model's covering set.
   - If uncovered: candidate finding.
3. **Filter by hotness.** Walk up to find the enclosing function. If that function is:
   - Imported by a route handler in `src/routes/**` or `src/api/**` → hot.
   - Called from `src/jobs/**` or `src/workers/**` → hot.
   - Called from `src/scripts/**`, `src/migrations/**`, `prisma/seed.ts`, or test files → cold. Skip.
   - Unclear → ask the user.
4. **Recommend the index.** For each surviving candidate, output:
   - The exact `@@index([...])` line to add (or `@unique` for one-of constraints).
   - Where to add it in `schema.prisma`.
   - 1-sentence justification (e.g. "filtered in `getConversationsForUser`, runs on every dashboard page load").

## Examples (for the skill to recognize)

### Hot path, no index — recommend

```typescript
// src/services/conversation.ts
export async function getActiveConversations(userId: string) {
  return prisma.conversation.findMany({
    where: { userId, status: "ACTIVE" },          // ← uses (userId, status)
    orderBy: { lastMessageAt: "desc" },           // ← uses lastMessageAt
  });
}
```

```prisma
model Conversation {
  id            String   @id @default(cuid())
  userId        String
  status        ConversationStatus
  lastMessageAt DateTime
  // No relevant indexes.
}
```

Recommendation:

> Add `@@index([userId, status, lastMessageAt(sort: Desc)])` to `Conversation` — used by `getActiveConversations` (called on every dashboard load).

### Cold path — don't recommend

```typescript
// prisma/seed.ts
const oldUsers = await prisma.user.findMany({
  where: { createdAt: { lt: someCutoff } },
});
```

Seed scripts run rarely and on small data. Not worth an index.

### Already covered — skip

```typescript
return prisma.user.findUnique({ where: { id: userId } });  // covered by @id
```

## Configuration

```jsonc
{
  "R06": {
    "severity": "info",
    "hotPaths": ["src/services/**", "src/repositories/**"],
    "coldPaths": ["src/scripts/**", "**/*.test.ts", "prisma/seed.ts"],
    "ignoreModels": ["AuditLog"]
  }
}
```

The skill applies these heuristically — the CLI has no implementation.

## Common false positives

- **Composite filters where one column has a unique index alone.** E.g. `where: { email, organizationId }` when `email` has `@unique`. Postgres uses the unique index, then filters in-memory. Performance is fine for small per-email result sets.
- **Filters on small tables.** `Plans`, `Roles`, lookup tables under ~1k rows — Postgres seq-scans them faster than an index lookup. The skill should check approximate row count if it has DB access; otherwise warn the user.
- **`take: 1` with no order**. A single-row fetch by anything is usually fine without an index — it's the multi-row path that hurts.

## Implementation notes

- **Skill-only by design.** The CLI cannot judge hot-vs-cold without access to call graphs and runtime context the static analysis layer wasn't built to reconstruct. Even with that machinery, the false-positive rate would be high.
- **Live-DB augmentation (planned)**. With `--db` available, the skill could pull `pg_stat_user_tables.n_live_tup` to size each table and refine "hot" by row-count threshold. For now this is a manual judgement.

## See also

- R07 — Redundant indexes (the inverse problem — too much indexing)
- R08 — Unused indexes (the symptom of past R06 over-corrections)
- R10 — N+1 queries (overlapping concern — sometimes the right fix is `include`/`select` not an index)
