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

    expect(result.sql.join(" ")).toContain("role_flags & 2");
    expect(result.sql.join(" ")).toContain("NOT");
    expect(result.values).toEqual(["!%"]);
    expect(result.requiresPostFilter).toBe(false);
  });

  it("uses resolved dimension keys for fast single-token quick search", () => {
    const result = compileMessageSelectionSql("alice", [], 0, {
      quickSenderProfileIds: [4, 7],
      quickChannelProfileIds: [2],
      senderEquals: {},
    });

    expect(result.sql.join(" ")).toContain("sender_profile_id = ANY");
    expect(result.sql.join(" ")).toContain("channel_profile_id = ANY");
    expect(result.values).toEqual(["%alice%", [4, 7], [2]]);
  });

  it("preserves cross-field semantics for multi-word quick search", () => {
    const result = compileMessageSelectionSql("hello alice", [], 0, {
      quickSenderProfileIds: [],
      quickChannelProfileIds: [],
      senderEquals: {},
    });

    expect(result.sql.join(" ")).toContain("message_text || ' '");
    expect(result.sql.join(" ")).toContain("SELECT username");
  });

  it("compiles exact sender tokens against usernames and display names", () => {
    const result = compileMessageSelectionSql("", [
      makeFilter({
        rules: [{ id: "sender", field: "sender", operator: "equals", value: "Alice" }],
      }),
    ]);

    expect(result.sql.join(" ")).toContain("sender_profile_id IN");
    expect(result.sql.join(" ")).toContain("lower(username)");
    expect(result.sql.join(" ")).toContain("lower(display_name)");
    expect(result.values).toEqual(["alice"]);
    expect(result.requiresPostFilter).toBe(false);
  });

  it("pushes image-link filters into the stored image flag", () => {
    const result = compileMessageSelectionSql("", [
      makeFilter({
        rules: [{ id: "image", field: "image", operator: "has", value: "image" }],
      }),
    ]);

    expect(result.sql).toEqual(["((has_images))"]);
    expect(result.values).toEqual([]);
    expect(result.requiresPostFilter).toBe(false);
  });

  it("pushes any-link filters into a message-text URL match", () => {
    const result = compileMessageSelectionSql("", [
      makeFilter({
        rules: [{ id: "link", field: "link", operator: "has", value: "link" }],
      }),
    ]);

    expect(result.sql.join(" ")).toContain("message_text ~*");
    expect(result.values).toEqual(["https?://[^[:space:]<>\"']+"]);
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
