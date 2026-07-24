import { describe, expect, it } from "vitest";
import type { PostgresDatabase } from "../worker/database";
import type { Logger } from "../worker/logger";
import { PostgresStore } from "../worker/PostgresStore";

function createStore(responses: Array<{ rowCount: number; rows: unknown[] }> = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const database = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return responses.shift() ?? { rowCount: 0, rows: [] };
    },
  } as unknown as PostgresDatabase;
  const logger = { debug: () => undefined } as unknown as Logger;
  return { calls, store: new PostgresStore(database, logger) };
}

describe("PostgreSQL message moderation", () => {
  it("keeps deleted messages as tombstones and excludes them from every page", async () => {
    const { calls, store } = createStore([
      { rowCount: 2, rows: [{ id: "one" }, { id: "two" }] },
      { rowCount: 0, rows: [] },
    ]);

    await expect(store.deleteMessages(["one", "two"])).resolves.toBe(2);
    await store.pageMessages({ paginationOpts: { numItems: 50 } }, false);

    expect(calls[0].text).toContain("SET deleted_at");
    expect(calls[1].text).toContain("deleted_at IS NULL");
  });

  it("removes an image from the visible index and remembers the suppressed URL", async () => {
    const { calls, store } = createStore([
      { rowCount: 1, rows: [{ id: "message" }] },
    ]);

    await expect(store.hideMessageImages([{
      messageId: "message",
      url: "https://example.test/image.png",
    }])).resolves.toBe(1);

    expect(calls[0].text).toContain("hidden_image_urls");
    expect(calls[0].text).toContain("gallery_channel_id");
    expect(calls[0].values).toEqual(["message", "https://example.test/image.png"]);
  });
});

describe("PostgreSQL message pagination", () => {
  it("uses an opaque keyset cursor and fetches only the next page", async () => {
    const { calls, store } = createStore([
      {
        rowCount: 3,
        rows: [
          makeMessageRow("newest", 300),
          makeMessageRow("second", 200),
          makeMessageRow("lookahead", 100),
        ],
      },
      {
        rowCount: 1,
        rows: [makeMessageRow("older", 100)],
      },
    ]);

    const first = await store.pageMessages({ paginationOpts: { numItems: 2 } }, false);
    const second = await store.pageMessages({
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    }, false);

    expect(first.page.map((message) => message._id)).toEqual(["newest", "second"]);
    expect(first.isDone).toBe(false);
    expect(second.page.map((message) => message._id)).toEqual(["older"]);
    expect(calls[0].values.at(-1)).toBe(3);
    expect(calls[1].text).toContain("(timestamp, id) <");
    expect(calls[1].values).toContain(200);
    expect(calls[1].values).toContain("second");
  });

  it("pushes quick search into PostgreSQL before limiting the page", async () => {
    const { calls, store } = createStore([
      { rowCount: 1, rows: [makeMessageRow("match", 100, "Hello Alice")] },
    ]);

    await store.pageMessages({
      quickSearch: "alice",
      paginationOpts: { numItems: 50 },
    }, false);

    expect(calls[0].text).toContain("lower(message_text");
    expect(calls[0].values).toContain("%alice%");
    expect(calls[0].values.at(-1)).toBe(51);
  });
});

function makeMessageRow(id: string, timestamp: number, messageText = "message") {
  return {
    id,
    external_channel_id: "100",
    channel_name: "channel",
    sender_username: "viewer",
    sender_display_name: "Viewer",
    message_text: messageText,
    timestamp: String(timestamp),
    badges: [],
    user_color: null,
    is_broadcaster: false,
    is_moderator: false,
    is_subscriber: false,
    is_vip: false,
    message_type: "text",
    image_urls: null,
    metadata: null,
  };
}
