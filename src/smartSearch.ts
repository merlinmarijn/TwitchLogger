import type {
  FilterField,
  FilterMatchMode,
  FilterOperator,
  MessageFilter,
} from "../shared/messageFilters";
import type { Channel, MessageUserSuggestion } from "./api";

export type SmartSearchSuggestionGroup =
  | "Search"
  | "People"
  | "Channels"
  | "Tags"
  | "Message types";

export interface SmartSearchToken {
  id: string;
  field: FilterField;
  operator: FilterOperator;
  value: string;
  label: string;
}

export interface SmartSearchSuggestion {
  id: string;
  group: SmartSearchSuggestionGroup;
  title: string;
  description: string;
  token: SmartSearchToken;
  excludeToken: SmartSearchToken;
  count?: number;
}

interface BuildSuggestionOptions {
  text: string;
  users: MessageUserSuggestion[];
  channels: Channel[];
}

export function isSmartSearchPending({
  draft,
  editingFilterValue,
  searching,
  value,
}: {
  draft: string;
  editingFilterValue: boolean;
  searching: boolean;
  value: string;
}) {
  return !editingFilterValue && (searching || draft !== value);
}

export const SMART_SEARCH_ROLE_OPTIONS = [
  { value: "broadcaster", label: "Broadcaster" },
  { value: "moderator", label: "Moderator" },
  { value: "subscriber", label: "Subscriber" },
  { value: "vip", label: "VIP" },
] as const;

export const SMART_SEARCH_BADGE_OPTIONS = [
  { value: "broadcaster", label: "Broadcaster badge" },
  { value: "moderator", label: "Moderator badge" },
  { value: "vip", label: "VIP badge" },
  { value: "subscriber", label: "Subscriber badge" },
  { value: "founder", label: "Founder badge" },
  { value: "bits", label: "Bits badge" },
  { value: "sub-gifter", label: "Sub gifter badge" },
  { value: "premium", label: "Prime badge" },
  { value: "turbo", label: "Turbo badge" },
] as const;

export const SMART_SEARCH_MESSAGE_TYPE_OPTIONS = [
  { value: "text", label: "Normal message" },
  { value: "channel_points_highlighted", label: "Channel points highlight" },
  { value: "channel_points_sub_only", label: "Channel points sub-only" },
  { value: "user_intro", label: "First-time chatter" },
  { value: "power_ups_message_effect", label: "Power-up effect" },
  { value: "power_ups_gigantified_emote", label: "Gigantified emote" },
] as const;

export function buildSmartSearchFilter(
  tokens: SmartSearchToken[],
  match: FilterMatchMode,
): MessageFilter | undefined {
  if (tokens.length === 0) return undefined;
  return {
    id: "smart-search",
    name: "Smart search",
    action: "show",
    match,
    rules: tokens.map((token) => ({
      id: token.id,
      field: token.field,
      operator: token.operator,
      value: token.value,
    })),
  };
}

export function buildSmartSearchSuggestions({
  text,
  users,
  channels,
}: BuildSuggestionOptions): SmartSearchSuggestion[] {
  const value = text.trim();
  const normalized = value.toLowerCase();
  if (!normalized) return [];

  const suggestions: SmartSearchSuggestion[] = [
    suggestion(
      "Search",
      "message",
      "contains",
      "notContains",
      value,
      `Message: “${value}”`,
      "Search message text",
      `Message does not contain “${value}”`,
    ),
    suggestion(
      "Search",
      "sender",
      "contains",
      "notContains",
      value,
      `Sender contains “${value}”`,
      "Search usernames and display names",
      `Sender does not contain “${value}”`,
    ),
  ];
  if (["image", "images", "photo", "picture", "gallery"].some((keyword) =>
    keyword.includes(normalized))) {
    suggestions.push(
      suggestion(
        "Tags",
        "image",
        "has",
        "notHas",
        "image",
        "Messages with image links",
        "Supported image links",
        "Messages without image links",
      ),
    );
  }
  if (["link", "links", "url", "urls", "website"].some((keyword) =>
    keyword.includes(normalized))) {
    suggestions.push(
      suggestion(
        "Tags",
        "link",
        "has",
        "notHas",
        "link",
        "Messages with links",
        "Any HTTP or HTTPS link",
        "Messages without links",
      ),
    );
  }

  for (const user of users.slice(0, 5)) {
    suggestions.push({
      id: `user:${user.username.toLowerCase()}`,
      group: "People",
      title: user.displayName,
      description: `@${user.username}`,
      count: user.messageCount,
      token: createSmartSearchToken(
        "sender",
        "equals",
        user.username,
        `User: ${user.displayName}`,
      ),
      excludeToken: createSmartSearchToken(
        "sender",
        "notEquals",
        user.username,
        `Exclude: ${user.displayName}`,
      ),
    });
  }

  for (const channel of channels
    .filter((candidate) =>
      `${candidate.displayName} ${candidate.username}`.toLowerCase().includes(normalized))
    .slice(0, 5)) {
    suggestions.push({
      id: `channel:${channel._id}`,
      group: "Channels",
      title: channel.displayName,
      description: `#${channel.username}`,
      token: createSmartSearchToken(
        "channel",
        "equals",
        channel.displayName,
        `Channel: ${channel.displayName}`,
      ),
      excludeToken: createSmartSearchToken(
        "channel",
        "notEquals",
        channel.displayName,
        `Exclude channel: ${channel.displayName}`,
      ),
    });
  }

  for (const role of SMART_SEARCH_ROLE_OPTIONS.filter((option) =>
    `${option.label} ${option.value}`.toLowerCase().includes(normalized))) {
    suggestions.push({
      id: `role:${role.value}`,
      group: "Tags",
      title: role.label,
      description: "Twitch role",
      token: createSmartSearchToken("role", "equals", role.value, `Role: ${role.label}`),
      excludeToken: createSmartSearchToken(
        "role",
        "notEquals",
        role.value,
        `Not role: ${role.label}`,
      ),
    });
  }

  const matchingBadges = SMART_SEARCH_BADGE_OPTIONS.filter((option) =>
    `${option.label} ${option.value}`.toLowerCase().includes(normalized));
  for (const badge of matchingBadges.slice(0, 4)) {
    suggestions.push({
      id: `badge:${badge.value}`,
      group: "Tags",
      title: badge.label,
      description: "Twitch badge",
      token: createSmartSearchToken("badge", "has", badge.value, `Badge: ${badge.label}`),
      excludeToken: createSmartSearchToken(
        "badge",
        "notHas",
        badge.value,
        `Without badge: ${badge.label}`,
      ),
    });
  }
  if (matchingBadges.length === 0) {
    suggestions.push(
      suggestion(
        "Tags",
        "badge",
        "has",
        "notHas",
        value,
        `Badge: “${value}”`,
        "Match a badge name or value",
        `Without badge “${value}”`,
      ),
    );
  }

  for (const messageType of SMART_SEARCH_MESSAGE_TYPE_OPTIONS.filter((option) =>
    `${option.label} ${option.value}`.toLowerCase().includes(normalized)).slice(0, 4)) {
    suggestions.push({
      id: `message-type:${messageType.value}`,
      group: "Message types",
      title: messageType.label,
      description: "Message type",
      token: createSmartSearchToken(
        "messageType",
        "equals",
        messageType.value,
        `Type: ${messageType.label}`,
      ),
      excludeToken: createSmartSearchToken(
        "messageType",
        "notEquals",
        messageType.value,
        `Not type: ${messageType.label}`,
      ),
    });
  }

  return deduplicateSuggestions(suggestions);
}

export function createSmartSearchToken(
  field: FilterField,
  operator: FilterOperator,
  value: string,
  label: string,
): SmartSearchToken {
  const normalizedValue = value.trim().toLowerCase();
  return {
    id: [
      "smart",
      field,
      operator,
      normalizedValue.slice(0, 32),
      hashText(normalizedValue),
    ].join(":"),
    field,
    operator,
    value: value.trim(),
    label,
  };
}

function suggestion(
  group: SmartSearchSuggestionGroup,
  field: FilterField,
  filterOperator: FilterOperator,
  excludeOperator: FilterOperator,
  value: string,
  title: string,
  description: string,
  excludeLabel: string,
): SmartSearchSuggestion {
  const token = createSmartSearchToken(field, filterOperator, value, title);
  return {
    id: token.id,
    group,
    title,
    description,
    token,
    excludeToken: createSmartSearchToken(field, excludeOperator, value, excludeLabel),
  };
}

function deduplicateSuggestions(suggestions: SmartSearchSuggestion[]) {
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    const key = `${suggestion.token.id}:${suggestion.excludeToken.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hashText(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}
