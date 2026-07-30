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
  count?: number;
}

interface BuildSuggestionOptions {
  text: string;
  users: MessageUserSuggestion[];
  channels: Channel[];
}

const roleOptions = [
  { value: "broadcaster", label: "Broadcaster" },
  { value: "moderator", label: "Moderator" },
  { value: "subscriber", label: "Subscriber" },
  { value: "vip", label: "VIP" },
] as const;

const badgeOptions = [
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

const messageTypeOptions = [
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
    suggestion("Search", "message", "contains", value, `Message: “${value}”`, "Search message text"),
    suggestion("Search", "message", "notContains", value, `Message does not contain “${value}”`, "Exclude matching message text"),
    suggestion("Search", "sender", "contains", value, `Sender contains “${value}”`, "Search usernames and display names"),
    suggestion("Search", "sender", "notContains", value, `Sender does not contain “${value}”`, "Exclude matching usernames and display names"),
  ];
  if (["image", "images", "photo", "picture", "gallery"].some((keyword) =>
    keyword.includes(normalized))) {
    suggestions.push(
      suggestion(
        "Tags",
        "image",
        "has",
        "image",
        "Messages with image links",
        "Supported image links",
      ),
      suggestion(
        "Tags",
        "image",
        "notHas",
        "image",
        "Messages without image links",
        "Exclude supported image links",
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
    });
    suggestions.push({
      id: `user-exclude:${user.username.toLowerCase()}`,
      group: "People",
      title: `Exclude ${user.displayName}`,
      description: `@${user.username} · Exclude this person`,
      token: createSmartSearchToken(
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
    });
    suggestions.push({
      id: `channel-exclude:${channel._id}`,
      group: "Channels",
      title: `Exclude ${channel.displayName}`,
      description: `#${channel.username}`,
      token: createSmartSearchToken(
        "channel",
        "notEquals",
        channel.displayName,
        `Exclude channel: ${channel.displayName}`,
      ),
    });
  }

  for (const role of roleOptions.filter((option) =>
    `${option.label} ${option.value}`.toLowerCase().includes(normalized))) {
    suggestions.push({
      id: `role:${role.value}`,
      group: "Tags",
      title: role.label,
      description: "Twitch role",
      token: createSmartSearchToken("role", "equals", role.value, `Role: ${role.label}`),
    });
    suggestions.push({
      id: `role-exclude:${role.value}`,
      group: "Tags",
      title: `Not ${role.label}`,
      description: "Exclude this Twitch role",
      token: createSmartSearchToken(
        "role",
        "notEquals",
        role.value,
        `Not role: ${role.label}`,
      ),
    });
  }

  const matchingBadges = badgeOptions.filter((option) =>
    `${option.label} ${option.value}`.toLowerCase().includes(normalized));
  for (const badge of matchingBadges.slice(0, 4)) {
    suggestions.push({
      id: `badge:${badge.value}`,
      group: "Tags",
      title: badge.label,
      description: "Twitch badge",
      token: createSmartSearchToken("badge", "has", badge.value, `Badge: ${badge.label}`),
    });
    suggestions.push({
      id: `badge-exclude:${badge.value}`,
      group: "Tags",
      title: `Without ${badge.label}`,
      description: "Exclude this Twitch badge",
      token: createSmartSearchToken(
        "badge",
        "notHas",
        badge.value,
        `Without badge: ${badge.label}`,
      ),
    });
  }
  if (matchingBadges.length === 0) {
    suggestions.push(
      suggestion("Tags", "badge", "has", value, `Badge: “${value}”`, "Match a badge name or value"),
      suggestion("Tags", "badge", "notHas", value, `Without badge “${value}”`, "Exclude a badge name or value"),
    );
  }

  for (const messageType of messageTypeOptions.filter((option) =>
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
    });
    suggestions.push({
      id: `message-type-exclude:${messageType.value}`,
      group: "Message types",
      title: `Not ${messageType.label}`,
      description: "Exclude this message type",
      token: createSmartSearchToken(
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
  operator: FilterOperator,
  value: string,
  title: string,
  description: string,
): SmartSearchSuggestion {
  const token = createSmartSearchToken(field, operator, value, title);
  return { id: token.id, group, title, description, token };
}

function deduplicateSuggestions(suggestions: SmartSearchSuggestion[]) {
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    const key = suggestion.token.id;
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
