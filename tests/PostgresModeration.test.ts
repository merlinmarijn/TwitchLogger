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
