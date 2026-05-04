# R10 — N+1 queries

| Field | Value |
|---|---|
| Severity (default) | info |
| Phase | 1.7 |
| Surface | skill only |
| Group | C (patterns) |
| Auto-fix | no — fix shape depends on relation kind and consumer needs |
| Implementation | skill-only by design |

## What it checks

Detects code patterns that issue `N+1` queries against the database when a single query (with `include` or `select`) would have sufficed:

- `findMany`/`findFirst`/`findUnique` calls inside a `for`/`forEach`/`map` loop iterating over an array.
- `Promise.all(items.map(item => prisma.X.findUnique(...)))` — same shape, parallel doesn't help.
- A loop that looks up a related entity per item, when the parent query could have `include`d the relation.

## Why it matters

N+1 is the most common Prisma performance footgun. Every iteration is a network round trip; on lists of 50-100 items it turns a 10ms endpoint into a 500ms-1s endpoint. Compounds catastrophically with depth (N+1 inside N+1 → N×M queries).

Fix is usually a 5-line change (`include` / `select` / batched `findMany({ where: { id: { in: ids } } })`). Catching it pre-launch is much cheaper than refactoring after the slow-endpoint complaints come in.

## Algorithm (for the skill)

1. **Find candidate loops.** Walk service-layer / repository / route-handler files. Look for:
   - `for (const x of items)` / `for (let i = 0; ...)` / `items.forEach(...)` / `items.map(...)` — anything iterating.
   - `Promise.all(items.map(...))` is the same pattern, parallel form.
2. **Check for Prisma calls inside.** Within each loop body, search for `prisma.<Model>.findUnique`, `findFirst`, `findMany`, `count`, etc.
3. **Identify the relation.** Look at the `where:` clause inside the loop. If it filters by a key derived from the loop variable (`where: { id: item.parentId }`, `where: { userId: item.id }`), this is almost certainly an N+1.
4. **Suggest the fix.** Three common shapes:
   - **Add `include` to the parent query**: if the parent already loaded `items` via `findMany`, just add `include: { relation: true }`.
   - **Batch by id**: `const related = await prisma.X.findMany({ where: { id: { in: items.map(i => i.parentId) } } })`. Then map by id in memory.
   - **Use `select` for shape control**: when only a few columns are needed.

## Examples (for the skill to recognize)

### Bad — classic N+1

```typescript
const conversations = await prisma.conversation.findMany({ where: { userId } });

// One query per conversation. 50 conversations = 51 round trips.
for (const conv of conversations) {
  const lastMessage = await prisma.message.findFirst({
    where: { conversationId: conv.id },
    orderBy: { createdAt: "desc" },
  });
  conv.lastMessage = lastMessage;
}
```

### Bad — N+1 hidden behind Promise.all

```typescript
const conversations = await prisma.conversation.findMany({ where: { userId } });

// Parallel doesn't help — still N round trips, just concurrent.
await Promise.all(
  conversations.map(async (conv) => {
    conv.lastMessage = await prisma.message.findFirst({
      where: { conversationId: conv.id },
      orderBy: { createdAt: "desc" },
    });
  }),
);
```

### Good — include

```typescript
const conversations = await prisma.conversation.findMany({
  where: { userId },
  include: {
    messages: {
      take: 1,
      orderBy: { createdAt: "desc" },
    },
  },
});
// One query.
```

### Good — batch then map

```typescript
const conversations = await prisma.conversation.findMany({ where: { userId } });
const conversationIds = conversations.map((c) => c.id);

const lastMessages = await prisma.message.findMany({
  where: { conversationId: { in: conversationIds } },
  orderBy: [{ conversationId: "asc" }, { createdAt: "desc" }],
  distinct: ["conversationId"],
});

const lastByConv = new Map(lastMessages.map((m) => [m.conversationId, m]));
const enriched = conversations.map((c) => ({ ...c, lastMessage: lastByConv.get(c.id) }));
```

### Ambiguous — flagged but possibly fine

- **Loops over a small known-bounded list.** `for (const status of [DRAFT, CONFIRMED]) { ... prisma.X.count ... }` — 2 queries, not 200. Fine.
- **Conditional fetches.** `for (...) { if (rare-condition) await prisma.X.findUnique(...) }` — most iterations don't query. Profile before optimizing.
- **Aggregations that genuinely need separate queries.** Some join shapes Prisma can't express well; explicit per-item is sometimes the cleanest.

## Configuration

```jsonc
{
  "R10": {
    "severity": "info",
    "loopThreshold": 1,                          // min loop iterations to flag (planned)
    "ignoreFiles": ["**/scripts/**", "**/migrations/**"]
  }
}
```

## Common false positives

- **Loops over compile-time-bounded collections** (enum values, hard-coded arrays).
- **Loops where each iteration is intentionally serial** for ordering or transactional reasons.
- **Pre-loading patterns** where the loop populates a cache that downstream code reads — the cache fill IS the N+1, but it's the design choice.
- **Tests** — fixtures and integration tests routinely set up N records via N inserts. Not a perf concern.

The skill should annotate findings with confidence ("very likely N+1" / "possible N+1 — please verify"); the CLI tone of "error: this is broken" doesn't fit pattern rules.

## Implementation notes

- **Skill-only by design.** Static analysis can spot the shape but cannot tell which loops are actually hot. The skill has the surrounding context.
- **`--mode patterns`.** When and if a CLI implementation lands, it should be behind the `--mode patterns` flag (off by default) — the precision is too low for default CI gating.
- **Could be augmented with runtime data.** A query log analyzer (Prisma's `$on('query', ...)` hook + a sidecar) would identify actual N+1s with zero false positives. Out of scope here.

## See also

- R06 — Missing index (related: the right fix for some "slow loops" is an index, not include/batch)
- R11 — Existence-check pattern (related: `select: { id: true }` is sometimes a sign of the same family of mistakes)
