import { operatorsForField, type FilterField, type FilterRule } from "./filters";

export function createFilterRule(
  field: FilterField,
  id = createClientId("rule"),
): FilterRule {
  const defaults: Partial<Record<FilterField, string>> = {
    role: "moderator",
    messageType: "text",
    image: "image",
  };
  return {
    id,
    field,
    operator: operatorsForField(field)[0],
    value: defaults[field] ?? "",
  };
}

export function createClientId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}
