/**
 * Resolve a TS identifier referenced in `z.enum(IDENT)` (Zod 4 native-enum
 * shorthand) or `z.nativeEnum(IDENT)` to its enumerated values, when the
 * declaration is local enough that ts-morph can see it.
 *
 * Handles three declaration shapes:
 *
 *   1. `enum X { A, B = "b", ... }`        — TS enum (numeric or string init).
 *   2. `const X = { A: "a", B: "b" } as const` — frozen object literal.
 *   3. `const X = ["a", "b"] as const`         — frozen array literal.
 *
 * For everything else (declarations missing, package-only types like
 * `import { Foo } from "@prisma/client"` whose `.d.ts` isn't parsed,
 * dynamically-typed shapes), the resolver returns `undefined` and lets the
 * caller fall back to a name-match against the Prisma enum registry.
 *
 * Bug #3 (0.8.0) — unblocking R03 on Zod 4 / dub-style projects where 38
 * findings were 97% false-positive before this resolver landed.
 */

import { type Identifier, Node } from "ts-morph";

export interface ResolvedEnumValues {
  values: string[];
  /** Where the values came from — useful for debug messages and tests. */
  source: "ts-enum" | "as-const-object" | "as-const-array";
}

const MAX_ALIAS_HOPS = 16;

export function resolveEnumIdentifier(identifier: Identifier): ResolvedEnumValues | undefined {
  const initial = identifier.getSymbol();
  if (!initial) return undefined;
  let symbol = initial;

  // Walk through `import { X as Y }` aliases the same way the derived-shape
  // resolver does. We're conservative and stop on cycles/self-loops.
  for (let i = 0; i < MAX_ALIAS_HOPS; i++) {
    const aliased = symbol.getAliasedSymbol?.();
    if (!aliased || aliased === symbol) break;
    symbol = aliased;
  }

  const decls = symbol.getDeclarations?.() ?? [];
  for (const decl of decls) {
    const result = readEnumDeclaration(decl);
    if (result) return result;
  }
  return undefined;
}

function readEnumDeclaration(decl: Node): ResolvedEnumValues | undefined {
  if (Node.isEnumDeclaration(decl)) {
    const values: string[] = [];
    for (const member of decl.getMembers()) {
      // Prefer the explicit string initializer (TS string-enum) when present;
      // otherwise fall back to the member name. Prisma enums round-trip
      // through Zod by name, so the name is the right value either way for
      // the resolved-set comparison R03 will run.
      const init = member.getInitializer();
      if (init && Node.isStringLiteral(init)) {
        values.push(init.getLiteralText());
      } else {
        values.push(member.getName());
      }
    }
    return { values, source: "ts-enum" };
  }

  if (Node.isVariableDeclaration(decl)) {
    const initializer = decl.getInitializer();
    if (!initializer) return undefined;

    // `const X = {...} as const`
    if (Node.isAsExpression(initializer)) {
      const inner = initializer.getExpression();
      if (Node.isObjectLiteralExpression(inner)) {
        const values: string[] = [];
        for (const prop of inner.getProperties()) {
          if (!Node.isPropertyAssignment(prop)) continue;
          const propInit = prop.getInitializer();
          if (propInit && Node.isStringLiteral(propInit)) {
            values.push(propInit.getLiteralText());
          } else {
            values.push(prop.getName());
          }
        }
        if (values.length > 0) return { values, source: "as-const-object" };
      }
      if (Node.isArrayLiteralExpression(inner)) {
        const values: string[] = [];
        for (const el of inner.getElements()) {
          if (Node.isStringLiteral(el) || Node.isNoSubstitutionTemplateLiteral(el)) {
            values.push(el.getLiteralText());
          }
        }
        if (values.length > 0) return { values, source: "as-const-array" };
      }
    }
  }

  return undefined;
}
