---
"prisma-zod-consistency": patch
---

Fix R09d default-value normalization for four Postgres edge cases that produced false positives on real-world projects with enum / boolean / JSON column defaults (Bug #9 — caught by the 0.8.1 smoke run on formbricks, which surfaced 43 false R09d findings):

- **9.A — quoted/schema-qualified enum casts**: `stripPostgresCasts` now also handles `'value'::"EnumName"` (user-defined enum types), `'x'::"public"."SurveyStatus"` (schema-qualified, both quoted), and `'x'::pg_catalog.text` (bare schema-qualified). The previous regex only matched bare identifiers like `::text` / `::int4`.
- **9.B — boolean string literals on Boolean fields**: prisma-ast surfaces `@default(false)` as the *string* `"false"` rather than the boolean primitive. The normalizer now promotes `"true"`/`"false"` to a boolean only when `field.type === "Boolean"`, so a literal `@default("false")` on a String field still compares as a string.
- **9.C — JSON whitespace fold**: `defaultsEqual` for `{ kind: "string" }` now JSON-parses both sides when they look like JSON (head character `{` or `[`) and compares structurally. Postgres re-serializes JSON column defaults — `'{"enabled": false}'::jsonb` reports back without the Prisma-side backslash escapes, with collapsed whitespace, etc. Plain string defaults (`'draft'` vs `'pending'`) are unaffected by the quick-reject head check.
- **9.D — keyValue/array Prisma defaults**: `prismaArgToNormalized` for `{ kind: "keyValue" | "array" }` now best-effort-serializes structural defaults (`@default("[]")`, `@default("{}")`) into a JSON string so `defaultsEqual` can fold it against the DB side. Falls back to the previous `<keyValue>` raw placeholder when the structure contains a non-serializable node (function, identifier).

Brings R09d false positives on Postgres projects with enum / JSON / boolean defaults from common-double-digits down toward zero. R01–R05 (static suite), R09, R09b, and R09c are unchanged.
