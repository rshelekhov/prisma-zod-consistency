/**
 * Rule registry. New rules register themselves here so the runner can find them
 * by id without each call site needing to know about every implementation.
 */

import type { Rule, RuleId } from "../types.js";
import { r01 } from "./r01-zod-prisma-drift.js";
import { r02 } from "./r02-onDelete.js";
import { r03 } from "./r03-enum-sync.js";
import { r04 } from "./r04-nullability.js";

const REGISTRY: Map<RuleId, Rule> = new Map([
  [r01.id, r01],
  [r02.id, r02],
  [r03.id, r03],
  [r04.id, r04],
]);

export function getRule(id: RuleId): Rule | undefined {
  return REGISTRY.get(id);
}

export function allRules(): Rule[] {
  return [...REGISTRY.values()];
}
