import {
  type FilterField,
  type FilterRule,
  type MessageFilter,
} from "../shared/messageFilters";

export const MESSAGE_SEARCH_EXPRESSION = [
  "lower(message_text || ' ' || sender_username || ' ' ||",
  "sender_display_name || ' ' || channel_name)",
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

/**
 * Pushes the parts of message selection that PostgreSQL can evaluate with the
 * same semantics as the shared browser/worker matcher. Unsupported JavaScript
 * regular expressions stay as a bounded post-filter.
 */
export function compileMessageSelectionSql(
  quickSearch: string,
  filters: MessageFilter[],
  parameterOffset = 0,
): MessageSelectionSql {
  const sql: string[] = [];
  const values: unknown[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${parameterOffset + values.length}`;
  };
  const search = normalize(quickSearch);
  if (search) {
    sql.push(`${MESSAGE_SEARCH_EXPRESSION} LIKE ${bind(likeContains(search))} ESCAPE '\\'`);
  }

  let requiresPostFilter = false;
  const selectionFilters = filters.filter((filter) => filter.action !== "highlight");
  for (const filter of selectionFilters) {
    const compiled = compileFilter(filter, bind);
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
): CompiledClause {
  if (filter.rules.length === 0) return { sql: "TRUE", complete: true };
  const rules = filter.rules.map((rule) => compileRule(rule, bind));

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
): CompiledClause {
  if (rule.operator === "regex" || rule.operator === "wholeWord") {
    return { complete: false };
  }
  const value = normalize(rule.value);
  if (!value) return { sql: "FALSE", complete: true };

  if (rule.field === "role") {
    const column = roleColumn(value);
    if (!column) return { sql: "FALSE", complete: true };
    return {
      sql: rule.operator === "notEquals" ? `NOT ${column}` : column,
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
      "EXISTS (",
      "SELECT 1 FROM jsonb_array_elements(COALESCE(badges, '[]'::jsonb)) AS badge",
      `WHERE ${badgeText} LIKE ${bind(likeContains(value))} ESCAPE '\\'`,
      ")",
    ].join(" ");
    return {
      sql: rule.operator === "notHas" ? `NOT (${exists})` : exists,
      complete: true,
    };
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
    case "sender":
      return "lower(sender_username || ' ' || sender_display_name)";
    case "channel":
      return "lower(channel_name)";
    case "messageType":
      return "lower(message_type)";
    default:
      return undefined;
  }
}

function roleColumn(role: string) {
  switch (role) {
    case "broadcaster":
      return "is_broadcaster";
    case "moderator":
      return "is_moderator";
    case "subscriber":
      return "is_subscriber";
    case "vip":
      return "is_vip";
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
