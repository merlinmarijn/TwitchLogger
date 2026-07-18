import {
  FILTER_ACTIONS,
  FILTER_FIELDS,
  FILTER_MATCH_MODES,
  filterRuleError,
  operatorsForField,
  type FilterAction,
  type FilterField,
  type FilterMatchMode,
  type FilterOperator,
  type FilterRule,
  type MessageFilter,
} from "../shared/messageFilters";

export {
  applyMessageFilters,
  FILTER_SCAN_ROW_LIMIT,
  filterRuleError,
  highlightedMessageIds,
  matchesMessageFilter,
  matchesMessageSelection,
  operatorsForField,
  type FilterAction,
  type FilterField,
  type FilterMatchMode,
  type FilterOperator,
  type FilterResult,
  type FilterRule,
  type MessageFilter,
} from "../shared/messageFilters";

export interface FilterState {
  filters: MessageFilter[];
  activeIds: string[];
}

export const FILTER_STORAGE_KEY = "twitch-logs.filters.v1";

const fields = new Set<FilterField>(FILTER_FIELDS);
const actions = new Set<FilterAction>(FILTER_ACTIONS);
const matchModes = new Set<FilterMatchMode>(FILTER_MATCH_MODES);

export function parseFilterState(raw: string | null): FilterState {
  if (!raw) return { filters: [], activeIds: [] };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.filters)) {
      return { filters: [], activeIds: [] };
    }
    const filters = parsed.filters.slice(0, 100).flatMap(parseFilter);
    const validIds = new Set(filters.map((filter) => filter.id));
    const activeIds = Array.isArray(parsed.activeIds)
      ? parsed.activeIds.filter(
          (id): id is string => typeof id === "string" && validIds.has(id),
        )
      : [];
    return { filters, activeIds: [...new Set(activeIds)] };
  } catch {
    return { filters: [], activeIds: [] };
  }
}

export function serializeFilterState(state: FilterState) {
  return JSON.stringify({ version: 1, ...state });
}

function parseFilter(value: unknown): MessageFilter[] {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !actions.has(value.action as FilterAction) ||
    !matchModes.has(value.match as FilterMatchMode) ||
    !Array.isArray(value.rules)
  ) return [];

  const rules = value.rules.slice(0, 20).flatMap(parseRule);
  if (!value.id || !value.name.trim() || rules.length === 0) return [];
  return [{
    id: value.id.slice(0, 100),
    name: value.name.trim().slice(0, 80),
    action: value.action as FilterAction,
    match: value.match as FilterMatchMode,
    rules,
  }];
}

function parseRule(value: unknown): FilterRule[] {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.field !== "string" ||
    !fields.has(value.field as FilterField) ||
    typeof value.operator !== "string" ||
    typeof value.value !== "string"
  ) return [];
  const field = value.field as FilterField;
  const operator = value.operator as FilterOperator;
  if (!operatorsForField(field).includes(operator)) return [];
  const rule = {
    id: value.id.slice(0, 100),
    field,
    operator,
    value: value.value.slice(0, 200),
  };
  return filterRuleError(rule) ? [] : [rule];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
