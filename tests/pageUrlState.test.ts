import { describe, expect, it } from "vitest";
import type { FilterState } from "../src/filters";
import {
  buildPageUrl,
  mergeUrlFilters,
  parsePageUrl,
  type PageUrlState,
} from "../src/pageUrlState";
import { createSmartSearchToken } from "../src/smartSearch";

const sharedFilter = {
  id: "questions",
  name: "Questions",
  action: "highlight" as const,
  match: "any" as const,
  rules: [{
    id: "question-rule",
    field: "message" as const,
    operator: "contains" as const,
    value: "?",
  }],
};

describe("page URL state", () => {
  it("round-trips a channel, tab, searches, active filters, and score controls", () => {
    const state: PageUrlState = {
      channel: "cirno_tv",
      tabId: "score-tab",
      quickSearch: "daily score",
      searchTokens: [createSmartSearchToken("sender", "equals", "alice", "User: Alice")],
      searchMatch: "any",
      filters: [sharedFilter],
      scoreGame: "foodguessr",
      scorePeriod: "week",
    };

    const path = buildPageUrl("https://logs.example/?campaign=summer#feed", state);
    const parsed = parsePageUrl(new URL(path, "https://logs.example").search);

    expect(path).toContain("campaign=summer");
    expect(path.endsWith("#feed")).toBe(true);
    expect(parsed).toEqual(state);
  });

  it("removes stale page markers when returning to the default feed", () => {
    const path = buildPageUrl(
      "https://logs.example/?channel=old&tab=old&q=old&match=any&campaign=summer",
      {
        quickSearch: "",
        searchTokens: [],
        searchMatch: "all",
        filters: [],
      },
    );
    const url = new URL(path, "https://logs.example");

    expect(url.searchParams.get("campaign")).toBe("summer");
    expect(url.searchParams.has("channel")).toBe(false);
    expect(url.searchParams.has("tab")).toBe(false);
    expect(url.searchParams.has("q")).toBe(false);
    expect(url.searchParams.has("match")).toBe(false);
  });

  it("ignores malformed or unsupported URL values", () => {
    const parsed = parsePageUrl(
      "?filters=not-json&tokens=%5B%5B%22id%22%2C%22role%22%2C%22regex%22%2C%22mod%22%5D%5D&game=nope&period=year",
    );

    expect(parsed.filters).toEqual([]);
    expect(parsed.searchTokens).toEqual([]);
    expect(parsed.scoreGame).toBe("rngdle");
    expect(parsed.scorePeriod).toBe("all");
  });

  it("activates shared filter definitions without deleting the local library", () => {
    const saved: FilterState = {
      filters: [{ ...sharedFilter, name: "Old local copy" }, {
        id: "local-only",
        name: "Local only",
        action: "hide",
        match: "all",
        rules: [{
          id: "local-rule",
          field: "message",
          operator: "startsWith",
          value: "!",
        }],
      }],
      activeIds: ["local-only"],
    };

    expect(mergeUrlFilters(saved, [sharedFilter])).toEqual({
      filters: [sharedFilter, saved.filters[1]],
      activeIds: [sharedFilter.id],
    });
  });
});
