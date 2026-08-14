import {
  type FilterField,
  type FilterRule,
  type MessageFilter,
} from "../shared/messageFilters";

export const MESSAGE_SEARCH_EXPRESSION = [
  "(lower(message_text) LIKE __SEARCH__ ESCAPE '\\' OR",
  "sender_profile_id IN (SELECT id FROM chat_sender_profiles WHERE",
  "lower(username || ' ' || display_name) LIKE __SEARCH__ ESCAPE '\\') OR",
  "channel_profile_id IN (SELECT id FROM chat_channel_profiles WHERE",
  "lower(username) LIKE __SEARCH__ ESCAPE '\\'))",
].join(" ");
const BASE_COMBINED_SEARCH_EXPRESSION = [
  "lower(message_text || ' ' ||",
  "(SELECT username FROM chat_sender_profiles WHERE id=sender_profile_id) || ' ' ||",
  "(SELECT display_name FROM chat_sender_profiles WHERE id=sender_profile_id) || ' ' ||",
  "(SELECT username FROM chat_channel_profiles WHERE id=channel_profile_id))",
].join(" ");

interface CompiledClause {
  sql?: string;
  complete: boolean;
}

export interface MessageSelectionSql {
  sql: string[];
  values: unknown[];
  requiresPostFilter: boolean;
  selectionActive: boolean;
}

export interface ResolvedMessageDimensions {
  quickSenderProfileIds: number[];
  quickChannelProfileIds: number[];
  senderEquals: Record<string, number[]>;
}

/**
 * Pushes the parts of message selection that PostgreSQL can evaluate with the
 * same semantics as the shared browser/worker matcher. Unsupported JavaScript
 * regular expressions stay as a bounded post-filter.
 */
export function compileMessageSelectionSql(
  quickSearch: string,
  filters: MessageFilter[],
  parameterOffset = 0,
  resolved?: ResolvedMessageDimensions,
): MessageSelectionSql {
  const sql: string[] = [];
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${parameterOffset + values.length}`;
  };
  const search = normalize(quickSearch);
  if (search) {
    const parameter = bind(likeContains(search));
    if (resolved && !search.includes(" ")) {
      const senderIds = bind(resolved.quickSenderProfileIds);
      const channelIds = bind(resolved.quickChannelProfileIds);
      sql.push(
        `(lower(message_text) LIKE ${parameter} ESCAPE '\\' OR ` +
        `sender_profile_id = ANY(${senderIds}::integer[]) OR ` +
        `channel_profile_id = ANY(${channelIds}::integer[]))`,
      );
    } else if (resolved) {
      sql.push(`${BASE_COMBINED_SEARCH_EXPRESSION} LIKE ${parameter} ESCAPE '\\'`);
    } else {
      sql.push(MESSAGE_SEARCH_EXPRESSION.replaceAll("__SEARCH__", parameter));
    }
  }

  let requiresPostFilter = false;
  const selectionFilters = filters.filter((filter) => filter.action !== "highlight");
  for (const filter of selectionFilters) {
    const compiled = compileFilter(
      filter,
      bind,
      new Map(Object.entries(resolved?.senderEquals ?? {})),
    );
    if (filter.action === "show") {
      if (compiled.sql) sql.push(`(${compiled.sql})`);
      if (!compiled.complete) requiresPostFilter = true;
      continue;
    }
    if (compiled.complete) {
      sql.push(`NOT (${compiled.sql ?? "TRUE"})`);
    } else {
      requiresPostFilter = true;
    }
  }

  return {
    sql,
    values,
    requiresPostFilter,
    selectionActive: Boolean(search) || selectionFilters.length > 0,
  };
}

function compileFilter(
  filter: MessageFilter,
  bind: (value: unknown) => string,
  resolvedSenderIds: Map<string, number[]>,
): CompiledClause {
  if (filter.rules.length === 0) return { sql: "TRUE", complete: true };
  const rules = filter.rules.map((rule) => compileRule(rule, bind, resolvedSenderIds));

  if (filter.match === "any" && rules.some((rule) => !rule.complete)) {
    return { complete: false };
  }

  const supported = rules.flatMap((rule) => rule.sql ? [rule.sql] : []);
  return {
    ...(supported.length > 0
      ? { sql: supported.map((clause) => `(${clause})`).join(
          filter.match === "all" ? " AND " : " OR ",
        ) }
      : {}),
    complete: rules.every((rule) => rule.complete),
  };
}

function compileRule(
  rule: FilterRule,
  bind: (value: unknown) => string,
  resolvedSenderIds: Map<string, number[]>,
): CompiledClause {
  if (rule.operator === "regex" || rule.operator === "wholeWord") {
    return { complete: false };
  }
  const value = normalize(rule.value);
  if (!value) return { sql: "FALSE", complete: true };

  if (rule.field === "role") {
    const bit = roleBit(value);
    if (!bit) return { sql: "FALSE", complete: true };
    const matches = `(role_flags & ${bit}) <> 0`;
    return {
      sql: rule.operator === "notEquals" ? `NOT ${matches}` : matches,
      complete: true,
    };
  }

  if (rule.field === "badge") {
    const badgeText = [
      "lower(",
      "coalesce(badge->>'setId', '') || '/' || coalesce(badge->>'id', '') || ' ' ||",
      "coalesce(badge->>'setId', '') || ' ' || coalesce(badge->>'id', '') || ' ' ||",
      "coalesce(badge->>'info', '')",
      ")",
    ].join(" ");
    const exists = [
      "badge_set_id IN (SELECT badge_set.id FROM chat_badge_sets AS badge_set",
      "CROSS JOIN LATERAL jsonb_array_elements(badge_set.badges) AS badge",
      `WHERE ${badgeText} LIKE ${bind(likeContains(value))} ESCAPE '\\'`,
      ")",
    ].join(" ");
    return {
      sql: rule.operator === "notHas" ? `NOT (${exists})` : exists,
      complete: true,
    };
  }
  if (rule.field === "image") {
    return {
      sql: rule.operator === "notHas" ? "NOT has_images" : "has_images",
      complete: true,
    };
  }
  if (rule.field === "link") {
    const matches = `message_text ~* ${bind("https?://[^[:space:]<>\"']+")}`;
    return {
      sql: rule.operator === "notHas" ? `NOT (${matches})` : matches,
      complete: true,
    };
  }
  if (rule.field === "sender" &&
      (rule.operator === "equals" || rule.operator === "notEquals")) {
    const resolvedIds = resolvedSenderIds.get(value);
    const matches = resolvedIds
      ? `sender_profile_id = ANY(${bind(resolvedIds)}::integer[])`
      : (() => {
          const parameter = bind(value);
          return "sender_profile_id IN (SELECT id FROM chat_sender_profiles WHERE " +
            `(lower(username) = ${parameter} OR lower(display_name) = ${parameter}))`;
        })();
    return {
      sql: rule.operator === "notEquals" ? `NOT (${matches})` : `(${matches})`,
      complete: true,
    };
  }

  const dimension = dimensionField(rule.field);
  if (dimension) {
    const comparison = (operator: string, parameter: string) =>
      `${dimension.key} IN (SELECT id FROM ${dimension.table} WHERE ` +
      `${dimension.expression} ${operator} ${parameter}${operator.includes("LIKE") ? " ESCAPE '\\'" : ""})`;
    switch (rule.operator) {
      case "contains":
        return { sql: comparison("LIKE", bind(likeContains(value))), complete: true };
      case "notContains":
        return { sql: `NOT (${comparison("LIKE", bind(likeContains(value)))})`, complete: true };
      case "equals":
        return { sql: comparison("=", bind(value)), complete: true };
      case "notEquals":
        return { sql: `NOT (${comparison("=", bind(value))})`, complete: true };
      case "startsWith":
        return { sql: comparison("LIKE", bind(`${escapeLike(value)}%`)), complete: true };
      case "endsWith":
        return { sql: comparison("LIKE", bind(`%${escapeLike(value)}`)), complete: true };
      default:
        return { complete: false };
    }
  }

  const field = fieldExpression(rule.field);
  if (!field) return { complete: false };
  switch (rule.operator) {
    case "contains":
      return { sql: `${field} LIKE ${bind(likeContains(value))} ESCAPE '\\'`, complete: true };
    case "notContains":
      return { sql: `${field} NOT LIKE ${bind(likeContains(value))} ESCAPE '\\'`, complete: true };
    case "equals":
      return { sql: `${field} = ${bind(value)}`, complete: true };
    case "notEquals":
      return { sql: `${field} <> ${bind(value)}`, complete: true };
    case "startsWith":
      return { sql: `${field} LIKE ${bind(`${escapeLike(value)}%`)} ESCAPE '\\'`, complete: true };
    case "endsWith":
      return { sql: `${field} LIKE ${bind(`%${escapeLike(value)}`)} ESCAPE '\\'`, complete: true };
    default:
      return { complete: false };
  }
}

function fieldExpression(field: FilterField) {
  switch (field) {
    case "message":
      return "lower(message_text)";
    default:
      return undefined;
  }
}

function dimensionField(field: FilterField) {
  switch (field) {
    case "sender":
      return {
        key: "sender_profile_id",
        table: "chat_sender_profiles",
        expression: "lower(username || ' ' || display_name)",
      };
    case "channel":
      return {
        key: "channel_profile_id",
        table: "chat_channel_profiles",
        expression: "lower(username)",
      };
    case "messageType":
      return {
        key: "message_type_id",
        table: "chat_message_types",
        expression: "lower(name)",
      };
    default:
      return undefined;
  }
}

function roleBit(role: string) {
  switch (role) {
    case "broadcaster":
      return 1;
    case "moderator":
      return 2;
    case "subscriber":
      return 4;
    case "vip":
      return 8;
    default:
      return undefined;
  }
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function likeContains(value: string) {
  return `%${escapeLike(value)}%`;
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}
