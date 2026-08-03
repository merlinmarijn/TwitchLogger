import { ConvexError, v } from "convex/values";
import {
  filterRuleError,
  matchesMessageFilter,
  matchesMessageSelection,
  operatorsForField,
  type FilterableMessage,
  type MessageFilter,
} from "../../shared/messageFilters";

export const filterFieldValidator = v.union(
  v.literal("message"),
  v.literal("sender"),
  v.literal("channel"),
  v.literal("role"),
  v.literal("badge"),
  v.literal("messageType"),
  v.literal("image"),
  v.literal("link"),
);
export const filterOperatorValidator = v.union(
  v.literal("contains"),
  v.literal("notContains"),
  v.literal("equals"),
  v.literal("notEquals"),
  v.literal("startsWith"),
  v.literal("endsWith"),
  v.literal("wholeWord"),
  v.literal("regex"),
  v.literal("has"),
  v.literal("notHas"),
);

export const filterRuleValidator = v.object({
  id: v.string(),
  field: filterFieldValidator,
  operator: filterOperatorValidator,
  value: v.string(),
});

export const messageFilterValidator = v.object({
  id: v.string(),
  name: v.string(),
  action: v.union(v.literal("show"), v.literal("hide"), v.literal("highlight")),
  match: v.union(v.literal("all"), v.literal("any")),
  rules: v.array(filterRuleValidator),
});

export const messageCriteriaValidators = {
  quickSearch: v.optional(v.string()),
  filters: v.optional(v.array(messageFilterValidator)),
  afterTimestamp: v.optional(v.number()),
};

export interface MessageCriteria {
  quickSearch: string;
  filters: MessageFilter[];
  afterTimestamp?: number;
}

export function validateMessageCriteria(args: {
  quickSearch?: string;
  filters?: MessageFilter[];
  afterTimestamp?: number;
}): MessageCriteria {
  const quickSearch = args.quickSearch?.trim() ?? "";
  if (quickSearch.length > 200) throw new ConvexError("Search text is limited to 200 characters");
  if ((args.filters?.length ?? 0) > 100) throw new ConvexError("Too many message filters");
  if (args.afterTimestamp !== undefined &&
      (!Number.isFinite(args.afterTimestamp) || args.afterTimestamp < 0)) {
    throw new ConvexError("Invalid message timestamp cutoff");
  }

  const filters = (args.filters ?? []).map((filter) => {
    if (filter.id.length > 100 || filter.name.length > 80 || filter.rules.length > 20) {
      throw new ConvexError("Message filter exceeds its size limit");
    }
    for (const rule of filter.rules) {
      if (rule.id.length > 100 || rule.value.length > 200 ||
          !operatorsForField(rule.field).includes(rule.operator) || filterRuleError(rule)) {
        throw new ConvexError("Message filter contains an invalid rule");
      }
    }
    return filter;
  });

  return {
    quickSearch,
    filters,
    ...(args.afterTimestamp && args.afterTimestamp > 0
      ? { afterTimestamp: args.afterTimestamp }
      : {}),
  };
}

export function validateMessagePageSize(numItems: number) {
  if (!Number.isInteger(numItems) || numItems < 1 || numItems > 250) {
    throw new ConvexError("Message pages are limited to 250 items");
  }
}

export function hasMessageSelection(criteria: MessageCriteria) {
  return Boolean(criteria.quickSearch) ||
    criteria.filters.some((filter) => filter.action !== "highlight");
}

export function matchesCriteria(message: FilterableMessage, criteria: MessageCriteria) {
  return matchesMessageSelection(message, criteria.quickSearch, criteria.filters);
}

export function countFilterMatches(
  messages: FilterableMessage[],
  filters: MessageFilter[],
) {
  return filters.map((filter) => ({
    id: filter.id,
    count: messages.filter((message) => matchesMessageFilter(message, filter)).length,
  }));
}
