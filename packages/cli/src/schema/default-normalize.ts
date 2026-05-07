/**
 * Normalize default-value expressions on both Prisma and DB sides so R09d
 * can compare them without bouncing on cosmetic differences.
 *
 * Approach (Variant A + Variant C from the design discussion):
 *   - **Variant A — ad-hoc normalization** for the common cases:
 *     strip Postgres `::type` casts, strip outer quotes from string literals,
 *     numerically compare numbers (`42` ↔ `42.0`), fold boolean spellings
 *     (`true` / `1` / `'t'`), and canonicalize the `now()` family of clock
 *     defaults (`now()` / `CURRENT_TIMESTAMP` / `current_timestamp(3)` etc.).
 *
 *   - **Variant C — explicit skip-list** for defaults whose semantics we
 *     can't reliably compare:
 *       - Prisma side: `cuid()`, `uuid()`, `autoincrement()`, `dbgenerated(...)`.
 *       - DB side: `nextval(...)`, `gen_random_uuid()`, plus passthrough
 *         `dbgenerated`-style expressions a user explicitly opted into.
 *     When either side normalizes to `{ kind: "skip" }`, R09d does not emit
 *     a finding — these are intentional non-deterministic / generated
 *     defaults where shape comparison would only produce noise.
 *
 * Anything outside the well-known cases falls into `{ kind: "raw", value }`,
 * which compares by trimmed-string equality. That gives us a sane fallback
 * for `dbgenerated("custom expression")` style usage without trying to parse.
 *
 * If you need to extend coverage, add a case to `normalizePrismaDefault` /
 * `normalizeDbDefault` and a unit test in `default-normalize.test.ts`.
 */

import type { AttributeArg, AttributeArgValue, FieldInfo } from "./prisma-models.js";

/**
 * Normalized representation of a default value, used as the comparison
 * vocabulary between Prisma and DB sides.
 */
export type NormalizedDefault =
  | { kind: "absent" }
  | { kind: "skip" }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "now" }
  | { kind: "raw"; value: string };

/**
 * Normalize a Prisma `@default(...)` attribute on a field.
 *
 * Returns:
 *   - `{ kind: "absent" }` when the field has no `@default(...)`.
 *   - `{ kind: "skip" }` for client-side / generated defaults
 *     (`cuid()`, `uuid()`, `autoincrement()`, `dbgenerated(...)`).
 *   - The corresponding scalar kind for literals (`"draft"` → string,
 *     `42` → number, `true` → boolean).
 *   - `{ kind: "now" }` for `now()`.
 */
export function normalizePrismaDefault(field: FieldInfo): NormalizedDefault {
  const attr = field.attributes.find((a) => a.name === "default");
  if (!attr || attr.args.length === 0) return { kind: "absent" };

  const arg = attr.args[0]!;
  return prismaArgToNormalized(arg, field.type);
}

/**
 * @param fieldType  Prisma scalar type as written in the schema (e.g. "Boolean",
 *                   "Json"). Used to disambiguate string literals on Boolean
 *                   fields (Bug #9.B — prisma-ast can emit `@default(false)` as
 *                   the *string* `"false"` rather than the boolean `false`) and
 *                   to JSON-fold structural defaults on Json fields (Bug #9.D).
 */
function prismaArgToNormalized(arg: AttributeArg, fieldType?: string): NormalizedDefault {
  switch (arg.kind) {
    case "literal": {
      if (typeof arg.value === "string") {
        // Bug #9.B — prisma-ast surfaces `@default(true)` / `@default(false)`
        // as the *string* `"true"` / `"false"` (not the boolean primitive).
        // Promote them on Boolean-typed fields so they compare against the
        // DB's bare `true`/`false` correctly. Type-gated to avoid corrupting
        // a literal `@default("false")` on a String field.
        if (fieldType === "Boolean" && (arg.value === "true" || arg.value === "false")) {
          return { kind: "boolean", value: arg.value === "true" };
        }
        return { kind: "string", value: arg.value };
      }
      if (typeof arg.value === "number") return { kind: "number", value: arg.value };
      if (typeof arg.value === "boolean") return { kind: "boolean", value: arg.value };
      return { kind: "raw", value: String(arg.value) };
    }
    case "function": {
      // Normalize Prisma's function-call defaults. The `now()` clock default
      // is the only one we compare; the rest are deliberate skips.
      if (arg.name === "now") return { kind: "now" };
      if (arg.name === "cuid" || arg.name === "uuid" || arg.name === "autoincrement") {
        return { kind: "skip" };
      }
      if (arg.name === "dbgenerated") return { kind: "skip" };
      return { kind: "raw", value: `${arg.name}()` };
    }
    case "keyValue":
    case "array": {
      // Bug #9.D — `@default("[]")` / `@default("{}")` on Json columns is
      // sometimes emitted by prisma-ast as a structural keyValue/array node
      // rather than a string literal. Try to round-trip it through JSON so
      // `defaultsEqual`'s string branch can JSON-fold it against the DB
      // side (`'[]'::jsonb` etc.). Falls back to the previous
      // `<keyValue>` placeholder when the structure can't be serialized.
      const json = tryArgToJson(arg);
      if (json !== undefined) return { kind: "string", value: JSON.stringify(json) };
      return { kind: "raw", value: "<keyValue>" };
    }
    case "unknown":
      return { kind: "raw", value: "<unknown>" };
  }
}

/**
 * Best-effort conversion of a Prisma `AttributeArg` / `AttributeArgValue` tree
 * into a plain JS value suitable for `JSON.stringify`. Used by Bug #9.D to
 * salvage structural Json defaults that survive `prisma-ast` parsing as
 * `keyValue` / `array` nodes.
 *
 * Returns `undefined` for any node we can't faithfully represent (functions,
 * identifiers, unknowns) so the caller can fall back to the raw placeholder.
 */
function tryArgToJson(arg: AttributeArg): unknown | undefined {
  switch (arg.kind) {
    case "literal":
      return arg.value;
    case "array": {
      const out: unknown[] = [];
      for (const v of arg.values) {
        const converted = argValueToJson(v);
        if (converted === undefined) return undefined;
        out.push(converted);
      }
      return out;
    }
    case "keyValue": {
      const inner = argValueToJson(arg.value);
      if (inner === undefined) return undefined;
      return { [arg.key]: inner };
    }
    default:
      return undefined;
  }
}

function argValueToJson(value: AttributeArgValue): unknown | undefined {
  switch (value.kind) {
    case "literal":
      return value.value;
    case "array": {
      const out: unknown[] = [];
      for (const v of value.values) {
        const converted = argValueToJson(v);
        if (converted === undefined) return undefined;
        out.push(converted);
      }
      return out;
    }
    case "function":
    case "identifier":
    case "unknown":
      return undefined;
  }
}

/**
 * Normalize the raw `column_default` string the database reports for a column.
 *
 * `null` → `{ kind: "absent" }`.
 *
 * Per-provider behavior:
 *   - Postgres: strips `::type` casts before further parsing
 *     (`'draft'::text` → `'draft'`, `42::int4` → `42`); folds
 *     `'t'/'f'`, `true/false`, `1/0` into booleans where the surrounding
 *     context allows.
 *   - MySQL: literals come without explicit casts; `1`/`0` are mapped to
 *     boolean only when it's safe (we conservatively treat them as numbers
 *     unless explicitly tagged — the R09d rule still won't false-positive
 *     because the Prisma side will normalize `Boolean true` → `boolean true`
 *     and a number `1` won't compare equal, prompting the user to disambiguate).
 *   - SQLite: `dflt_value` is the literal expression as written, including
 *     the surrounding quotes.
 *
 * Skip cases:
 *   - `nextval(...)` → `{ kind: "skip" }` (sequence-driven autoincrement).
 *   - `gen_random_uuid()` / `uuid_generate_v4()` → `{ kind: "skip" }`.
 *   - Anything whose normalized form starts with `nextval` after cast strip.
 */
export function normalizeDbDefault(raw: string | null): NormalizedDefault {
  if (raw === null) return { kind: "absent" };
  let s = raw.trim();
  if (s === "") return { kind: "absent" };

  // Strip Postgres-style `expr::type` casts. Walk from the end because the
  // cast trails the value (`'draft'::text`, `42::int4`, `now()::timestamp`).
  s = stripPostgresCasts(s);

  // Skip-list: sequence and provider-side UUID generators.
  if (/^nextval\s*\(/i.test(s)) return { kind: "skip" };
  if (/^gen_random_uuid\s*\(\s*\)$/i.test(s)) return { kind: "skip" };
  if (/^uuid_generate_v4\s*\(\s*\)$/i.test(s)) return { kind: "skip" };

  // `now()` family — Postgres / MySQL / SQLite all express the clock default
  // differently. Fold them onto a single canonical token.
  if (/^now\s*\(\s*\)$/i.test(s)) return { kind: "now" };
  if (/^current_timestamp\s*(\(\s*\d*\s*\))?$/i.test(s)) return { kind: "now" };

  // Boolean: canonical Postgres spelling `true` / `false`, plus the legacy
  // single-letter form ('t' / 'f') that older Postgres versions surfaced.
  if (s.toLowerCase() === "true" || s === "'t'" || s === "'true'") {
    return { kind: "boolean", value: true };
  }
  if (s.toLowerCase() === "false" || s === "'f'" || s === "'false'") {
    return { kind: "boolean", value: false };
  }

  // String literal — outer single-quoted form, with internal `''` unescaping.
  const stringMatch = /^'((?:[^']|'')*)'$/.exec(s);
  if (stringMatch) {
    return { kind: "string", value: stringMatch[1]!.replace(/''/g, "'") };
  }

  // Number — integer or float, signed or unsigned.
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    return { kind: "number", value: Number.parseFloat(s) };
  }

  // Anything else — passthrough as raw, compared by string equality.
  return { kind: "raw", value: s };
}

/**
 * Strip a single trailing Postgres cast (`::type`) if present.
 *
 * Recognizes:
 *   - bare identifiers:        `'draft'::text`, `42::int4`, `now()::timestamp`
 *   - precision modifiers:     `now()::timestamp(3)`
 *   - quoted identifiers:      `'user'::"WebhookSource"` (user-defined enums)
 *   - schema-qualified:        `'draft'::"public"."SurveyStatus"`,
 *                              `'x'::pg_catalog.text`
 *
 * We anchor at end-of-string and don't recurse — Postgres can technically
 * chain casts, but in practice `column_default` carries one trailing cast at
 * most. Keeping this conservative avoids accidentally eating literal text
 * (e.g. an embedded `'foo::bar'` inside single quotes is left alone because
 * the regex requires the cast at the very end of the input).
 */
function stripPostgresCasts(s: string): string {
  // Bug #9.A: support quoted/schema-qualified type names alongside the bare
  // identifier form. A type segment is one of:
  //   - quoted, optionally schema-qualified:  `"WebhookSource"`,
  //                                           `"public"."SurveyStatus"`
  //   - bare, optionally schema-qualified:    `text`, `pg_catalog.text`
  //   - bare with multi-word suffix:          `character varying`,
  //                                           `double precision`,
  //                                           `time with time zone`
  // optionally followed by a `(precision)` tail.
  const m =
    /::(?:"[^"]+"(?:\.(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*))?|[a-zA-Z_][a-zA-Z0-9_]*(?:\.(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*))?(?:\s+[a-zA-Z_][a-zA-Z0-9_]*)*)(?:\s*\(\s*\d*\s*\))?$/.exec(
      s,
    );
  if (!m) return s;
  return s.slice(0, m.index).trim();
}

/**
 * Compare two normalized defaults. Returns `true` when they're equivalent.
 *
 * Special cases:
 *   - `skip` on either side: returns `true` (we deliberately don't flag).
 *   - `absent` on both sides: `true`.
 *   - `absent` vs concrete kind: `false` (real drift — Prisma declared a
 *     default the DB doesn't have, or vice versa).
 *   - `number` ↔ `number`: numeric equality (so `42` and `42.0` match).
 *   - `string` / `boolean` / `now` / `raw`: per-kind equality on `value`.
 *   - Mismatched kinds: `false`.
 */
export function defaultsEqual(a: NormalizedDefault, b: NormalizedDefault): boolean {
  if (a.kind === "skip" || b.kind === "skip") return true;
  if (a.kind === "absent" && b.kind === "absent") return true;
  if (a.kind === "absent" || b.kind === "absent") return false;
  if (a.kind !== b.kind) return false;

  switch (a.kind) {
    case "string": {
      const av = a.value;
      const bv = (b as Extract<NormalizedDefault, { kind: "string" }>).value;
      if (av === bv) return true;
      // Bug #9.C — Postgres re-serializes JSON column defaults (collapsing or
      // inserting whitespace, normalizing key quoting), so what Prisma writes
      // (`'{"enabled": false}'` after Prisma-side string unescape) and what
      // the DB reports (`'{"enabled":false}'`) compare unequal as raw strings
      // even though the JSON value is identical. If both sides parse as JSON,
      // compare the parsed values structurally.
      const ajson = tryParseJson(av);
      const bjson = tryParseJson(bv);
      if (ajson !== undefined && bjson !== undefined) {
        return JSON.stringify(ajson) === JSON.stringify(bjson);
      }
      return false;
    }
    case "number":
      return a.value === (b as Extract<NormalizedDefault, { kind: "number" }>).value;
    case "boolean":
      return a.value === (b as Extract<NormalizedDefault, { kind: "boolean" }>).value;
    case "now":
      return true;
    case "raw":
      return a.value === (b as Extract<NormalizedDefault, { kind: "raw" }>).value;
    default:
      return false;
  }
}

/**
 * Try to parse a string as JSON. Returns the parsed value, or `undefined`
 * when the string isn't syntactically valid JSON.
 *
 * Used by Bug #9.C JSON-fold in `defaultsEqual`. We additionally collapse a
 * pair of common Prisma-side escapes (`\"` → `"`, `\\` → `\`) before parsing
 * because `@default("{\"a\":1}")` arrives here with literal backslash-quote
 * sequences that `JSON.parse` would otherwise reject.
 */
function tryParseJson(s: string): unknown | undefined {
  // Quick reject: real JSON values start with one of these characters after
  // any whitespace. This keeps us from JSON-parsing arbitrary string defaults
  // like `'draft'` or `'2024-01-01'` which would otherwise round-trip as
  // strings and pretend to be equal.
  const head = s.trimStart();
  if (head.length === 0) return undefined;
  const first = head[0]!;
  if (!"{[".includes(first)) return undefined;

  try {
    return JSON.parse(s);
  } catch {
    // Try once more with Prisma-side escapes unwrapped.
    try {
      return JSON.parse(s.replace(/\\(.)/g, "$1"));
    } catch {
      return undefined;
    }
  }
}

/**
 * Render a normalized default back to a short human-readable string, for use
 * in finding messages. The output is descriptive, not round-trippable.
 */
export function describeNormalized(d: NormalizedDefault): string {
  switch (d.kind) {
    case "absent":
      return "<no default>";
    case "skip":
      return "<generated, skipped>";
    case "string":
      return `'${d.value}'`;
    case "number":
      return String(d.value);
    case "boolean":
      return d.value ? "true" : "false";
    case "now":
      return "now()";
    case "raw":
      return d.value;
  }
}
