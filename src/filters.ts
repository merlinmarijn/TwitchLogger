import type { ChatMessage } from "./api";

export type FilterField =
  | "message"
  | "sender"
  | "channel"
  | "role"
  | "badge"
  | "messageType";
export type FilterOperator =
  | "contains"
  | "notContains"
  | "equals"
  | "notEquals"
  | "startsWith"
  | "endsWith"
  | "wholeWord"
  | "has"
  | "notHas";
export type FilterAction = "show" | "hide" | "highlight";
export type FilterMatchMode = "all" | "any";

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

export interface FilterState {
  filters: MessageFilter[];
  activeIds: string[];
}

export interface FilterResult {
  messages: ChatMessage[];
  highlightedIds: Set<string>;
}

export const FILTER_STORAGE_KEY = "twitch-logs.filters.v1";

const fields = new Set<FilterField>([
  "message",
  "sender",
  "channel",
  "role",
  "badge",
  "messageType",
]);
const actions = new Set<FilterAction>(["show", "hide", "highlight"]);
const matchModes = new Set<FilterMatchMode>(["all", "any"]);

export function operatorsForField(field: FilterField): FilterOperator[] {
  if (field === "role" || field === "messageType") return ["equals", "notEquals"];
  if (field === "badge") return ["has", "notHas"];
  return [
    "contains",
    "notContains",
    "equals",
    "notEquals",
    "startsWith",
    "endsWith",
    "wholeWord",
  ];
}

export function matchesMessageFilter(message: ChatMessage, filter: MessageFilter) {
  if (filter.rules.length === 0) return false;
  const matches = filter.rules.map((rule) => matchesRule(message, rule));
  return filter.match === "all" ? matches.every(Boolean) : matches.some(Boolean);
}

export function applyMessageFilters(
  messages: ChatMessage[],
  quickSearch: string,
  activeFilters: MessageFilter[],
): FilterResult {
  const search = normalize(quickSearch);
  const showFilters = activeFilters.filter((filter) => filter.action === "show");
  const hideFilters = activeFilters.filter((filter) => filter.action === "hide");
  const highlightFilters = activeFilters.filter((filter) => filter.action === "highlight");
  const highlightedIds = new Set<string>();

  const visible = messages.filter((message) => {
    if (search && !quickSearchText(message).includes(search)) return false;
    if (!showFilters.every((filter) => matchesMessageFilter(message, filter))) return false;
    if (hideFilters.some((filter) => matchesMessageFilter(message, filter))) return false;
    if (highlightFilters.some((filter) => matchesMessageFilter(message, filter))) {
      highlightedIds.add(message._id);
    }
    return true;
  });

  return { messages: visible, highlightedIds };
}

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

function matchesRule(message: ChatMessage, rule: FilterRule) {
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

function roleMatches(message: ChatMessage, role: string) {
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

function fieldText(message: ChatMessage, field: FilterField) {
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

function quickSearchText(message: ChatMessage) {
  return normalize(
    `${message.messageText} ${message.senderUsername} ${message.senderDisplayName} ${message.channelName}`,
  );
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
  if (!operatorsForField(field).includes(operator) || !value.value.trim()) return [];
  return [{
    id: value.id.slice(0, 100),
    field,
    operator,
    value: value.value.slice(0, 200),
  }];
}

function normalize(value: string) {
  return value.trim().toLocaleLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
