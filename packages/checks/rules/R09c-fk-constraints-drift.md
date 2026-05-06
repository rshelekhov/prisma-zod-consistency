# R09c — Foreign-key constraints drift vs live DB

| Field | Value |
|---|---|
| Severity (default) | warning |
| Phase | post-MVP |
| Surface | CLI (`--db`) + skill |
| Group | B (live DB) |
| Auto-fix | no — constraint drift implies a migration decision |
| Implementation | done (Postgres + MySQL + SQLite) |

## What it checks

Compares the foreign-key constraints declared by Prisma `@relation(...)` attributes against the constraints actually present in the database.

Three classes of finding:

1. **Missing FK in DB** — Prisma declares an `@relation(fields: [...], references: [...])` but no matching constraint exists on the live database. Usually a pending migration that hasn't run, or a DB where the constraint was dropped manually.
2. **Extra FK in DB** — a constraint exists in the database that Prisma's relation graph doesn't account for. Either a hand-rolled FK from another service, or an orphan from an old model that wasn't migrated away cleanly.
3. **Action drift** — a matched FK whose `onDelete` or `onUpdate` differs between Prisma and the database. This is the most common kind in practice — `onDelete: Cascade` was changed in `schema.prisma` but the migration wasn't generated, or the DB constraint was altered manually.

A fourth, related class — **reference shape drift** — fires when columns match but the referenced table/columns differ. Rare; surfaces when an FK was repointed at the DB level.

Matching is by `(tableName, sorted(columns))` — the same source columns on the same physical table identify the same FK regardless of constraint name. Constraint names diverge wildly between Prisma migration output and hand-rolled SQL, so they're not used for matching.

## Why it matters

FK action drift is **silent until something deletes**. A `Cascade` declared in Prisma but not in the DB means deleting the parent row leaves orphaned children; an `onDelete: Restrict` declared in Prisma but `Cascade` in the DB means a delete that "should" fail silently nukes rows.

Missing FKs in the DB look fine until referential integrity is actually exercised — then a child row referencing a non-existent parent surfaces in user-visible ways (broken joins, 500s on read).

Extra FKs in the DB cause `prisma migrate dev` to attempt to drop them, surprising whoever owns those constraints.

## How to fix

Each finding implies one of three actions:

- **Run pending migrations** — for "missing in DB" findings where Prisma is the canonical source.
- **Update `schema.prisma`** — when the DB is the source of truth, change `@relation(... onDelete: Foo, onUpdate: Bar)` to match.
- **Write a manual migration** — for action drift, generate or hand-write `ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT ...` to bring the live constraint in line.

No auto-fix. Like every R09* rule, FK drift implies a deliberate decision.

## Examples

### Bad — missing FK in DB

```
Foreign key on `Membership.org` (`memberships`(org_id) → `org`(id)) is declared in
schema.prisma but missing in the database.
```

### Bad — orphan FK in DB

```
Foreign key `memberships_team_fkey` on `memberships`(team_id) → `team`(id) exists
in the database but is not declared in schema.prisma.
```

### Bad — action drift

```
Foreign-key action drift on `Membership.org`: Prisma says onDelete=cascade,
onUpdate=no action; DB says onDelete=no action, onUpdate=no action.
```

### Good

`@relation(fields: [orgId], references: [id], onDelete: Cascade)` ↔ DB constraint with `ON DELETE CASCADE` on the same `(orgId → org.id)`. No finding.

### Ambiguous — flagged but possibly intentional

- **Cross-service FKs.** Another service writes into the same DB and owns its own FK. Configure `R09c.ignoreRelations` or `ignoreTables` once confirmed.
- **Implicit M-N relations** — Prisma manages a hidden join table. R09c **skips these by design** because there's no first-class FK to compare against on the side a user can author. The join table's FKs aren't currently checked.

## Configuration

```jsonc
{
  "R09c": {
    "severity": "warning",
    "ignoreTables": ["_prisma_migrations", "audit_view"],
    "ignoreRelations": ["^Audit\\.", "_legacy$"]   // regex, matched against `Model.field`
  }
}
```

`ignoreRelations` patterns are matched against the source-side identifier `Model.field` (e.g. `Membership.org`). Use this for relations you intentionally don't want gated.

`ignoreTables` filters both expected and actual sides, so internal tables like `_prisma_migrations` don't surface action-drift noise either way.

## Common false positives

- **Constraint name differences.** Constraint names are NOT used for matching — only `(table, sorted(columns))`. If R09c reports a missing/orphan FK, it's a real shape difference, not a name difference.
- **Different declaration orders for multi-column FKs.** Matching uses sorted columns, so `(orgId1, orgId2)` and `(orgId2, orgId1)` match; per-position comparison of source/referenced columns then runs. If the per-position arrays disagree, that's reported as reference shape drift, not as a false positive.
- **Implicit M-N relations.** Skipped by design (see Ambiguous). If you migrated a M-N relation to explicit and Prisma + DB are out of sync on the join table, R09c will surface it.

## Provider support

| Provider   | Source                                                           | Notes                                                                                                                |
|------------|------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------|
| postgresql | `pg_constraint` (contype = 'f') + `pg_attribute`                 | Action codes (`confdeltype` / `confupdtype`) translated to the SQL standard vocabulary: `c → cascade`, `r → restrict`, `n → set null`, `d → set default`, `a/unknown → no action`. |
| mysql      | `INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS` + `KEY_COLUMN_USAGE` | `DELETE_RULE` / `UPDATE_RULE` come as standard SQL text and are mapped directly. Multi-column FKs grouped by `CONSTRAINT_NAME` in `ORDINAL_POSITION` order. |
| sqlite     | `PRAGMA foreign_key_list(<table>)` per table                     | SQLite doesn't surface a constraint name; we synthesize `${table}_fk_${id}` as a stable handle. Actions arrive as text and are mapped the same way as MySQL. |

## Implementation notes

- **Owner side only.** R09c only iterates relation fields with both `fields: [...]` and `references: [...]` set — that's the side that produces an FK. Back-references (the inverse `Type[]` field on the parent) and implicit M-N relations are skipped.
- **Honors `@map(...)` and `@@map(...)`.** Source columns and referenced columns go through `@map`; tables go through `@@map`.
- **Default action.** When `onDelete` / `onUpdate` are omitted from `@relation(...)`, R09c uses Prisma's documented default of `NoAction` → `"no action"`. If the DB reports a different default (e.g. some legacy MySQL configs), the rule will flag drift — that's intentional.
- **Constraint names.** Used in messages for orphan FKs (so the user can `DROP CONSTRAINT` directly) but never for matching. SQLite synthesizes a stable name from the FK id (see Provider support).

## See also

- R09 — Schema drift (column existence + nullability)
- R09b — Type drift
- R09d — Default values drift
- R02 — `onDelete` explicit-rule (static, on the Prisma side only — complements R09c when the DB isn't reachable)
