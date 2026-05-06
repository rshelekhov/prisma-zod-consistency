/**
 * Rule registry. New rules register themselves here so the runner can find them
 * by id without each call site needing to know about every implementation.
 */

import type { Rule, RuleId } from "../types.js";
import { r01 } from "./r01-zod-prisma-drift.js";
import { r02 } from "./r02-onDelete.js";
import { r03 } from "./r03-enum-sync.js";
import { r04 } from "./r04-nullability.js";
import { r05 } from "./r05-validated-bypass.js";
import { r07 } from "./r07-redundant-indexes.js";
import { r08 } from "./r08-unused-indexes.js";
import { r09 } from "./r09-schema-drift-vs-db.js";
import { r09b } from "./r09b-type-drift.js";
import { r09c } from "./r09c-fk-constraints-drift.js";
import { r09d } from "./r09d-default-values-drift.js";

const REGISTRY: Map<RuleId, Rule> = new Map([
  [r01.id, r01],
  [r02.id, r02],
  [r03.id, r03],
  [r04.id, r04],
  [r05.id, r05],
  [r07.id, r07],
  [r08.id, r08],
  [r09.id, r09],
  [r09b.id, r09b],
  [r09c.id, r09c],
  [r09d.id, r09d],
]);

/** Rules that require a live DB snapshot in the project context. */
export const DB_RULES: ReadonlySet<RuleId> = new Set(["R07", "R08", "R09", "R09b", "R09c", "R09d"]);

export function getRule(id: RuleId): Rule | undefined {
  return REGISTRY.get(id);
}

export function allRules(): Rule[] {
  return [...REGISTRY.values()];
}
