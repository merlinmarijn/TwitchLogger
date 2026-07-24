import { describe, expect, it } from "vitest";
import type { MessageFilter } from "../shared/messageFilters";
import { compileMessageSelectionSql } from "../worker/messageSearchSql";

describe("PostgreSQL message selection", () => {
  it("compiles literal substring search for the trigram index", () => {
    const result = compileMessageSelectionSql("  Alice%_  ", [], 2);

    expect(result.sql.join(" ")).toContain("lower(message_text");
    expect(result.sql.join(" ")).toContain("$3");
    expect(result.values).toEqual(["%alice\\%\\_%"]);
    expect(result.requiresPostFilter).toBe(false);
  });

  it("pushes common show and hide filters into SQL", () => {
    const result = compileMessageSelectionSql("", [
      makeFilter({
        action: "show",
        rules: [{ id: "role", field: "role", operator: "equals", value: "moderator" }],
      }),
      makeFilter({
        id: "commands",
        action: "hide",
        rules: [{ id: "command", field: "message", operator: "startsWith", value: "!" }],
      }),
    ]);

    expect(result.sql.join(" ")).toContain("is_moderator");
    expect(result.sql.join(" ")).toContain("NOT");
    expect(result.values).toEqual(["!%"]);
    expect(result.requiresPostFilter).toBe(false);
  });

  it("compiles exact sender tokens against usernames and display names", () => {
    const result = compileMessageSelectionSql("", [
      makeFilter({
        rules: [{ id: "sender", field: "sender", operator: "equals", value: "Alice" }],
      }),
    ]);

    expect(result.sql.join(" ")).toContain("lower(sender_username)");
    expect(result.sql.join(" ")).toContain("lower(sender_display_name)");
    expect(result.values).toEqual(["alice"]);
    expect(result.requiresPostFilter).toBe(false);
  });

  it("keeps JavaScript regular expressions as a bounded post-filter", () => {
    const result = compileMessageSelectionSql("", [
      makeFilter({
        rules: [{ id: "regex", field: "message", operator: "regex", value: "^hello" }],
      }),
    ]);

    expect(result.sql).toEqual([]);
    expect(result.requiresPostFilter).toBe(true);
    expect(result.selectionActive).toBe(true);
  });
});

function makeFilter(overrides: Partial<MessageFilter>): MessageFilter {
  return {
    id: "filter",
    name: "Filter",
    action: "show",
    match: "all",
    rules: [],
    ...overrides,
  };
}
