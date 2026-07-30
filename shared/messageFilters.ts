import { extractImageUrls } from "./imageUrls";

export const FILTER_FIELDS = [
  "message",
  "sender",
  "channel",
  "role",
  "badge",
  "messageType",
  "image",
] as const;
export const FILTER_OPERATORS = [
  "contains",
  "notContains",
  "equals",
  "notEquals",
  "startsWith",
  "endsWith",
  "wholeWord",
  "regex",
  "has",
  "notHas",
] as const;
export const FILTER_ACTIONS = ["show", "hide", "highlight"] as const;
export const FILTER_MATCH_MODES = ["all", "any"] as const;
export const FILTER_SCAN_ROW_LIMIT = 1_000;

export type FilterField = (typeof FILTER_FIELDS)[number];
export type FilterOperator = (typeof FILTER_OPERATORS)[number];
export type FilterAction = (typeof FILTER_ACTIONS)[number];
export type FilterMatchMode = (typeof FILTER_MATCH_MODES)[number];

export interface FilterRule {
  id: string;
  field: FilterField;
  operator: FilterOperator;
  value: string;
}

export interface MessageFilter {
  id: string;
  name: string;
  action: FilterAction;
  match: FilterMatchMode;
  rules: FilterRule[];
}

export interface FilterableMessage {
  _id: string;
  externalChannelId: string;
  channelName: string;
  senderUsername: string;
  senderDisplayName: string;
  messageText: string;
  timestamp: number;
  badges: Array<{ setId: string; id: string; info: string }>;
  isBroadcaster: boolean;
  isModerator: boolean;
  isSubscriber: boolean;
  isVip: boolean;
  messageType: string;
  hasImages?: boolean;
}

export interface FilterResult<T extends FilterableMessage> {
  messages: T[];
  highlightedIds: Set<string>;
}

export function operatorsForField(field: FilterField): FilterOperator[] {
  if (field === "role") return ["equals", "notEquals"];
  if (field === "badge" || field === "image") return ["has", "notHas"];
  return [
    "contains",
    "notContains",
    "equals",
    "notEquals",
    "startsWith",
    "endsWith",
    "wholeWord",
    "regex",
  ];
}

export function filterRuleError(rule: FilterRule): string | undefined {
  if (!rule.value.trim()) return "Enter a value.";
  if (rule.operator !== "regex") return undefined;
  return parseRegex(rule.value).error;
}

export function matchesMessageFilter(message: FilterableMessage, filter: MessageFilter) {
  if (filter.rules.length === 0) return true;
  const matches = filter.rules.map((rule) => matchesRule(message, rule));
  return filter.match === "all" ? matches.every(Boolean) : matches.some(Boolean);
}

export function matchesMessageSelection(
  message: FilterableMessage,
  quickSearch: string,
  activeFilters: MessageFilter[],
) {
  const search = normalize(quickSearch);
  if (search && !quickSearchText(message).includes(search)) return false;

  const showFilters = activeFilters.filter((filter) => filter.action === "show");
  const hideFilters = activeFilters.filter((filter) => filter.action === "hide");
  return showFilters.every((filter) => matchesMessageFilter(message, filter)) &&
    !hideFilters.some((filter) => matchesMessageFilter(message, filter));
}

export function highlightedMessageIds(
  messages: FilterableMessage[],
  activeFilters: MessageFilter[],
) {
  const highlightFilters = activeFilters.filter((filter) => filter.action === "highlight");
  return new Set(
    messages
      .filter((message) => highlightFilters.some((filter) => matchesMessageFilter(message, filter)))
      .map((message) => message._id),
  );
}

export function applyMessageFilters<T extends FilterableMessage>(
  messages: T[],
  quickSearch: string,
  activeFilters: MessageFilter[],
): FilterResult<T> {
  const visible = messages.filter((message) =>
    matchesMessageSelection(message, quickSearch, activeFilters),
  );
  return {
    messages: visible,
    highlightedIds: highlightedMessageIds(visible, activeFilters),
  };
}

function matchesRule(message: FilterableMessage, rule: FilterRule) {
  if (rule.operator === "regex") {
    const expression = compileRegex(rule.value);
    return expression?.test(fieldText(message, rule.field)) ?? false;
  }
  const value = normalize(rule.value);
  if (!value) return false;

  if (rule.field === "role") {
    const hasRole = roleMatches(message, value);
    return rule.operator === "notEquals" ? !hasRole : hasRole;
  }
  if (rule.field === "badge") {
    const hasBadge = message.badges.some((badge) =>
      normalize(`${badge.setId}/${badge.id} ${badge.setId} ${badge.id} ${badge.info}`).includes(
        value,
      ),
    );
    return rule.operator === "notHas" ? !hasBadge : hasBadge;
  }
  if (rule.field === "image") {
    const hasImage = message.hasImages ??
      extractImageUrls(message.messageText).length > 0;
    return rule.operator === "notHas" ? !hasImage : hasImage;
  }
  if (rule.field === "sender" &&
      (rule.operator === "equals" || rule.operator === "notEquals")) {
    const matchesSender = normalize(message.senderUsername) === value ||
      normalize(message.senderDisplayName) === value;
    return rule.operator === "notEquals" ? !matchesSender : matchesSender;
  }

  const candidate = normalize(fieldText(message, rule.field));
  switch (rule.operator) {
    case "contains":
      return candidate.includes(value);
    case "notContains":
      return !candidate.includes(value);
    case "equals":
      return candidate === value;
    case "notEquals":
      return candidate !== value;
    case "startsWith":
      return candidate.startsWith(value);
    case "endsWith":
      return candidate.endsWith(value);
    case "wholeWord":
      return new RegExp(
        `(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(value)}(?:$|[^\\p{L}\\p{N}_])`,
        "u",
      ).test(candidate);
    default:
      return false;
  }
}

function roleMatches(message: FilterableMessage, role: string) {
  switch (role) {
    case "broadcaster":
      return message.isBroadcaster;
    case "moderator":
      return message.isModerator;
    case "subscriber":
      return message.isSubscriber;
    case "vip":
      return message.isVip;
    default:
      return false;
  }
}

function fieldText(message: FilterableMessage, field: FilterField) {
  switch (field) {
    case "message":
      return message.messageText;
    case "sender":
      return `${message.senderUsername} ${message.senderDisplayName}`;
    case "channel":
      return message.channelName;
    case "messageType":
      return message.messageType;
    default:
      return "";
  }
}

function quickSearchText(message: FilterableMessage) {
  return normalize(
    `${message.messageText} ${message.senderUsername} ${message.senderDisplayName} ${message.channelName}`,
  );
}

const regexCache = new Map<string, RegExp | null>();

function compileRegex(value: string) {
  if (regexCache.has(value)) return regexCache.get(value) ?? null;
  const parsed = parseRegex(value);
  const expression = parsed.error ? null : new RegExp(parsed.pattern!, parsed.flags);
  regexCache.set(value, expression);
  if (regexCache.size > 100) regexCache.delete(regexCache.keys().next().value!);
  return expression;
}

function parseRegex(value: string): {
  pattern?: string;
  flags?: string;
  error?: string;
} {
  const input = value.trim();
  if (!input) return { error: "Enter a regular expression." };
  if (input.length > 200) return { error: "Regular expressions are limited to 200 characters." };

  let pattern = input;
  let flags = "i";
  if (input.startsWith("/")) {
    const closingSlash = input.lastIndexOf("/");
    if (closingSlash === 0) return { error: "Delimited expressions need a closing /." };
    pattern = input.slice(1, closingSlash);
    flags = input.slice(closingSlash + 1);
    if (!/^[imsu]*$/.test(flags)) return { error: "Supported flags are i, m, s, and u." };
    if (new Set(flags).size !== flags.length) {
      return { error: "Regular-expression flags cannot be repeated." };
    }
  }
  if (!pattern) return { error: "The regular-expression pattern cannot be empty." };
  if (/(?:\([^)]*(?:[+*]|\{\d+,?\d*\})[^)]*\))(?:[+*]|\{\d+,?\d*\})/.test(pattern)) {
    return { error: "Nested repetition is not allowed because it may freeze the feed." };
  }
  try {
    void new RegExp(pattern, flags);
  } catch {
    return { error: "Invalid regular expression." };
  }
  return { pattern, flags };
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
