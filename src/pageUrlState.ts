import type { GameId, ScorePeriod } from "./gameScores";
import {
  parseFilterState,
  type FilterMatchMode,
  type FilterState,
  type MessageFilter,
} from "./filters";
import type { SmartSearchToken } from "./smartSearch";

export interface PageUrlState {
  channel?: string;
  tabId?: string;
  quickSearch: string;
  searchTokens: SmartSearchToken[];
  searchMatch: FilterMatchMode;
  filters: MessageFilter[];
  scoreGame?: GameId;
  scorePeriod?: ScorePeriod;
}

const stateParameterNames = [
  "channel",
  "tab",
  "q",
  "tokens",
  "match",
  "filters",
  "game",
  "period",
] as const;

const games = new Set<GameId>(["rngdle", "foodguessr"]);
const periods = new Set<ScorePeriod>(["day", "week", "month", "all"]);
const MAX_ENCODED_STATE_LENGTH = 50_000;

export function parsePageUrl(search: string): PageUrlState {
  const parameters = new URLSearchParams(search);
  return {
    channel: cleanMarker(parameters.get("channel")),
    tabId: cleanMarker(parameters.get("tab")),
    quickSearch: (parameters.get("q") ?? "").slice(0, 200),
    searchTokens: parseSearchTokens(parameters.get("tokens")),
    searchMatch: parameters.get("match") === "any" ? "any" : "all",
    filters: parseUrlFilters(parameters.get("filters")),
    scoreGame: parseGame(parameters.get("game")),
    scorePeriod: parsePeriod(parameters.get("period")),
  };
}

export function buildPageUrl(currentHref: string, state: PageUrlState) {
  const url = new URL(currentHref);
  for (const name of stateParameterNames) url.searchParams.delete(name);

  if (state.channel) url.searchParams.set("channel", state.channel);
  if (state.tabId && state.tabId !== "all") url.searchParams.set("tab", state.tabId);
  if (state.quickSearch) url.searchParams.set("q", state.quickSearch.slice(0, 200));
  if (state.searchTokens.length > 0) {
    url.searchParams.set("tokens", JSON.stringify(state.searchTokens.map((token) => [
      token.id,
      token.field,
      token.operator,
      token.value,
      token.label,
    ])));
    if (state.searchMatch === "any") url.searchParams.set("match", "any");
  }
  if (state.filters.length > 0) {
    url.searchParams.set("filters", JSON.stringify(state.filters.map((filter) => [
      filter.id,
      filter.name,
      filter.action,
      filter.match,
      filter.rules.map((rule) => [rule.id, rule.field, rule.operator, rule.value]),
    ])));
  }
  if (state.scoreGame) url.searchParams.set("game", state.scoreGame);
  if (state.scorePeriod) url.searchParams.set("period", state.scorePeriod);

  return `${url.pathname}${url.search}${url.hash}`;
}

export function buildRootPageUrl(currentHref: string, state: PageUrlState) {
  const currentUrl = new URL(currentHref);
  const rootUrl = new URL("/", currentUrl.origin);
  rootUrl.hash = currentUrl.hash;
  return buildPageUrl(rootUrl.href, state);
}

export function mergeUrlFilters(saved: FilterState, urlFilters: MessageFilter[]): FilterState {
  const urlById = new Map(urlFilters.map((filter) => [filter.id, filter]));
  const filters = saved.filters.map((filter) => urlById.get(filter.id) ?? filter);
  const savedIds = new Set(filters.map((filter) => filter.id));
  for (const filter of urlFilters) {
    if (!savedIds.has(filter.id)) filters.push(filter);
  }
  return { filters, activeIds: urlFilters.map((filter) => filter.id) };
}

function parseUrlFilters(raw: string | null) {
  const compactFilters = parseCompactArray(raw).flatMap((value) => {
    if (!Array.isArray(value) || value.length < 5 || !Array.isArray(value[4])) return [];
    return [{
      id: value[0],
      name: value[1],
      action: value[2],
      match: value[3],
      rules: value[4].map(compactRule),
    }];
  });
  return parseFilterState(JSON.stringify({
    version: 1,
    filters: compactFilters,
    activeIds: compactFilters.map((filter) => filter.id),
  })).filters;
}

function parseSearchTokens(raw: string | null): SmartSearchToken[] {
  const compactTokens = parseCompactArray(raw).slice(0, 20);
  const candidates = compactTokens.flatMap((value) => {
    if (!Array.isArray(value) || value.length < 4) return [];
    return [{
      id: value[0],
      field: value[1],
      operator: value[2],
      value: value[3],
      label: typeof value[4] === "string" ? value[4].slice(0, 120) : undefined,
    }];
  });
  const parsed = parseFilterState(JSON.stringify({
    version: 1,
    filters: [{
      id: "url-search",
      name: "URL search",
      action: "show",
      match: "all",
      rules: candidates,
    }],
    activeIds: ["url-search"],
  }));
  return (parsed.filters[0]?.rules ?? []).map((rule) => ({
    ...rule,
    label: candidates.find((candidate) => candidate.id === rule.id)?.label ??
      `${rule.field}: ${rule.value}`,
  }));
}

function compactRule(value: unknown) {
  return Array.isArray(value)
    ? { id: value[0], field: value[1], operator: value[2], value: value[3] }
    : value;
}

function parseCompactArray(raw: string | null): unknown[] {
  if (!raw || raw.length > MAX_ENCODED_STATE_LENGTH) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cleanMarker(value: string | null) {
  const marker = value?.trim().slice(0, 100);
  return marker || undefined;
}

function parseGame(value: string | null): GameId {
  return games.has(value as GameId) ? value as GameId : "rngdle";
}

function parsePeriod(value: string | null): ScorePeriod {
  return periods.has(value as ScorePeriod) ? value as ScorePeriod : "all";
}
