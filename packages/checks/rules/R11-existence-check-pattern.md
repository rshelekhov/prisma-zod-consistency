# R11 — `select: { id: true }` for existence checks

| Field | Value |
|---|---|
| Severity (default) | info |
| Phase | 1.7 |
| Surface | skill only |
| Group | C (patterns) |
| Auto-fix | partial — `findFirst({ where, select: { id: true } })` → `count({ where, take: 1 })` is mechanical, but the skill should confirm intent first |
| Implementation | skill-only by design |

## What it checks

Detects `prisma.X.findFirst({ where, select: { id: true } })` (or `findMany` + `take: 1`) followed by a truthiness check — a pattern that materializes a row just to test whether it exists. Common idiomatic alternatives are cheaper:

- `prisma.X.count({ where, take: 1 })` — Postgres can short-circuit after finding one match.
- `prisma.X.findFirst({ where, select: { id: true } })` is sometimes intentional (when you actually need the id), but if the result is only used for `if (result) { ... }`, the row materialization is wasted work.

## Why it matters

For a hot existence check (per-request authorization, every-page-load gates), the difference between "fetch the row" and "ask whether it exists" is real on a multi-million-row table — a `count(*) WHERE ... LIMIT 1` can be served from an index alone, while a `SELECT id FROM ...` may still need a heap visit (depending on index-only-scan eligibility).

Mostly a polish-level finding: the gain per call is small, but it adds up across a busy endpoint, and the idiomatic form is also more readable ("is there a match?" vs "give me a thing if there is one").

## Algorithm (for the skill)

1. **Find candidates.** Walk service-layer files. Look for:
   - `await prisma.X.findFirst({ where: ..., select: { id: true } })`
   - `await prisma.X.findUnique({ where: ..., select: { id: true } })`
   - `(await prisma.X.findMany({ where: ..., take: 1 })).length`
   - Or any of the above directly used in a boolean context — `if (await prisma.X.findFirst(...))`, `!await prisma.X.findFirst(...)`, ternary, return value used as boolean.
2. **Classify usage.** Walk forward from the call:
   - If the result is bound and the `id` is later used (passed to another function, returned, accessed via `.id`) → not a candidate. The id is needed, this is fine.
   - If the result is only used for truthiness → candidate finding.
3. **Suggest the alternative.**
   - Recommend `prisma.X.count({ where, take: 1 })` (returns 0 or 1).
   - Or, if Prisma adds a dedicated `.exists()` helper (planned in some adjacent libs), suggest that.

## Examples

### Bad

```typescript
async function userOwnsResource(userId: string, resourceId: string): Promise<boolean> {
  const result = await prisma.resource.findFirst({
    where: { id: resourceId, ownerId: userId },
    select: { id: true },
  });
  return Boolean(result);
}
```

### Bad — directly in conditional

```typescript
if (await prisma.invoice.findFirst({ where: { paid: true }, select: { id: true } })) {
  // ...
}
```

### Good

```typescript
async function userOwnsResource(userId: string, resourceId: string): Promise<boolean> {
  const matches = await prisma.resource.count({
    where: { id: resourceId, ownerId: userId },
    take: 1,
  });
  return matches > 0;
}
```

### Not a candidate — id is actually used

```typescript
const existing = await prisma.user.findFirst({
  where: { email },
  select: { id: true },
});
if (existing) {
  await prisma.userMergeLog.create({ data: { userId: existing.id, ... } });
}
// existing.id is used; this is fine.
```

## Configuration

```jsonc
{
  "R11": {
    "severity": "info",
    "ignoreFiles": ["**/scripts/**"]
  }
}
```

## Common false positives

- **id is used after the truthiness check.** Even if the immediate use is `if (x) { ... x.id ... }`, that's a single read and the existence pattern is appropriate.
- **Cases where the codebase uses `select: { id: true }` as a typing convention** to avoid pulling the full row, regardless of subsequent use. Style choice; not a bug.
- **`findUnique` against a primary key with `select: { id: true }`** — this is essentially a NOOP existence check by id, which is already cheap. Flagging adds little value.

## Implementation notes

- **Skill-only by design.** The "is the id actually used downstream?" judgement is fragile under static analysis (binding aliases, callbacks, returning the variable). The skill can read the surrounding code and judge.
- **Adjacent symptoms to consider together.** When R11 fires on a function, often R06 (missing index for the existence check's `where`) and R10 (the existence check is inside a loop) fire on the same code. The skill should report all three together as one performance triage hot-spot, not three separate items.

## See also

- R06 — Missing index for `where` (often the deeper issue under R11)
- R10 — N+1 (often the broader issue when R11 is inside a loop)
