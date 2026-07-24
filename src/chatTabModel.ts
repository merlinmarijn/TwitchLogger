import {
  parseFilterState,
  type FilterMatchMode,
  type FilterRule,
  type MessageFilter,
} from "./filters";
import { upgradeGalleryFilterPattern } from "../shared/imageUrls";

export interface ChatViewTab {
  id: string;
  name: string;
  layout: "chat" | "gallery" | "scores";
  match: FilterMatchMode;
  rules: FilterRule[];
  revision?: number;
  indexedRevision?: number;
  indexStatus?: "building" | "ready";
}

export const CHAT_TABS_STORAGE_KEY = "twitch-logs.chat-tabs.v1";

export function chatTabAsFilter(tab: ChatViewTab): MessageFilter {
  return {
    id: tab.id,
    name: tab.name,
    action: "show",
    match: tab.match,
    rules: tab.layout === "gallery"
      ? tab.rules.map((rule) => ({ ...rule, value: upgradeGalleryFilterPattern(rule.value) }))
      : tab.rules,
  };
}

export function parseChatTabs(raw: string | null): ChatViewTab[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.tabs)) return [];
    const candidateFilters = parsed.tabs.slice(0, 20).flatMap((value) => {
      if (!isRecord(value)) return [];
      return [{
        id: value.id,
        name: value.name,
        layout: value.layout,
        action: "show",
        match: value.match,
        rules: value.rules,
      }];
    });
    const filters = parseFilterState(JSON.stringify({
      version: 1,
      filters: candidateFilters,
      activeIds: [],
    }), true).filters;
    const seen = new Set<string>();
    return filters.flatMap((filter) => {
      if (seen.has(filter.id)) return [];
      seen.add(filter.id);
      return [{
        id: filter.id,
        name: filter.name,
        layout: parseTabLayout(
          candidateFilters.find((candidate) => candidate.id === filter.id)?.layout,
        ),
        match: filter.match,
        rules: filter.rules,
      }];
    });
  } catch {
    return [];
  }
}

export function serializeChatTabs(tabs: ChatViewTab[]) {
  return JSON.stringify({ version: 1, tabs });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTabLayout(value: unknown): ChatViewTab["layout"] {
  return value === "gallery" || value === "scores" ? value : "chat";
}
